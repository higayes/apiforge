import { describe, expect, it } from 'vitest';
import { getPath, hasPath, parsePath, setPath } from '../../src/util/path.js';

describe('parsePath', () => {
  it('parses dotted paths', () => {
    expect(parsePath('user.name')).toEqual(['user', 'name']);
    expect(parsePath('$.user.name')).toEqual(['user', 'name']);
    expect(parsePath('$')).toEqual([]);
  });

  it('parses bracket indices and quoted keys', () => {
    expect(parsePath('items[0].id')).toEqual(['items', 0, 'id']);
    expect(parsePath('map["a.b"]')).toEqual(['map', 'a.b']);
    expect(parsePath("data['x y']")).toEqual(['data', 'x y']);
  });

  it('rejects malformed paths', () => {
    expect(() => parsePath('a[0')).toThrow(/Unterminated/);
    expect(() => parsePath('a[]')).toThrow(/Empty brackets/);
  });
});

describe('getPath', () => {
  const document = {
    user: { name: 'Ada', roles: ['admin', 'user'] },
    items: [{ id: 1 }, { id: 2 }],
    'weird.key': { value: true },
    nul: null,
  };

  it('resolves nested objects and arrays', () => {
    expect(getPath(document, 'user.name')).toEqual({ found: true, value: 'Ada' });
    expect(getPath(document, 'user.roles[1]')).toEqual({ found: true, value: 'user' });
    expect(getPath(document, 'items[1].id')).toEqual({ found: true, value: 2 });
    expect(getPath(document, 'items.0.id')).toEqual({ found: true, value: 1 });
  });

  it('distinguishes missing paths from present falsy values', () => {
    expect(getPath(document, 'missing')).toEqual({ found: false, value: undefined });
    expect(getPath({ value: false }, 'value')).toEqual({ found: true, value: false });
    expect(getPath({ value: 0 }, 'value')).toEqual({ found: true, value: 0 });
    expect(getPath({ value: '' }, 'value')).toEqual({ found: true, value: '' });
    expect(getPath(document, 'nul')).toEqual({ found: true, value: null });
  });

  it('resolves quoted keys containing dots', () => {
    expect(getPath(document, '["weird.key"].value')).toEqual({ found: true, value: true });
  });

  it('returns not-found for out-of-range indices and type mismatches', () => {
    expect(getPath(document, 'items[5]')).toEqual({ found: false, value: undefined });
    expect(getPath(document, 'user.roles.name')).toEqual({ found: false, value: undefined });
    expect(getPath(null, 'a.b')).toEqual({ found: false, value: undefined });
  });

  it('does not traverse inherited properties', () => {
    expect(getPath({}, 'toString')).toEqual({ found: false, value: undefined });
  });
});

describe('setPath', () => {
  it('sets nested values immutably', () => {
    const original = { a: { b: 1 } };
    const updated = setPath(original, 'a.c', 2);
    expect(updated).toEqual({ a: { b: 1, c: 2 } });
    expect(original).toEqual({ a: { b: 1 } });
  });

  it('creates intermediate containers', () => {
    expect(setPath({}, 'a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
    expect(setPath({}, 'list[0]', 'x')).toEqual({ list: ['x'] });
  });

  it('replaces the root when the path is empty', () => {
    expect(setPath({ a: 1 }, '$', 42)).toBe(42);
  });
});

describe('hasPath', () => {
  it('detects existence independently of value', () => {
    expect(hasPath({ a: undefined }, 'a')).toBe(true);
    expect(hasPath({}, 'a')).toBe(false);
  });
});
