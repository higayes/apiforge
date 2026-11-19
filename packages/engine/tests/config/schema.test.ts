import { describe, expect, it } from 'vitest';
import {
  parseContractDocument,
  parseDocument,
  parseEnvironmentFile,
  parsePerformanceDocument,
  parseProjectFile,
  parseSecurityDocument,
  parseSuiteDocument,
  parseSuiteFile,
  stringifySuite,
} from '../../src/config/schema.js';
import { ConfigError, ValidationError } from '../../src/errors.js';

/** Validation details (field paths) are carried on the error, not the message. */
function expectInvalid(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    const text =
      error instanceof ValidationError
        ? `${error.message}\n${error.details.join('\n')}`
        : String(error);
    expect(text, `expected error text to match ${pattern}, got: ${text}`).toMatch(pattern);
    return;
  }
  throw new Error('expected the parser to throw, but it succeeded');
}

describe('parseDocument', () => {
  it('parses YAML and JSON', () => {
    expect(parseDocument('name: x\ntests: []')).toEqual({ name: 'x', tests: [] });
    expect(parseDocument('{"name":"x"}')).toEqual({ name: 'x' });
  });

  it('rejects empty and malformed documents with context', () => {
    expect(() => parseDocument('   ', 'my-file.yaml')).toThrow(ConfigError);
    expect(() => parseDocument('name: [unclosed', 'bad.yaml')).toThrow(/Could not parse bad\.yaml/);
  });

  it('rejects duplicate keys in YAML (no silent override)', () => {
    expect(() => parseDocument('a: 1\na: 2', 'dup.yaml')).toThrow(/Could not parse/);
  });
});

describe('suite schema', () => {
  const minimal = {
    name: 'Example',
    baseUrl: 'https://api.example.com',
    tests: [{ name: 'list', method: 'get', path: '/items', expect: { status: 200 } }],
  };

  it('accepts a minimal suite and normalizes methods to upper case', () => {
    const suite = parseSuiteDocument(minimal);
    expect(suite.tests[0]?.method).toBe('GET');
  });

  it('requires at least one test', () => {
    expect(() => parseSuiteDocument({ name: 'x', tests: [] })).toThrow(ValidationError);
  });

  it('requires every test to have path or url', () => {
    expectInvalid(() => parseSuiteDocument({ name: 'x', tests: [{ name: 'y' }] }), /path/);
  });

  it('rejects unknown keys (typo protection)', () => {
    expectInvalid(
      () => parseSuiteDocument({ ...minimal, tests: [{ name: 't', path: '/x', expct: {} }] }),
      /expct/,
    );
  });

  it('rejects invalid methods', () => {
    expectInvalid(
      () => parseSuiteDocument({ name: 'x', tests: [{ name: 't', path: '/x', method: 'GE T' }] }),
      /Invalid HTTP method/,
    );
  });

  it('rejects invalid auth/body combinations', () => {
    expectInvalid(
      () =>
        parseSuiteDocument({
          name: 'x',
          tests: [{ name: 't', path: '/x', auth: { type: 'bearer' } }],
        }),
      /token/,
    );
    expectInvalid(
      () =>
        parseSuiteDocument({
          name: 'x',
          tests: [{ name: 't', path: '/x', body: { json: 1, text: 'a' } }],
        }),
      /body/,
    );
  });

  it('normalizes literal jsonPath checks while preserving operators', () => {
    const suite = parseSuiteDocument({
      name: 'x',
      tests: [
        {
          name: 't',
          path: '/x',
          expect: {
            jsonPath: {
              id: 1,
              name: { equals: 'a' },
              tags: { type: 'array' },
              meta: { nested: { deep: true } },
            },
          },
        },
      ],
    });
    expect(suite.tests[0]?.expect?.jsonPath).toEqual({
      id: { equals: 1 },
      name: { equals: 'a' },
      tags: { type: 'array' },
      meta: { equals: { nested: { deep: true } } },
    });
  });

  it('accepts multi-line YAML with comments and anchors', () => {
    const yaml = `
name: Anchored
baseUrl: https://api.example.com
variables:
  userId: 1
defaults: &defaults
  headers:
    x-suite: tests
tests:
  - name: one
    path: /users/{{userId}}
    headers:
      x-extra: "{{userId}}"
    timeoutMs: 5000
`;
    const suite = parseSuiteFile(yaml, 'anchored.yaml');
    expect(suite.variables).toEqual({ userId: 1 });
    expect(suite.defaults?.headers).toEqual({ 'x-suite': 'tests' });
    expect(suite.tests[0]?.timeoutMs).toBe(5000);
  });

  it('serializes back to YAML round-trippably', () => {
    const suite = parseSuiteDocument(minimal);
    const yaml = stringifySuite(suite);
    expect(parseSuiteFile(yaml)).toEqual(suite);
  });
});

