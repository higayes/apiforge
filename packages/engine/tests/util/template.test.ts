import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { findPlaceholders, hasTemplate, renderTemplate, renderValue, resolveExpression } from '../../src/util/template.js';

describe('renderTemplate', () => {
  const ctx = {
    variables: { name: 'Ada', port: 8080, enabled: true, nested: { id: 7 }, list: [1, 2] },
    secrets: { apiKey: 'secret-value' },
    steps: { createUser: { json: { id: 99 } } },
    env: { APIFORGE_TEST_VAR: 'from-env' },
  };

  it('interpolates variables of different types', () => {
    expect(renderTemplate('{{name}}', ctx)).toBe('Ada');
    expect(renderTemplate('port={{port}}', ctx)).toBe('port=8080');
    expect(renderTemplate('{{enabled}}', ctx)).toBe('true');
    expect(renderTemplate('{{nested.id}}', ctx)).toBe('7');
  });

  it('resolves secrets and captured step values', () => {
    expect(renderTemplate('{{apiKey}}', ctx)).toBe('secret-value');
    expect(renderTemplate('{{steps.createUser.json.id}}', ctx)).toBe('99');
  });

  it('resolves $env references', () => {
    expect(renderTemplate('{{$env.APIFORGE_TEST_VAR}}', ctx)).toBe('from-env');
    process.env.APIFORGE_PROCESS_ENV = 'process-level';
    expect(renderTemplate('{{$env.APIFORGE_PROCESS_ENV}}', ctx)).toBe('process-level');
    delete process.env.APIFORGE_PROCESS_ENV;
  });

  it('supports $random and $now helpers', () => {
    const uuid = renderTemplate('{{$random.uuid}}', ctx);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const n = Number(renderTemplate('{{$random.int(10,20)}}', ctx));
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(20);
    expect(renderTemplate('{{$random.hex(8)}}', ctx)).toMatch(/^[0-9a-f]{8}$/);
    expect(renderTemplate('{{$now.unix}}', { ...ctx, now: new Date('2024-01-01T00:00:00Z') })).toBe('1704067200');
    expect(renderTemplate('{{$now.iso}}', { ...ctx, now: new Date('2024-01-01T00:00:00Z') })).toBe('2024-01-01T00:00:00.000Z');
  });

  it('throws a ConfigError for unknown variables in strict mode', () => {
    expect(() => renderTemplate('{{nope}}', ctx)).toThrow(ConfigError);
    expect(() => renderTemplate('{{nope}}', ctx)).toThrow(/Unknown template variable/);
  });

  it('leaves placeholders untouched in non-strict mode', () => {
    expect(renderTemplate('{{nope}}', ctx, { strict: false })).toBe('{{nope}}');
  });

  it('fails clearly when an $env variable is missing', () => {
    expect(() => renderTemplate('{{$env.DEFINITELY_NOT_SET_XYZ}}', ctx)).toThrow(/DEFINITELY_NOT_SET_XYZ/);
  });

  it('serializes objects and arrays as JSON', () => {
    expect(renderTemplate('{{list}}', ctx)).toBe('[1,2]');
    expect(renderTemplate('{{nested}}', ctx)).toBe('{"id":7}');
  });

  it('keeps literal text without placeholders intact', () => {
    expect(renderTemplate('no templates here { } {a}', ctx)).toBe('no templates here { } {a}');
  });
});

describe('renderValue', () => {
  it('deeply renders strings inside nested structures', () => {
    const ctx = { variables: { id: 'u-1' } };
    const input = { url: '/users/{{id}}', headers: { 'x-id': '{{id}}' }, list: ['{{id}}', 5, { deep: 'a-{{id}}' }], count: 2 };
    expect(renderValue(input, ctx)).toEqual({
      url: '/users/u-1',
      headers: { 'x-id': 'u-1' },
      list: ['u-1', 5, { deep: 'a-u-1' }],
      count: 2,
    });
  });
});

describe('resolveExpression', () => {
  it('returns native types for whole-expressions', () => {
    expect(resolveExpression('port', { variables: { port: 8080 } })).toBe(8080);
    expect(resolveExpression('nested', { variables: { nested: { a: 1 } } })).toEqual({ a: 1 });
  });
});

describe('helpers', () => {
  it('detects placeholders', () => {
    expect(hasTemplate('a {{b}} c')).toBe(true);
    expect(hasTemplate('abc')).toBe(false);
    expect(findPlaceholders('{{a}} and {{b.c}}')).toEqual(['a', 'b.c']);
  });
});
