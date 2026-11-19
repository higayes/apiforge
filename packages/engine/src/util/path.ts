/**
 * Small helpers for reading/writing dotted paths (`a.b[0].c`) used by JSON
 * assertions, captures and template expressions.
 */

export interface PathResult {
  found: boolean;
  value: unknown;
}

type Segment = string | number;

/** Split a path like `$.a.b[0]["weird.key"]` into segments. */
export function parsePath(path: string): Segment[] {
  let input = path.trim();
  if (input.startsWith('$')) input = input.slice(1);
  if (input.startsWith('.')) input = input.slice(1);
  if (input === '') return [];

  const segments: Segment[] = [];
  let current = '';
  let i = 0;
  const pushCurrent = (): void => {
    if (current !== '') {
      segments.push(current);
      current = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];
    if (ch === '.') {
      pushCurrent();
      i += 1;
    } else if (ch === '[') {
      pushCurrent();
      const close = input.indexOf(']', i);
      if (close === -1) {
        throw new Error(`Unterminated bracket in path "${path}"`);
      }
      const inner = input.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === '') throw new Error(`Empty brackets in path "${path}"`);
      const quoted =
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"));
      if (quoted) {
        segments.push(inner.slice(1, -1));
      } else if (/^-?\d+$/.test(inner)) {
        segments.push(Number.parseInt(inner, 10));
      } else {
        // Bare word inside brackets, e.g. [name]
        segments.push(inner);
      }
    } else if (ch === ']') {
      throw new Error(`Unexpected "]" in path "${path}"`);
    } else {
      current += ch;
      i += 1;
    }
  }
  pushCurrent();
  return segments;
}

/** Resolve a dotted path against a value. Distinguishes "missing" from "undefined". */
export function getPath(root: unknown, path: string): PathResult {
  let segments: Segment[];
  try {
    segments = parsePath(path);
  } catch {
    return { found: false, value: undefined };
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return { found: false, value: undefined };
      if (segment < 0 || segment >= current.length) return { found: false, value: undefined };
      current = current[segment];
    } else {
      if (current === null || typeof current !== 'object')
        return { found: false, value: undefined };
      if (Array.isArray(current)) {
        // Allow numeric string segments on arrays for convenience: items.0.id
        if (/^\d+$/.test(segment)) {
          const index = Number.parseInt(segment, 10);
          if (index >= current.length) return { found: false, value: undefined };
          current = current[index];
          continue;
        }
        return { found: false, value: undefined };
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

/** Set a value at a dotted path, creating intermediate objects. Returns a new copy. */
export function setPath<T>(root: T, path: string, value: unknown): T {
  const segments = parsePath(path);
  if (segments.length === 0) return value as T;
  const clone: unknown = structuredCloneSafe(root);
  let cursor = clone as Record<string | number, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as Segment;
    const next = cursor[segment];
    if (next === null || typeof next !== 'object') {
      cursor[segment] = typeof segments[i + 1] === 'number' ? [] : {};
    }
    cursor = cursor[segment] as Record<string | number, unknown>;
  }
  cursor[segments[segments.length - 1] as Segment] = value;
  return clone as T;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON clone for non-cloneable values.
    }
  }
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** True when the path exists (even if its value is `undefined`). */
export function hasPath(root: unknown, path: string): boolean {
  return getPath(root, path).found;
}
