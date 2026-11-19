/**
 * Structural shape inference for contract/schema regression testing.
 *
 * A "shape" captures the type skeleton of a JSON document (object keys, array
 * element types, nullability) without values. Comparing shapes across runs
 * detects breaking API changes such as removed fields or changed types while
 * remaining tolerant of volatile data (ids, timestamps, counters).
 */
import type { ShapeChange, ShapeNode } from '../types.js';

const MAX_DEPTH = 32;
const MAX_KEYS = 500;
const MAX_SAMPLE_ITEMS = 50;

function typeOf(value: unknown): ShapeNode['type'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

export function inferShape(value: unknown, depth = 0): ShapeNode {
  const type = typeOf(value);
  if (depth > MAX_DEPTH) return { type: 'unknown' };
  if (type === 'array') {
    const items = value as unknown[];
    const elementShapes = items.slice(0, MAX_SAMPLE_ITEMS).map((item) => inferShape(item, depth + 1));
    return { type: 'array', ...(elementShapes.length > 0 ? { element: mergeShapes(elementShapes) } : {}) };
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const properties: Record<string, ShapeNode> = {};
    const keys = Object.keys(record).slice(0, MAX_KEYS);
    for (const key of keys) properties[key] = inferShape(record[key], depth + 1);
    return { type: 'object', properties };
  }
  return { type };
}

/** Merge multiple element shapes into a single node (nullability aware). */
export function mergeShapes(shapes: ShapeNode[]): ShapeNode {
  if (shapes.length === 0) return { type: 'unknown' };
  const nonNull = shapes.filter((shape) => shape.type !== 'null');
  const nullable = nonNull.length !== shapes.length;
  if (nonNull.length === 0) return { type: 'null' };
  if (nonNull.length === 1) {
    const only = nonNull[0] as ShapeNode;
    return nullable ? { ...only, nullable: true } : only;
  }

  const types = new Set(nonNull.map((shape) => shape.type));
  if (types.size === 1) {
    const only = nonNull[0] as ShapeNode;
    if (only.type === 'object') {
      const keys = new Set<string>();
      for (const shape of nonNull) for (const key of Object.keys(shape.properties ?? {})) keys.add(key);
      const properties: Record<string, ShapeNode> = {};
      for (const key of keys) {
        const candidates: ShapeNode[] = [];
        for (const shape of nonNull) {
          const property = shape.properties?.[key];
          candidates.push(property ?? { type: 'null' });
        }
        properties[key] = mergeShapes(candidates);
      }
      return { type: 'object', properties, ...(nullable ? { nullable: true } : {}) };
    }
    if (only.type === 'array') {
      const elements = nonNull.map((shape) => shape.element).filter((shape): shape is ShapeNode => shape !== undefined);
      return {
        type: 'array',
        ...(elements.length > 0 ? { element: mergeShapes(elements) } : {}),
        ...(nullable ? { nullable: true } : {}),
      };
    }
    return { ...only, ...(nullable ? { nullable: true } : {}) };
  }
  return { type: 'unknown', ...(nullable ? { nullable: true } : {}) };
}

function describeNode(node: ShapeNode | undefined): string {
  if (!node) return 'missing';
  return node.nullable ? `${node.type} | null` : node.type;
}

export function diffShapes(baseline: ShapeNode, current: ShapeNode, basePath = '$', out: ShapeChange[] = []): ShapeChange[] {
  if (baseline.type !== current.type) {
    // nullability changes on an otherwise identical branch are non-breaking.
    if (baseline.nullable || current.nullable) {
      const bareA = { ...baseline, nullable: false };
      const bareB = { ...current, nullable: false };
      if (bareA.type === bareB.type) return out;
    }
    out.push({ path: basePath, change: 'type-changed', before: describeNode(baseline), after: describeNode(current) });
    return out;
  }

  if (baseline.type === 'object') {
    const baselineProps = baseline.properties ?? {};
    const currentProps = current.properties ?? {};
    for (const key of Object.keys(baselineProps)) {
      const path = `${basePath}.${key}`;
      const before = baselineProps[key];
      const after = currentProps[key];
      if (after === undefined) {
        out.push({ path, change: 'removed', before: describeNode(before) });
      } else if (before) {
        diffShapes(before, after, path, out);
      }
    }
    for (const key of Object.keys(currentProps)) {
      if (baselineProps[key] === undefined) {
        out.push({ path: `${basePath}.${key}`, change: 'added', after: describeNode(currentProps[key]) });
      }
    }
    return out;
  }

  if (baseline.type === 'array' && baseline.element && current.element) {
    diffShapes(baseline.element, current.element, `${basePath}[]`, out);
  }
  return out;
}

/**
 * Breaking changes are removed fields and changed types. Additions and
 * nullability widening are reported but remain compatible.
 */
export function isCompatible(changes: ShapeChange[]): boolean {
  return !changes.some((change) => change.change === 'removed' || change.change === 'type-changed');
}
