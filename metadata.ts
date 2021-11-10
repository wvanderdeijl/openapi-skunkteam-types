import type { ObjectType, Type, TypeOf } from '@skunkteam/types';
import type { OpenAPIV3 } from 'openapi-types';

export const OPENAPI_METADATA = Symbol('openapi metadata for a skunkteam type');

type CustomMetadata<T> = Pick<OpenAPIV3.BaseSchemaObject, 'description' | 'deprecated' | 'format' | 'xml'> &
    (T extends Array<unknown> ? { items?: CustomMetadata<T[number]> } : {}) & { example?: T };

/** Add/override openapi properties of the type */
export function openApiMetadata<T extends Type<unknown, unknown>>(
    type: T,
    metadata: CustomMetadata<TypeOf<T>>,
    properties?: T extends ObjectType<unknown, unknown> ? { [P in keyof TypeOf<T>]?: CustomMetadata<TypeOf<T>[P]> } : never,
) {
    Object.defineProperty(type, OPENAPI_METADATA, { value: { metadata, properties } });
}
