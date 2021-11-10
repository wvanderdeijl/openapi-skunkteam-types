import {
    ArrayType,
    BaseObjectLikeTypeImpl,
    BaseTypeImpl,
    KeyofType,
    LiteralType,
    LiteralValue,
    NumberTypeConfig,
    OneOrMore,
    RecordType,
    StringTypeConfig,
    Type,
    UnionType,
    Visitor,
} from '@skunkteam/types';
import assert from 'assert';
import chalk from 'chalk';
import { mapValues, set } from 'lodash';
import { OpenAPIV3 } from 'openapi-types';
import { inspect } from 'util';
import { OPENAPI_METADATA } from './metadata';

export type Schemas = Record<string, OpenAPIV3.SchemaObject>;
export type TypeDefs = Partial<Record<string, Type<unknown>>>;

// additional openapi metadata might have been attached to any skunkteam/type
type AnnotatedType = {
    [OPENAPI_METADATA]?: {
        metadata?: Record<string, unknown>;
        properties?: Record<string, Record<string, unknown>>;
    };
};

export function generateSchemas(basePath: string, types: TypeDefs) {
    const SEP = /[./]/g;
    const visitor = new OpenApiDefinitionsGenerator(['#', ...basePath.split(SEP).filter(Boolean)].join('/'), types);
    visitor.processTypes();
    const { schemas } = visitor;
    return basePath ? set({}, basePath.replace(SEP, '.'), schemas) : schemas;
}

/**
   Implementation of the "visitor pattern" to convert skunkteam/types to OpenAPI schemas
*/
class OpenApiDefinitionsGenerator implements Visitor<OpenAPIV3.SchemaObject> {
    readonly schemas: Schemas = {};
    private readonly topLevelTypes = new Map<BaseTypeImpl<unknown>, string>();
    private readonly typeStack: BaseTypeImpl<unknown>[] = [];
    private readonly availableDefinitions = new Map<BaseTypeImpl<unknown>, OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>();

    constructor(private readonly basePath: string, topLevelTypes: TypeDefs) {
        Object.entries(topLevelTypes).forEach(([name, type]) => type && this.topLevelTypes.set(type, name));
    }

