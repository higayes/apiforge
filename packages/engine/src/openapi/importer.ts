/**
 * OpenAPI 3.x / Swagger 2.0 → APIFORGE suite importer.
 *
 * Generated suites are deliberately conservative:
 *  - one test per operation (`operationId` or `METHOD /path` as the name),
 *  - required parameters and request bodies are filled with example values
 *    derived from the schema, so the suite runs immediately,
 *  - the expected status is the lowest documented 2xx response,
 *  - response schemas become `expect.body.schema` assertions when available and
 *    small enough to embed,
 *  - unresolved `$ref`s are inlined with cycle protection; unsupported remote
 *    refs are reported and skipped rather than silently mangled.
 */
import { ConfigError } from '../errors.js';
import type { SuiteDefinition, TestDefinition } from '../config/schema.js';
import { dereferenceLocalRefs } from '../assertions/json-schema.js';

type JsonObject = Record<string, unknown>;

export interface ImportOptions {
  /** Base URL to use in the generated suite. Defaults to `servers[0].url`. */
  baseUrl?: string;
  /** Only import operations with these tags. */
  tags?: string[];
  /** Only import operations whose path matches this regular expression. */
  pathPattern?: string;
  /** Include `expect.body.schema` assertions from the documented response schema. */
  includeSchemas?: boolean;
  maxSchemaBytes?: number;
}

