#!/usr/bin/env ts-node

import SwaggerParser from '@apidevtools/swagger-parser';
import { isType, printValue } from '@skunkteam/types';
import assert from 'assert';
import chalk from 'chalk';
import { constants, promises } from 'fs';
import { dump } from 'js-yaml';
import type { OpenAPI, OpenAPIV3 } from 'openapi-types';
import pMap from 'p-map';
import path from 'path';
import { generateSchemas, TypeDefs } from './openapi-definitions-generator';

const [, , OPENAPI_FILE] = process.argv;
if (!OPENAPI_FILE) {
    console.log(chalk.redBright('Supply path to openapi yaml file as first argument'));
    process.exit(1);
}

const CONCURRENCY = 10;

(async () => {
    await promises.access(OPENAPI_FILE, constants.R_OK);
    const files = await findSpecFiles(OPENAPI_FILE);

    // for each referenced openapi file, decide if it contains `x-skunkteam-type` annotations
    // first collect all changes, so we can throw any errors before we start replacing files on disk
    const pendingWrites = await pMap(files, processFile, { concurrency: CONCURRENCY });

    // safe to write all files now that we know we could process all yaml's
    await pMap(pendingWrites.flat(), writeFile, { concurrency: CONCURRENCY });
})().catch(e => {
    console.log(chalk.redBright(String(e)));
    process.exit(1);
});

/**
 * returns the absolute path to the given openapi yaml file, as well as the absolute paths to all the openapi yaml files that are
 * (indirectly) references using $ref. Does not include externally referenced files over http
 */
async function findSpecFiles(main: string) {
    const parser = new SwaggerParser();
    // dereferences all external paths, so we discover all (nested) references to other openapi files
    await parser.dereference(main);
    return parser.$refs.paths('file');
}

type WritableFile = { file: string; contents: OpenAPIV3.Document };

async function processFile(file: string): Promise<Array<WritableFile>> {
    // only parse (do not resolve) as we need to reconstruct original yaml as much as possible
    const api = await new SwaggerParser().parse(file);
    assert(isOpenAPIV3(api), 'only supports OpenAPI v3.0');
    const types: TypeDefs = {}; // where `processTypeAnnotation` is going to collect all x-skunkteam-type's it encounters
    await processTypeAnnotation(api); // recursive processing of all elements in openapi yaml

    if (!Object.keys(types).length) {
        return []; // no x-skunkteam-types found, no need to (re)write files
    }
    console.log(chalk.gray(`found ${Object.keys(types).length} schemas in ${file}`));
    return [
        {
            file,
            contents: api,
        },
        {
            file: typesFileExtension(file),
            contents: {
                openapi: '3.0.0',
                info: { ...api.info, title: `Types for ${api.info.title}` },
                paths: {},
                ...generateSchemas('components/schemas', types),
            },
        },
    ];

    // Process a node in an openapi yaml (and recurse into the children of the node).
    // Collect any type references that are found (having x-skunkteam-types annotation)
    async function processTypeAnnotation(object: unknown) {
        if (Array.isArray(object)) {
            // recurse into array elements
            await Promise.all(object.map(processTypeAnnotation));
        } else if (typeof object === 'object' && !!object) {
            // recurse into all properties of an object
            await Promise.all(Object.values(object).map(processTypeAnnotation));
            // and see if the object has a x-skunkteam-type annotation. If so, collect the type
            if (hasProperty(object, 'x-skunkteam-type') && typeof object['x-skunkteam-type'] === 'string') {
                const [libName, typeName] = object['x-skunkteam-type'].split('#');
                assert(libName);
                assert(typeName, 'x-skunkteam-type annotation should be in format <module>#<type>, for example ./foo.ts#User');
                const lib = await import(libName).catch(e => {
                    console.log(chalk.redBright(`Could not load lib: ${libName} (check your ts-node version)`));
                    console.error(e);
                    process.exit(1);
                });
                const type = lib[typeName];
                assert(isType(type), `Library ${libName} does not export a type with name ${typeName}, got: ${printValue(type)}`);
                if (types[typeName] && types[typeName] !== type) {
                    throw new Error(`duplicate types named "${typeName}"`);
                }
                // remember the found type, so we can convert them all to openapi schema definitions
                types[typeName] = type;
                // add a $ref to the object in the openapi spec so it references the (to be) generated openapi schema
                (object as any)['$ref'] = `./${typesFileExtension(path.basename(file))}#/components/schemas/${typeName}`;
            }
        }
    }
}

async function writeFile({ file, contents }: WritableFile) {
    console.log(file, contents);
    const yaml = dump(contents, { noRefs: true, lineWidth: 140 });
    await promises.writeFile(file, yaml, 'utf8');
    console.log(chalk.greenBright(`wrote ${file}`));
}

function isOpenAPIV3(doc: OpenAPI.Document): doc is OpenAPIV3.Document {
    return 'openapi' in doc && (doc.openapi === '3.0' || doc.openapi.startsWith('3.0.'));
}

function typesFileExtension(filename: string) {
    return filename.replace(/\.yaml$/, '.types.yaml').replace(/\.yml$/, '.types.yml');
}

function hasProperty<T, P extends PropertyKey>(obj: T, key: P): obj is T & Record<P, unknown> {
    return typeof obj === 'object' && obj && key in obj;
}