    visitArrayType(type: ArrayType<BaseTypeImpl<unknown>, unknown, unknown[]>): OpenAPIV3.SchemaObject {
        const { maxLength, minLength } = type.typeConfig;
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'array',
            items: this.processType(type.elementType),
            minItems: minLength,
            maxItems: maxLength,
        });
    }

    visitBooleanType(type: BaseTypeImpl<unknown>): OpenAPIV3.SchemaObject {
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'boolean',
        });
    }

    visitObjectLikeType(type: BaseObjectLikeTypeImpl<unknown, unknown> & AnnotatedType): OpenAPIV3.SchemaObject {
        // TODO: Overwegen om intersections te vertalen naar `allOf` constructies, dat geeft meer gedetailleerde specs, maar zijn ook
        // moeilijker om te bevatten. Nu zijn de types platgeslagen naar een enkel object (door @skunkteam/types).
        const required = Object.keys(type.propsInfo).filter(prop => type.propsInfo[prop]?.partial === false);
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'object',
            properties: mapValues(type.props, (propType, prop) => {
                const schema = this.processType(propType);
                const metadata = type[OPENAPI_METADATA]?.properties?.[prop];
                if (!metadata) {
                    return schema;
                }
                if ('$ref' in schema) {
                    throw new Error(
                        `Metadata cannot be added to a $ref property ${prop}, add it to the referenced schema instead: ${inspect(metadata, {
                            compact: true,
                        })}`,
                    );
                }
                return {
                    ...schema,
                    ...metadata,
                };
            }),
            required: required.length ? required : undefined,
        });
    }

    visitKeyofType(type: KeyofType<Record<any, any>, any>): OpenAPIV3.SchemaObject {
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'string',
            enum: Object.keys(type.keys),
        });
    }

    visitLiteralType(type: LiteralType<LiteralValue>): OpenAPIV3.SchemaObject {
        switch (type.basicType) {
            case 'number':
            case 'string':
            case 'boolean':
                return this.withMetadata(type, {
                    title: this.customName(type),
                    type: Number.isInteger(type.value) ? 'integer' : type.basicType,
                    enum: [type.value],
                });
            default:
                // Hier moeten we iets met `null`, die moet als `nullable` property worden opgenomen in de parent Schema object.
                throw new Error(`${type.basicType} literal not supported yet`);
        }
    }

    visitNumberType(type: BaseTypeImpl<number, NumberTypeConfig>): OpenAPIV3.SchemaObject {
        const { max, maxExclusive, min, minExclusive, multipleOf } = type.typeConfig;
        return this.withMetadata(type, {
            title: this.customName(type),
            type: Number.isInteger(multipleOf) ? 'integer' : 'number',
            minimum: minExclusive ?? min,
            exclusiveMinimum: minExclusive != null || undefined,
            maximum: maxExclusive ?? max,
            exclusiveMaximum: maxExclusive != null || undefined,
            multipleOf: multipleOf === 1 ? undefined : multipleOf,
        });
    }

    visitRecordType(
        _type: RecordType<
            BaseTypeImpl<string | number, unknown>,
            string | number,
            BaseTypeImpl<unknown>,
            unknown,
            Record<string | number, unknown>
        >,
    ): OpenAPIV3.SchemaObject {
        throw new Error('Method not implemented.');
    }

    visitStringType(type: BaseTypeImpl<string, StringTypeConfig>): OpenAPIV3.SchemaObject {
        const { maxLength, minLength, pattern } = type.typeConfig;
        assert(!pattern?.flags, 'Regular expression flags are not supported in OpenAPI');
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'string',
            pattern: pattern?.toString().slice(1, -1),
            minLength,
            maxLength,
            format: getFormat(type),
        });
    }

    visitUnionType(type: UnionType<OneOrMore<BaseTypeImpl<unknown>>, unknown>): OpenAPIV3.SchemaObject {
        // special case of a union of two types, of which one is `null`
        // once we upgrade to OpenAPI 3.1 this gets much easier as it supports `null` as a type
        // having nullable with a $ref in 3.0 is complicated: https://github.com/OAI/OpenAPI-Specification/issues/1368
        const nullIndex = type.types.findIndex(subtype => subtype instanceof LiteralType && subtype.value === null);
        if (nullIndex >= 0 && type.types.length === 2) {
            const nulledType = type.types[1 - nullIndex];
            assert(nulledType);
            return {
                description: `Nullable ${this.customName(nulledType) || nulledType.name}`,
                allOf: [this.processType(nulledType)],
                nullable: true,
            };
        }

        switch (type.basicType) {
            case 'boolean':
                // TODO: Moeten we nog controleren of alle booleans (i.e. true en false) aanwezig zijn?
                return this.withMetadata(type, {
                    title: this.customName(type),
                    type: 'boolean',
                });
        }
        const oneOf: OpenAPIV3.SchemaObject = this.withMetadata(type, {
            title: this.customName(type),
            oneOf: type.types.map(subtype => this.processType(subtype)),
        });
        // see if we can determine discriminator values
        if (type.possibleDiscriminators.length === 1 && type.possibleDiscriminators[0]?.path.length === 1) {
            const discriminator = type.possibleDiscriminators[0];
            const propertyName = discriminator.path[0];
            assert(propertyName);
            const mappings = discriminator.values.map(v => {
                const subType = type.types.find(t => {
                    if (!(t instanceof BaseObjectLikeTypeImpl)) {
                        return;
                    }
                    const prop = t.props[propertyName];
                    if (!(prop instanceof LiteralType)) {
                        return;
                    }
                    return prop.value === v;
                });
                const ref = subType && this.processType(subType);
                return [v, ref && '$ref' in ref ? ref.$ref : undefined] as const;
            });
            // only do this if we could find a subtype for every LiteralValue
            if (mappings.every(([, t]) => !!t)) {
                return {
                    ...oneOf,
                    discriminator: {
                        propertyName,
                        mapping: Object.fromEntries(mappings),
                    },
                };
            }
        }
        return oneOf;
    }

    visitUnknownType(type: BaseTypeImpl<unknown>): OpenAPIV3.SchemaObject {
        return this.withMetadata(type, {
            title: this.customName(type),
        });
    }

    visitUnknownRecordType(type: BaseTypeImpl<Record<string, unknown>, unknown>): OpenAPIV3.SchemaObject {
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'object',
        });
    }

    visitUnknownArrayType(type: BaseTypeImpl<unknown[], unknown>): OpenAPIV3.SchemaObject {
        return this.withMetadata(type, {
            title: this.customName(type),
            type: 'array',
            items: {},
        });
    }

    visitCustomType(_type: BaseTypeImpl<unknown>): OpenAPIV3.SchemaObject {
        throw new Error('Method not implemented.');
    }

    processType(type: BaseTypeImpl<unknown>) {
        let result = this.availableDefinitions.get(type);
        if (!result) {
            this.typeStack.push(type);
            try {
                result = type.accept(this);
            } catch (e) {
                console.error(chalk`{red ERROR:} Problem with {bold ${this.typeStack.map(t => t.name).join(' / ')}:}`);
                console.error(e);
                process.exit(1);
            } finally {
                this.typeStack.pop();
            }
            let name = this.customName(type);
            if (name) {
                // Toevoegen als named type
                // Zoek naar een unieke naam in de huidige set van definitions. Voegt een cijfer toe achter de definitie-naam indien deze
                // al in gebruik is.
                for (let i = 2; name in this.schemas; name = `${type.name}${i++}`);
                this.schemas[name] = result;
                this.availableDefinitions.set(type, (result = { $ref: `${this.basePath}/${name}` }));
            } else {
                // Registeren als anonymous/nested type
                this.availableDefinitions.set(type, result);
            }
        }
        return result;
    }

    processTypes() {
        for (const type of this.topLevelTypes.keys()) {
            this.processType(type);
        }
    }

    private customName(type: BaseTypeImpl<any>) {
        let name = this.topLevelTypes.get(type);
        if (name) return name;
        ({ name } = type);
        if (!/^\w+$/.test(name) || name === type.basicType || type instanceof LiteralType) return; // not a named type; inline in parent type
        return name;
    }

    // adds any additional openapi configuration that was added to the type with `openApiMetadata()`
    private withMetadata(type: BaseTypeImpl<any> & AnnotatedType, schema: OpenAPIV3.SchemaObject): OpenAPIV3.SchemaObject {
        return {
            ...schema,
            ...type[OPENAPI_METADATA]?.metadata,
        };
    }
}

function getFormat(type: BaseTypeImpl<unknown, unknown>): string | undefined {
    switch (type) {
        // could be used to match specific skunkteam/types to known openapi schema types
        // case ISODate:
        //     return 'date';
        // case ISODateTime:
        //     return 'date-time';
        default:
            return;
    }
}
