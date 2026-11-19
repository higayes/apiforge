import { describe, expect, it } from 'vitest';
import { extractJsonSchemaForOperation, importOpenApiDocument } from '../../src/openapi/importer.js';
import { ConfigError } from '../../src/errors.js';

const openapi3 = {
  openapi: '3.0.3',
  info: { title: 'Pet Store', version: '1.0.0' },
  servers: [{ url: 'https://api.petstore.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        tags: ['pets'],
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 100 } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createPet',
        tags: ['pets'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, tag: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/pets/{petId}': {
      get: {
        parameters: [{ name: 'petId', in: 'path', required: true, example: 9 }],
        responses: { '200': { description: 'ok' } },
      },
      delete: {
        operationId: 'deletePet',
        responses: { '204': { description: 'deleted' } },
      },
    },
    '/legacy': {
      put: { deprecated: true, responses: { '200': { description: 'ok' } } },
    },
  },
};

describe('importOpenApiDocument — OpenAPI 3', () => {
  it('imports operations with names, paths, params and bodies', () => {
    const { suite, operationCount, warnings } = importOpenApiDocument(openapi3);
    expect(operationCount).toBe(4);
    expect(suite.baseUrl).toBe('https://api.petstore.example.com/v1');
    expect(suite.name).toBe('Pet Store');
    expect(warnings).toEqual(['DELETE /pets/{petId}: path parameter "petId" has no example value; using "string".']);

    const listPets = suite.tests.find((test) => test.name === 'listPets');
    expect(listPets?.method).toBe('GET');
    expect(listPets?.path).toBe('/pets');
    expect(listPets?.query).toEqual({ limit: '1' });
    expect(listPets?.expect?.status).toBe(200);
    expect(listPets?.tags).toEqual(['pets']);

    const createPet = suite.tests.find((test) => test.name === 'createPet');
    expect(createPet?.method).toBe('POST');
    expect(createPet?.body).toEqual({ json: { name: 'string' } });
    expect(createPet?.expect?.status).toBe(201);

    const fetchPet = suite.tests.find((test) => test.name === 'GET /pets/{petId}');
    expect(fetchPet?.path).toBe('/pets/9');

    expect(suite.tests.some((test) => test.name === 'deletePet' && test.expect?.status === 204)).toBe(true);
  });

  it('skips deprecated operations', () => {
    const { suite } = importOpenApiDocument(openapi3);
    expect(suite.tests.some((test) => test.path === '/legacy')).toBe(false);
  });

  it('includes response schemas when requested', () => {
    const { suite } = importOpenApiDocument(openapi3, { includeSchemas: true });
    const listPets = suite.tests.find((test) => test.name === 'listPets');
    expect(listPets?.expect?.body?.schema).toBeDefined();
  });

  it('filters by tag and path', () => {
    const byTag = importOpenApiDocument(openapi3, { tags: ['pets'] });
    expect(byTag.operationCount).toBe(2);
    const byPath = importOpenApiDocument(openapi3, { pathPattern: '^/pets/\\{' });
    expect(byPath.operationCount).toBe(2);
  });

  it('honours a baseUrl override', () => {
    const { suite } = importOpenApiDocument(openapi3, { baseUrl: 'http://localhost:3000' });
    expect(suite.baseUrl).toBe('http://localhost:3000');
  });
});

describe('importOpenApiDocument — Swagger 2.0 and edge cases', () => {
  it('supports Swagger 2.0 documents', () => {
    const swagger = {
      swagger: '2.0',
      info: { title: 'Legacy API', version: '1' },
      host: 'legacy.example.com',
      basePath: '/api',
      schemes: ['https'],
      paths: {
        '/items': {
          post: {
            consumes: ['application/json'],
            parameters: [{ name: 'body', in: 'body', required: true, schema: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } }],
            responses: { '201': { description: 'created', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
          },
        },
      },
    };
    const { suite } = importOpenApiDocument(swagger);
    expect(suite.baseUrl).toBe('https://legacy.example.com/api');
    expect(suite.tests[0]?.body).toEqual({ json: { sku: 'string' } });
  });

  it('rejects non-OpenAPI documents', () => {
    expect(() => importOpenApiDocument({})).toThrow(ConfigError);
    expect(() => importOpenApiDocument({ openapi: '4.0.0' })).toThrow(/Unsupported OpenAPI version/);
    expect(() => importOpenApiDocument(null)).toThrow(/must be a JSON\/YAML object/);
  });

  it('fails when no operations match', () => {
    expect(() => importOpenApiDocument(openapi3, { tags: ['nope'] })).toThrow(/No importable operations/);
  });

  it('warns when servers are missing', () => {
    const { warnings, suite } = importOpenApiDocument({ openapi: '3.0.0', info: { title: 'T' }, paths: { '/x': { get: { responses: { '200': {} } } } } });
    expect(warnings.join(' ')).toContain('no `servers`');
    expect(suite.baseUrl).toBeUndefined();
  });

  it('resolves local $refs', () => {
    const document = {
      openapi: '3.0.0',
      info: { title: 'Refs' },
      servers: [{ url: 'https://x.dev' }],
      components: {
        schemas: { NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
      },
      paths: {
        '/pets': {
          post: {
            operationId: 'create',
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } },
            responses: { '201': { description: 'created' } },
          },
        },
      },
    };
    const { suite } = importOpenApiDocument(document);
    expect(suite.tests[0]?.body).toEqual({ json: { name: 'string' } });
  });

  it('warns about unresolved path parameters', () => {
    const { suite, warnings } = importOpenApiDocument({
      openapi: '3.0.0',
      info: { title: 'P' },
      servers: [{ url: 'https://x.dev' }],
      paths: { '/a/{missing}': { get: { responses: { '200': {} } } } },
    });
    expect(suite.tests[0]?.path).toBe('/a/string');
    expect(warnings.join(' ')).toContain('missing');
  });

  it('extracts schemas for a specific operation', () => {
    const schema = extractJsonSchemaForOperation(openapi3, 'get', '/pets');
    expect(schema?.type).toBe('array');
  });

  it('generates enum and format-aware examples', () => {
    const { suite } = importOpenApiDocument({
      openapi: '3.0.0',
      info: { title: 'E' },
      servers: [{ url: 'https://x.dev' }],
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['role', 'email', 'created', 'flag'],
                    properties: {
                      role: { type: 'string', enum: ['admin', 'user'] },
                      email: { type: 'string', format: 'email' },
                      created: { type: 'string', format: 'date-time' },
                      flag: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            responses: { '200': {} },
          },
        },
      },
    });
    expect(suite.tests[0]?.body).toEqual({
      json: { role: 'admin', email: 'user@example.com', created: '2024-01-01T00:00:00Z', flag: true },
    });
  });
});
