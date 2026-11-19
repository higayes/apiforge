import { describe, expect, it } from 'vitest';
import { evaluateExpect } from '../../src/assertions/expect.js';
import { evaluateJsonPathChecks, evaluateValueCheck } from '../../src/assertions/value-check.js';
import { checkSchemaCompiles, validateJsonSchema } from '../../src/assertions/json-schema.js';
import type { AssertionContextData } from '../../src/assertions/expect.js';

function context(overrides: Partial<AssertionContextData> = {}): AssertionContextData {
  return {
    request: { method: 'GET', url: 'http://localhost/x' },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      bodyPreview: '',
      bodyTruncated: false,
      sizeBytes: 10,
      durationMs: 12,
      redirects: [],
    },
    json: { id: 42, name: 'Ada', tags: ['a', 'b'], nested: { ok: true }, score: 99.5 },
    text: '{"id":42}',
    ...overrides,
  };
}

const passed = (results: ReturnType<typeof evaluateExpect>) =>
  results.every((result) => result.passed);
const failures = (results: ReturnType<typeof evaluateExpect>) =>
  results.filter((result) => !result.passed);

describe('status assertions', () => {
  it('accepts exact, array, in-range and "in list" statuses', () => {
    expect(passed(evaluateExpect({ status: 200 }, context()))).toBe(true);
    expect(passed(evaluateExpect({ status: [200, 201] }, context()))).toBe(true);
    expect(passed(evaluateExpect({ status: { min: 200, max: 299 } }, context()))).toBe(true);
    expect(passed(evaluateExpect({ status: { in: [200, 204] } }, context()))).toBe(true);
  });

  it('produces readable messages on failure', () => {
    const [failure] = failures(evaluateExpect({ status: 201 }, context()));
    expect(failure?.message).toBe('expected HTTP 201, received HTTP 200');
    expect(failure?.actual).toBe(200);
    expect(failure?.expected).toBe(201);
  });
});

describe('header assertions', () => {
  it('matches headers case-insensitively', () => {
    const results = evaluateExpect(
      { headers: { 'Content-Type': { contains: 'json' } } },
      context(),
    );
    expect(passed(results)).toBe(true);
  });

  it('supports equals, notEquals, matches, in, exists', () => {
    // Exercised through `evaluateValueCheck` because a single object literal
    // cannot carry two checks for the same header (TS1117).
    const results = [
      evaluateValueCheck('header:x-request-id', { equals: 'abc' }, { found: true, value: 'abc' }),
      evaluateValueCheck(
        'header:content-type',
        { notEquals: 'text/plain' },
        { found: true, value: 'application/json' },
      ),
      evaluateValueCheck(
        'header:x-request-id',
        { matches: '^[a-z]+$' },
        { found: true, value: 'abc' },
      ),
      evaluateValueCheck(
        'header:content-type',
        { in: ['application/json'] },
        { found: true, value: 'application/json' },
      ),
      evaluateValueCheck('header:x-request-id', { exists: true }, { found: true, value: 'abc' }),
      evaluateValueCheck('header:x-missing', { exists: false }, { found: false, value: undefined }),
    ].flat();
    expect(passed(results)).toBe(true);
  });

  it('fails with a clear message when a header is missing', () => {
    const [failure] = failures(
      evaluateExpect({ headers: { 'x-missing': { equals: 'x' } } }, context()),
    );
    expect(failure?.message).toContain('expected header "x-missing" to be present');
  });
});

