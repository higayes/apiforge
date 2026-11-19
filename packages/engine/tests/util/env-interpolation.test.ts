import { describe, expect, it } from 'vitest';
import {
  expandEnvDeep,
  expandEnvString,
  findEnvReferences,
} from '../../src/util/env-interpolation.js';
import { ConfigError } from '../../src/errors.js';

const env = { API_URL: 'https://api.example.com', EMPTY: '' };

describe('expandEnvString', () => {
  it('substitutes a required variable', () => {
    expect(expandEnvString('${API_URL}/v1', { env }).value).toBe('https://api.example.com/v1');
  });

  it('applies :- fallbacks when the variable is unset or empty', () => {
    expect(expandEnvString('${MISSING:-http://localhost:4010}', { env }).value).toBe(
      'http://localhost:4010',
    );
    expect(expandEnvString('${EMPTY:-fallback}', { env }).value).toBe('fallback');
  });

  it('applies - fallbacks only when the variable is unset', () => {
    expect(expandEnvString('${EMPTY-fallback}', { env }).value).toBe('');
    expect(expandEnvString('${MISSING-fallback}', { env }).value).toBe('fallback');
  });

  it('keeps an empty string when the variable is set to empty and no default is given', () => {
    // An explicit empty value is a legitimate configuration; only *unset* is fatal.
    const result = expandEnvString('x${EMPTY}y', { env, strict: false });
    expect(result.value).toBe('xy');
  });

  it('throws an actionable error for a missing required variable', () => {
    expect(() => expandEnvString('${MISSING}', { env })).toThrowError(ConfigError);
    try {
      expandEnvString('${MISSING}', { env });
    } catch (error) {
      expect((error as ConfigError).message).toContain('"MISSING" is not set');
      expect((error as ConfigError).details.join(' ')).toContain('${MISSING:-some-default}');
    }
  });

  it('honours a custom :? error message', () => {
    try {
      expandEnvString('${TOKEN:?a token is required}', { env });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as ConfigError).message).toContain('a token is required');
    }
  });

  it('escapes $${...} to a literal', () => {
    expect(expandEnvString('$${KEEP}', { env }).value).toBe('${KEEP}');
  });

  it('does not expand $HOME or other shell forms without braces', () => {
    expect(expandEnvString('$HOME and $1', { env }).value).toBe('$HOME and $1');
  });

  it('reports which variables were used or defaulted', () => {
    const result = expandEnvString('${API_URL} ${MISSING:-x}', { env });
    expect(result.used).toEqual(['API_URL', 'MISSING']);
    expect(result.defaulted).toEqual(['MISSING']);
  });
});

describe('expandEnvDeep', () => {
  it('walks nested objects and arrays, leaving other scalars intact', () => {
    const document = {
      name: 'demo',
      baseUrl: '${API_URL}',
      timeoutMs: 5000,
      enabled: true,
      nothing: null,
      variables: { url: '${API_URL}/v2', nested: ['${API_URL}', 1] },
    };
    expect(expandEnvDeep(document, { env })).toEqual({
      name: 'demo',
      baseUrl: 'https://api.example.com',
      timeoutMs: 5000,
      enabled: true,
      nothing: null,
      variables: { url: 'https://api.example.com/v2', nested: ['https://api.example.com', 1] },
    });
  });

  it('preserves identity when nothing needs expanding', () => {
    const document = { a: 'plain', b: [1, 2] };
    expect(expandEnvDeep(document, { env })).toEqual(document);
  });
});

describe('findEnvReferences', () => {
  it('collects every referenced variable, ignoring escapes', () => {
    const found = findEnvReferences({
      a: '${ONE}',
      b: ['${TWO:-x}', '$${NOT_A_REF}'],
      c: { d: '${ONE}' },
    });
    expect([...found].sort()).toEqual(['ONE', 'TWO']);
  });
});
