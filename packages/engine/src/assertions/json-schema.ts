/**
 * JSON Schema validation (Draft-07 / OpenAPI-friendly) built on Ajv.
 *
 * Ajv is used in strict mode with formats enabled. Compiled validators are
 * cached by a stable hash of the schema so repeated assertions are cheap.
 */
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { ConfigError } from '../errors.js';

const AjvClass = (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const ajv = new (AjvClass as unknown as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
  addFormat: (name: string, format: unknown) => unknown;
})({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateFormats: true,
  logger: false,
});
(addFormats as unknown as (instance: unknown) => void)(ajv);

const validatorCache = new Map<string, ValidateFunction>();

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function cacheKey(schema: unknown): string {
  return JSON.stringify(schema);
}

/**
 * Validate `value` against a JSON Schema. Throws ConfigError when the schema
 * itself is unusable (e.g. references an unresolved `$ref`).
 */
export function validateJsonSchema(schema: Record<string, unknown>, value: unknown): SchemaValidationResult {
  const key = cacheKey(schema);
  let validator = validatorCache.get(key);
  if (!validator) {
    try {
      validator = ajv.compile(schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError('Invalid JSON Schema in assertion', [message], error);
    }
    validatorCache.set(key, validator);
  }

  const compiled = validator;
  const valid = compiled(value) === true;
  if (valid) return { valid: true, errors: [] };

  const errors = (compiled.errors ?? []).map((issue) => {
    const path = issue.instancePath === '' ? '(root)' : issue.instancePath;
    const params = issue.params ? ` (${JSON.stringify(issue.params)})` : '';
    return `${path}: ${issue.message ?? 'is invalid'}${params}`;
  });
  return { valid: false, errors };
}

/** Returns a user-facing error string when the schema itself cannot be compiled. */
export function checkSchemaCompiles(schema: Record<string, unknown>): string | undefined {
  try {
    const key = cacheKey(schema);
    if (!validatorCache.has(key)) validatorCache.set(key, ajv.compile(schema));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Resolve local `$ref`s (`#/definitions/...`, `#/components/schemas/...`) by inlining. */
export function dereferenceLocalRefs(root: unknown): unknown {
  const document = root as Record<string, unknown>;

  const lookup = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return undefined;
    const segments = ref
      .slice(2)
      .split('/')
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cursor: unknown = document;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  };

  const seen = new Set<string>();
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 64) return value;
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === 'string') {
        const target = lookup(record.$ref);
        if (target !== undefined && !seen.has(record.$ref)) {
          seen.add(record.$ref);
          const resolved = walk(target, depth + 1);
          seen.delete(record.$ref);
          return resolved;
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) out[key] = walk(entry, depth + 1);
      return out;
    }
    return value;
  };

  return walk(document, 0);
}