describe('jsonPath assertions', () => {
  it('supports all value operators', () => {
    const ctx = context();
    const json = ctx.json as Record<string, unknown>;
    // One object literal cannot repeat a path, so each operator is evaluated
    // directly against the same resolved values a suite would see.
    const results = [
      evaluateValueCheck('$.id', 42, { found: true, value: json.id }),
      evaluateValueCheck('$.name', { equals: 'Ada' }, { found: true, value: json.name }),
      evaluateValueCheck('$.nested.ok', { exists: true }, { found: true, value: true }),
      evaluateValueCheck(
        '$.tags',
        { length: 2, type: 'array', contains: 'a' },
        { found: true, value: json.tags },
      ),
      evaluateValueCheck('$.score', { gt: 99, lte: 100 }, { found: true, value: json.score }),
      evaluateValueCheck('$.name', { matches: '^A' }, { found: true, value: json.name }),
      evaluateValueCheck('$.tags[1]', { in: ['b', 'c'] }, { found: true, value: 'b' }),
      evaluateValueCheck('$.missing', { exists: false }, { found: false, value: undefined }),
      evaluateValueCheck('$.id', { notIn: [1, 2] }, { found: true, value: json.id }),
      evaluateValueCheck(
        '$.name',
        { minLength: 3, maxLength: 10 },
        { found: true, value: json.name },
      ),
    ].flat();
    expect(failures(results)).toEqual([]);
  });

  it('accepts shorthand scalars for jsonPath values', () => {
    expect(passed(evaluateExpect({ jsonPath: { id: 42, name: 'Ada' } }, context()))).toBe(true);
    expect(passed(evaluateExpect({ jsonPath: { id: 43 } }, context()))).toBe(false);
  });

  it('fails when the body is not JSON', () => {
    const [failure] = failures(
      evaluateExpect({ jsonPath: { a: 1 } }, context({ json: undefined })),
    );
    expect(failure?.message).toContain('response is not valid JSON');
  });

  it('reports missing paths distinctly from wrong values', () => {
    const [missing] = failures(evaluateExpect({ jsonPath: { nope: 1 } }, context()));
    expect(missing?.message).toBe('value is missing at this path');
  });

  it('evaluates every/some element-wise', () => {
    const ctx = context({ json: { numbers: [2, 4, 6], mixed: [1, 'x'] } });
    expect(
      passed(evaluateExpect({ jsonPath: { numbers: { every: { type: 'number' } } } }, ctx)),
    ).toBe(true);
    expect(passed(evaluateExpect({ jsonPath: { mixed: { some: { type: 'string' } } } }, ctx))).toBe(
      true,
    );
    const failed = failures(evaluateExpect({ jsonPath: { numbers: { every: { gt: 3 } } } }, ctx));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain('not every item matched');
    expect(failed[0]?.children?.length).toBeGreaterThan(0);
  });

  it('treats plain objects as literal deep-equality values', () => {
    const ctx = context({ json: { payload: { a: 1, b: [2, 3] } } });
    expect(passed(evaluateExpect({ jsonPath: { payload: { b: [2, 3], a: 1 } } }, ctx))).toBe(true);
    expect(passed(evaluateExpect({ jsonPath: { payload: { a: 2 } } }, ctx))).toBe(false);
  });

  it('compares objects structurally, independent of key order', () => {
    // Regression: deep equality used JSON.stringify, so `{a,b}` never matched
    // `{b,a}` and array/object nesting was compared as raw text.
    const ctx = context({ json: { payload: { a: 1, b: { c: [1, 2], d: null } } } });
    expect(
      passed(evaluateExpect({ jsonPath: { payload: { b: { d: null, c: [1, 2] }, a: 1 } } }, ctx)),
    ).toBe(true);
    expect(
      passed(evaluateExpect({ jsonPath: { payload: { a: 1, b: { c: [2, 1], d: null } } } }, ctx)),
    ).toBe(false);
    expect(passed(evaluateExpect({ jsonPath: { payload: { a: 1 } } }, ctx))).toBe(false);
    expect(
      passed(
        evaluateExpect({ jsonPath: { payload: { a: 1, b: { c: [1, 2], d: null }, e: 0 } } }, ctx),
      ),
    ).toBe(false);
  });
});

