# openapi-skunkteam-types

This utility removes the need for hand written schemas in an OpenAPI specification file. Instead, use
[@skunkteam/types](https://github.com/skunkteam/types) for runtime type-validation and then use this tool to convert those skunkteam types
to OpenAPI schema definitions

All you need to do in your openapi.yaml files is add a `x-skunkteam-type` annotation in places where you want to refer to a skunkteam/type:

```yaml
openapi: 3.0.2
info:
    version: 1.0.7
    title: Swagger Petstore - OpenAPI 3.0
paths:
    /pet:
        post:
            responses:
                '200':
                    description: Successful operation
                    content:
                        application/json:
                            schema:
                                x-skunkteam-type: ./types.ts#Pet
            requestBody:
                required: true
                content:
                    application/json:
                        schema:
                            x-skunkteam-type: ./types.ts#Pet
```

Then run this tool to generate types for an openapi.yaml and all the OpenAPI yaml files it references using `$ref`:

```
npx ts-node ./cli.ts ./openapi.yml
```

This generates new `.types.yaml` files on disk with the OpenAPI schemas that are generated based on the skunkteam/types:

```yaml
openapi: 3.0.0
info:
    version: 1.0.7
    title: Types for Swagger Petstore - OpenAPI 3.0
paths: {}
components:
    schemas:
        int:
            title: int
            type: integer
        Category:
            description: The Category
            title: Category
            type: object
            properties:
                id:
                    $ref: '#/components/schemas/int'
                name:
                    type: string
                    example: Dogs
```

It also adds a `$ref` to the original OpenAPI yaml to reference the generated type:

```yaml
openapi: 3.0.2
info:
    version: 1.0.7
    title: Swagger Petstore - OpenAPI 3.0
paths:
    /pet:
        post:
            responses:
                '200':
                    description: Successful operation
                    content:
                        application/json:
                            schema:
                                x-skunkteam-type: ./types.ts#Pet
                                $ref: ./openapi.types.yml#/components/schemas/Pet
            requestBody:
                required: true
                content:
                    application/json:
                        schema:
                            x-skunkteam-type: ./types.ts#Pet
                            $ref: ./openapi.types.yml#/components/schemas/Pet
```

The generated `.types.yaml` files can be placed under version control so changes to the generated schemas can be easily detected
in a pull request. If you so put these files under version control, be sure to run the types generated in your CI build and then
check for pending changes in your git files. If any of these changes are found, it is an indicator that the generated schemas in source
control are outdated and you should fail the CI build:

```bash
git status
[[ -z $(git status -s) ]]
```