export interface ImportResult {
  suite: SuiteDefinition;
  operationCount: number;
  warnings: string[];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (depth > 8 || !isObject(schema)) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = typeof schema.type === 'string' ? schema.type : undefined;
  switch (type) {
    case 'string': {
      const format = typeof schema.format === 'string' ? schema.format : '';
      if (format === 'date') return '2024-01-01';
      if (format === 'date-time') return '2024-01-01T00:00:00Z';
      if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (format === 'email') return 'user@example.com';
      if (format === 'uri' || format === 'url') return 'https://example.com';
      if (format === 'byte') return 'ZXhhbXBsZQ==';
      return 'string';
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'array':
      return schema.items ? [exampleFromSchema(schema.items, depth + 1)] : [];
    case 'object': {
      const properties = asObject(schema.properties);
      const required = asArray(schema.required).filter((entry): entry is string => typeof entry === 'string');
      const out: JsonObject = {};
      for (const key of required) out[key] = exampleFromSchema(properties[key], depth + 1);
      return out;
    }
    default: {
      if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return exampleFromSchema(schema.oneOf[0], depth + 1);
      if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return exampleFromSchema(schema.anyOf[0], depth + 1);
      if (isObject(schema.properties)) return exampleFromSchema({ ...schema, type: 'object' }, depth + 1);
      return undefined;
    }
  }
}

/** Convert OpenAPI parameter definitions into query/header/cookie/path maps. */
function collectParameters(
  parameters: unknown[],
): {
  query: Record<string, string>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  pathParams: Record<string, string>;
} {
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const pathParams: Record<string, string> = {};

  for (const entry of parameters) {
    if (!isObject(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    const location = typeof entry.in === 'string' ? entry.in : undefined;
    if (!name || !location) continue;
    const required = entry.required === true;
    const schema = entry.schema ?? entry;
    // Include optional parameters whose schema yields an example (clients
    // exercise them); required ones always get a deterministic fallback.
    const value = entry.example ?? exampleFromSchema(schema) ?? (required ? 'string' : undefined);
    if (value === undefined) continue;
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (location === 'query') query[name] = rendered;
    else if (location === 'header') headers[name] = rendered;
    else if (location === 'cookie') cookies[name] = rendered;
    else if (location === 'path') pathParams[name] = rendered;
  }
  return { query, headers, cookies, pathParams };
}

function statusExpectation(responses: JsonObject): number | undefined {
  const candidates = Object.keys(responses)
    .filter((code) => /^\d{3}$/.test(code))
    .map((code) => Number.parseInt(code, 10))
    .filter((code) => code >= 200 && code < 300)
    .sort((a, b) => a - b);
  return candidates[0];
}

function responseSchemaFor(responses: JsonObject, status: number | undefined): JsonObject | undefined {
  const keys = status !== undefined ? [String(status)] : Object.keys(responses).filter((key) => /^2\d\d$/.test(key));
  for (const key of keys) {
    const response = asObject(responses[key]);
    const content = asObject(response.content);
    for (const mediaType of ['application/json', 'application/*+json', '*/*']) {
      const entry = asObject(content[mediaType]);
      if (isObject(entry.schema)) return entry.schema;
    }
    // Swagger 2.0: response.schema
    if (isObject(response.schema)) return response.schema;
  }
  return undefined;
}

const SUPPORTED_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export function importOpenApiDocument(document: unknown, options: ImportOptions = {}): ImportResult {
  if (!isObject(document)) throw new ConfigError('The OpenAPI document must be a JSON/YAML object');
  const version = String(document.openapi ?? document.swagger ?? '');
  if (!version) {
    throw new ConfigError('The document is not an OpenAPI specification', [
      'Expected an `openapi` (3.x) or `swagger` (2.0) version field.',
    ]);
  }
  const isSwagger2 = version.startsWith('2');
  if (!isSwagger2 && !version.startsWith('3')) {
    throw new ConfigError(`Unsupported OpenAPI version: ${version}`, ['Supported versions: Swagger 2.0 and OpenAPI 3.x']);
  }

  const warnings: string[] = [];
  const dereferenced = dereferenceLocalRefs(document) as JsonObject;
  const info = asObject(dereferenced.info);
  const title = typeof info.title === 'string' && info.title.trim() !== '' ? info.title.trim() : 'Imported API';

  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    if (isSwagger2) {
      const schemes = asArray(dereferenced.schemes).filter((entry): entry is string => typeof entry === 'string');
      const host = typeof dereferenced.host === 'string' ? dereferenced.host : undefined;
      const basePath = typeof dereferenced.basePath === 'string' ? dereferenced.basePath : '';
      if (host) baseUrl = `${schemes[0] ?? 'https'}://${host}${basePath}`;
      else warnings.push('Swagger 2.0 document has no `host`; set `baseUrl` manually in the generated suite.');
    } else {
      const servers = asArray(dereferenced.servers);
      const first = asObject(servers[0]);
      if (typeof first.url === 'string' && first.url.trim() !== '') baseUrl = first.url;
      else warnings.push('The OpenAPI document declares no `servers`; set `baseUrl` manually in the generated suite.');
    }
  }
  if (baseUrl && /[{}]/.test(baseUrl)) {
    warnings.push(`Server URL contains template variables: ${baseUrl} — replace them in the generated suite.`);
  }

  const paths = asObject(dereferenced.paths);
  const tests: TestDefinition[] = [];
  const pathFilter = options.pathPattern ? new RegExp(options.pathPattern) : undefined;

  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (pathFilter && !pathFilter.test(path)) continue;
    const pathItem = asObject(pathItemRaw);
    const sharedParameters = asArray(pathItem.parameters);

    for (const method of SUPPORTED_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;

      const operationTags = asArray(operation.tags).filter((entry): entry is string => typeof entry === 'string');
      if (options.tags && options.tags.length > 0 && !operationTags.some((tag) => options.tags?.includes(tag))) {
        continue;
      }
      if (operation.deprecated === true) continue;

      const parameters = [...sharedParameters, ...asArray(operation.parameters)];
      const { query, headers, cookies, pathParams } = collectParameters(parameters);

      const resolvedPath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const value = pathParams[name];
        if (value === undefined) {
          warnings.push(`${method.toUpperCase()} ${path}: path parameter "${name}" has no example value; using "string".`);
          return 'string';
        }
        return encodeURIComponent(value);
      });

      let body: TestDefinition['body'];
      const requestBody = asObject(operation.requestBody);
      const requestContent = asObject(requestBody.content);
      const jsonContent = asObject(
        requestContent['application/json'] ?? requestContent['application/*+json'] ?? Object.values(requestContent)[0],
      );
      if (isObject(jsonContent.schema)) {
        const example = jsonContent.example ?? exampleFromSchema(jsonContent.schema);
        if (example !== undefined) body = { json: example };
        else warnings.push(`${method.toUpperCase()} ${path}: request body schema produced no example; body omitted.`);
      } else if (operation.requestBody === undefined) {
        // Swagger 2.0 style body parameter
        for (const parameter of parameters) {
          if (isObject(parameter) && parameter.in === 'body' && isObject(parameter.schema)) {
            const example = exampleFromSchema(parameter.schema);
            if (example !== undefined) body = { json: example };
            break;
          }
        }
      }

      const responses = asObject(operation.responses);
      const successStatus = statusExpectation(responses);
      const name =
        typeof operation.operationId === 'string' && operation.operationId.trim() !== ''
          ? operation.operationId
          : `${method.toUpperCase()} ${path}`;
      const summary = typeof operation.summary === 'string' ? operation.summary : undefined;

      let expect: TestDefinition['expect'] = successStatus !== undefined ? { status: successStatus } : { status: { min: 200, max: 299 } };
      if (successStatus === undefined) {
        warnings.push(`${method.toUpperCase()} ${path}: no documented 2xx response; asserting 2xx range instead.`);
      }

      if (options.includeSchemas === true) {
        const schema = responseSchemaFor(responses, successStatus);
        if (schema) {
          const serialized = JSON.stringify(schema);
          const limit = options.maxSchemaBytes ?? 20_000;
          if (serialized.length <= limit) {
            expect = { ...expect, body: { schema } };
          } else {
            warnings.push(`${method.toUpperCase()} ${path}: response schema is larger than ${limit} bytes; skipped.`);
          }
        }
      }

      tests.push({
        name,
        ...(summary ? { description: summary } : {}),
        method: method.toUpperCase(),
        path: resolvedPath,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(cookies).length > 0 ? { cookies } : {}),
        ...(body ? { body } : {}),
        expect,
        ...(operationTags.length > 0 ? { tags: operationTags } : {}),
      });
    }
  }

  if (tests.length === 0) {
    throw new ConfigError('No importable operations were found in the OpenAPI document', [
      'Check the `paths` section, or relax the --tag / --path filters.',
    ]);
  }

  const suite: SuiteDefinition = {
    name: title,
    description: `${title} (imported from OpenAPI ${version})`,
    ...(baseUrl ? { baseUrl } : {}),
    ...(isSwagger2 ? {} : {}),
    tests,
  };

  return { suite, operationCount: tests.length, warnings };
}

/** Best-effort generation of a `json-schema` document from an OpenAPI schema. */
export function extractJsonSchemaForOperation(
  document: unknown,
  method: string,
  path: string,
): JsonObject | undefined {
  const doc = dereferenceLocalRefs(document) as JsonObject;
  const pathItem = asObject(asObject(doc.paths)[path]);
  const operation = asObject(pathItem[method.toLowerCase()]);
  const responses = asObject(operation.responses);
  const successStatus = statusExpectation(responses);
  return responseSchemaFor(responses, successStatus);
}