describe('body assertions', () => {
  it('supports contains/matches/equals on text', () => {
    const ctx = context({ text: 'hello world' });
    expect(passed(evaluateExpect({ body: { contains: 'world' } }, ctx))).toBe(true);
    expect(passed(evaluateExpect({ body: { matches: '^hello' } }, ctx))).toBe(true);
    expect(passed(evaluateExpect({ body: { equals: 'hello world' } }, ctx))).toBe(true);
    expect(passed(evaluateExpect({ body: { notContains: 'goodbye' } }, ctx))).toBe(true);
  });

  it('compares JSON bodies structurally', () => {
    const ctx = context({ json: { a: 1, b: 2 } });
    expect(passed(evaluateExpect({ body: { equals: { a: 1, b: 2 } } }, ctx))).toBe(true);
    expect(passed(evaluateExpect({ body: { equals: { a: 1, b: 3 } } }, ctx))).toBe(false);
  });

  it('validates JSON Schema', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'number' }, name: { type: 'string', minLength: 2 } },
    };
    expect(passed(evaluateExpect({ body: { schema } }, context()))).toBe(true);
    const [failure] = failures(
      evaluateExpect({ body: { schema: { ...schema, required: ['email'] } } }, context()),
    );
    expect(failure?.message).toContain("must have required property 'email'");
  });
});

describe('time assertions', () => {
  it('checks response time bounds', () => {
    expect(passed(evaluateExpect({ time: { lessThan: 1000 } }, context()))).toBe(true);
    expect(passed(evaluateExpect({ time: { moreThan: 5000 } }, context()))).toBe(false);
  });
});

describe('schema validation utility', () => {
  it('validates and reports all errors', () => {
    const result = validateJsonSchema(
      {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'number', minimum: 18 } },
        required: ['name', 'age'],
      },
      { name: 5, age: 10 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.join('\n')).toContain('/name');
    expect(result.errors.join('\n')).toContain('/age');
  });

  it('supports formats', () => {
    const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' } } };
    expect(validateJsonSchema(schema, { email: 'not-an-email' }).valid).toBe(false);
    expect(validateJsonSchema(schema, { email: 'ok@example.com' }).valid).toBe(true);
  });

  it('flags unusable schemas', () => {
    expect(checkSchemaCompiles({ type: 'not-a-real-type' })).toBeDefined();
    expect(checkSchemaCompiles({ type: 'object' })).toBeUndefined();
  });
});

describe('evaluateValueCheck edge cases', () => {
  it('rejects empty assertions', () => {
    const results = evaluateValueCheck('$.x', {}, { found: true, value: 1 });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain('no operators');
  });

  it('handles regex errors gracefully', () => {
    const results = evaluateValueCheck('$.x', { matches: '(' }, { found: true, value: 'abc' });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain('invalid regular expression');
  });

  it('handles length on objects', () => {
    const results = evaluateValueCheck(
      '$.x',
      { length: 2 },
      { found: true, value: { a: 1, b: 2 } },
    );
    expect(results[0]?.passed).toBe(true);
  });

  it('reports numeric comparisons on non-numeric values', () => {
    const results = evaluateValueCheck('$.x', { gt: 1 }, { found: true, value: { a: 1 } });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain('cannot compare');
  });

  it('supports notEquals and type checks', () => {
    expect(
      evaluateValueCheck('$.x', { notEquals: 'b' }, { found: true, value: 'a' })[0]?.passed,
    ).toBe(true);
    expect(
      evaluateValueCheck('$.x', { type: 'array' }, { found: true, value: 'a' })[0]?.passed,
    ).toBe(false);
    expect(
      evaluateValueCheck('$.x', { type: 'array' }, { found: true, value: [1] })[0]?.passed,
    ).toBe(true);
  });

  it('evaluates deep structural equality with a diff message', () => {
    const results = evaluateValueCheck(
      '$.x',
      { equals: { a: 1, b: { c: 2 } } },
      { found: true, value: { a: 1, b: { c: 3 } } },
    );
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain('$.b.c');
  });
});

describe('evaluateJsonPathChecks', () => {
  it('prefixes targets with the JSONPath root', () => {
    const results = evaluateJsonPathChecks({ user: { id: 1 } }, { 'user.id': 1 });
    expect(results[0]?.target).toBe('$.user.id');
    expect(results[0]?.passed).toBe(true);
  });
});