describe('null tolerance (YAML maps containing only comments)', () => {
  it('treats null variables/secrets/headers as empty', () => {
    const suite = parseSuiteDocument({
      name: 'x',
      variables: null,
      secrets: null,
      tests: [{ name: 't', path: '/x', headers: null }],
    });
    expect(suite.variables).toEqual({});
    expect(suite.secrets).toEqual({});
    expect(suite.tests[0]?.headers).toEqual({});
  });

  it('accepts environment files whose secrets map is empty', () => {
    const env = parseEnvironmentFile('baseUrl: http://localhost\nsecrets:\n  # nothing yet\n');
    expect(env.secrets).toEqual({});
  });
});

describe('environment schema', () => {
  it('parses variables, secrets and baseUrl', () => {
    const env = parseEnvironmentFile(
      'baseUrl: https://staging.example.com\nvariables:\n  a: 1\nsecrets:\n  token: abc',
    );
    expect(env.baseUrl).toBe('https://staging.example.com');
    expect(env.variables).toEqual({ a: 1 });
    expect(env.secrets).toEqual({ token: 'abc' });
  });

  it('rejects suites passed as environments', () => {
    expectInvalid(() => parseEnvironmentFile('name: x\ntests: []'), /tests/);
  });
});

describe('project schema', () => {
  it('accepts report/performance/security configuration', () => {
    const project = parseProjectFile(`
name: My API
defaultEnvironment: staging
reports:
  formats: [terminal, html, junit]
  outDir: reports
performance:
  concurrency: 10
  durationSeconds: 30
security:
  threshold: medium
`);
    expect(project.reports?.formats).toEqual(['terminal', 'html', 'junit']);
    expect(project.performance?.concurrency).toBe(10);
    expect(project.security?.threshold).toBe('medium');
  });

  it('rejects unknown report formats and out-of-range values', () => {
    expect(() => parseProjectFile('reports:\n  formats: [pdf]')).toThrow(/pdf|invalid/i);
    expect(() => parseProjectFile('performance:\n  concurrency: 0')).toThrow();
  });
});

describe('performance/security/contract specs', () => {
  it('applies safety defaults', () => {
    const spec = parsePerformanceDocument({ target: { url: 'https://api.example.com' } });
    expect(spec.concurrency).toBe(5);
    expect(spec.timeoutMs).toBe(10_000);
    expect(spec.warmupRequests).toBe(0);
  });

  it('caps concurrency at 100', () => {
    expect(() =>
      parsePerformanceDocument({ target: { url: 'https://x.dev' }, concurrency: 500 }),
    ).toThrow();
  });

  it('defaults the security threshold to high', () => {
    expect(parseSecurityDocument({ target: { url: 'https://x.dev' } }).threshold).toBe('high');
  });

  it('validates contract specs', () => {
    expect(parseContractDocument({ target: { url: 'https://x.dev' } }).update).toBeUndefined();
    expect(() => parseContractDocument({})).toThrow();
  });
});

describe('error messages', () => {
  it('include the field path and explanation', () => {
    try {
      parseSuiteDocument(
        { name: 'x', tests: [{ name: 't', path: '/x', timeoutMs: -5 }] },
        'my.suite.yaml',
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.message).toBe('Invalid my.suite.yaml');
      expect(validation.details.join('\n')).toContain('tests.0.timeoutMs');
    }
  });
});

describe('templated operands', () => {
  it('accepts {{placeholders}} in numeric and boolean assertion fields', () => {
    // Data-driven suites pass expectations through data rows, so a limit may be
    // a placeholder at parse time even though it is a number at run time.
    expect(() =>
      parseSuiteDocument({
        name: 'templated',
        tests: [
          {
            name: 't',
            path: '/x',
            expect: {
              status: 200,
              jsonPath: {
                items: { type: 'array', length: '{{expected}}' },
                count: { gte: '{{min}}', type: 'number' },
              },
              time: { lessThan: '{{budget}}' },
              headers: { 'x-flag': { exists: '{{flag}}' } },
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('still rejects nonsense in those fields', () => {
    // The detail line names the field and explains the accepted forms.
    expect(() =>
      parseSuiteDocument({
        name: 'bad',
        tests: [
          { name: 't', path: '/x', expect: { jsonPath: { a: { length: 'not a template' } } } },
        ],
      }),
    ).toThrowError(/Invalid suite/);
  });
});
