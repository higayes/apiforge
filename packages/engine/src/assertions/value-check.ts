/**
 * Assertion evaluation.
 *
 * Every assertion produces an `AssertionResult` with the target path, the
 * expression in a readable form, the expected/actual values and — on failure —
 * an actionable message (including structural diffs for objects).
 */
import type { AssertionResult } from '../types.js';
import { formatValue, summarizeValueDiff } from '../util/diff.js';
import { getPath } from '../util/path.js';
import { validateJsonSchema } from './json-schema.js';
import type { ValueCheck } from '../config/schema.js';

const OPERATOR_KEYS = new Set([
  'equals','notEquals','exists','type','matches','min','max','gt','gte','lt','lte',
  'length','minLength','maxLength','in','notIn','contains','notContains','every','some','schema',
]);

/**
 * Accept the ergonomic shorthands the YAML format allows when this API is used
 * directly: scalars and plain objects become `{ equals: value }`. An empty
 * object stays an error so typos in operator names surface immediately.
 */
export function normalizeCheck(input: unknown): ValueCheck {
  if (input === null) return { equals: null };
  if (typeof input !== 'object') return { equals: input };
  if (Array.isArray(input)) return { equals: input };
  const keys = Object.keys(input as object);
  if (keys.length === 0) return {};
  if (keys.some((key) => OPERATOR_KEYS.has(key))) return input as ValueCheck;
  return { equals: input };
}

const OPERATOR_LABELS: Record<string, string> = {
  equals: 'equals',
  notEquals: 'not equals',
  exists: 'exists',
  type: 'is type',
  matches: 'matches',
  min: '>=',
  max: '<=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  length: 'length ==',
  minLength: 'length >=',
  maxLength: 'length <=',
  in: 'is one of',
  notIn: 'is none of',
  contains: 'contains',
  notContains: 'does not contain',
  every: 'every item matches',
  some: 'some item matches',
  schema: 'matches schema',
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(type: NonNullable<ValueCheck['type']>, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function lengthOf(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return undefined;
}

function evaluateOperator(
  operator: string,
  expected: unknown,
  result: { found: boolean; value: unknown },
): { passed: boolean; message?: string } {
  const { found, value } = result;

  if (operator === 'exists') {
    const wantExists = expected !== false;
    const exists = found;
    return {
      passed: exists === wantExists,
      message: exists === wantExists ? undefined : wantExists ? 'expected the value to exist, but it was missing' : 'expected the value to be missing, but it exists',
    };
  }

  if (!found) {
    return { passed: false, message: 'value is missing at this path' };
  }

  switch (operator) {
    case 'equals':
      if (!deepEqual(value, expected)) {
        const structural = expected !== null && typeof expected === 'object' ? summarizeValueDiff(expected, value) : undefined;
        return {
          passed: false,
          message: structural
            ? `expected ${formatValue(expected)}, got ${formatValue(value)}\n${structural}`
            : `expected ${formatValue(expected)}, got ${formatValue(value)}`,
        };
      }
      return { passed: true };

    case 'notEquals':
      return deepEqual(value, expected)
        ? { passed: false, message: `expected a value different from ${formatValue(expected)}` }
        : { passed: true };

    case 'type':
      return typeMatches(expected as NonNullable<ValueCheck['type']>, value)
        ? { passed: true }
        : { passed: false, message: `expected type "${String(expected)}", got "${describeType(value)}"` };

    case 'matches': {
      let regex: RegExp;
      try {
        regex = new RegExp(String(expected), 'u');
      } catch (error) {
        return { passed: false, message: `invalid regular expression: ${(error as Error).message}` };
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return regex.test(text)
        ? { passed: true }
        : { passed: false, message: `${formatValue(value)} does not match /${String(expected)}/` };
    }

    case 'min':
    case 'max':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const allowsLength = operator === 'min' || operator === 'max';
      const actual = typeof value === 'number' ? value : allowsLength ? lengthOf(value) : undefined;
      if (actual === undefined) {
        return {
          passed: false,
          message: `cannot compare a value of type "${describeType(value)}" numerically (expected a number${allowsLength ? ' or a sized value' : ''})`,
        };
      }
      const limit = Number(expected);
      const passed =
        operator === 'min' || operator === 'gte'
          ? actual >= limit
          : operator === 'max' || operator === 'lte'
            ? actual <= limit
            : operator === 'gt'
              ? actual > limit
              : actual < limit;
      return passed
        ? { passed: true }
        : { passed: false, message: `expected ${operator === 'min' ? '>= ' : operator === 'max' ? '<= ' : `${OPERATOR_LABELS[operator]} `}${limit}, got ${actual}` };
    }

    case 'length':
    case 'minLength':
    case 'maxLength': {
      const actual = lengthOf(value);
      if (actual === undefined) {
        return { passed: false, message: `value of type "${describeType(value)}" has no length` };
      }
      const limit = Number(expected);
      const passed =
        operator === 'length' ? actual === limit : operator === 'minLength' ? actual >= limit : actual <= limit;
      const expectation =
        operator === 'length' ? `length ${limit}` : operator === 'minLength' ? `length >= ${limit}` : `length <= ${limit}`;
      return passed ? { passed: true } : { passed: false, message: `expected ${expectation}, got ${actual}` };
    }

    case 'in':
    case 'notIn': {
      const list = Array.isArray(expected) ? expected : [expected];
      const present = list.some((entry) => deepEqual(entry, value));
      const passed = operator === 'in' ? present : !present;
      return passed
        ? { passed: true }
        : { passed: false, message: `expected value ${operator === 'in' ? 'to be one of' : 'not to be in'} ${formatValue(list)}, got ${formatValue(value)}` };
    }

    case 'contains':
      {
        const contained = typeof value === 'string' ? value.includes(String(expected)) : Array.isArray(value) ? value.some((entry) => deepEqual(entry, expected)) : deepEqual(value, expected);
        return contained ? { passed: true } : { passed: false, message: `${formatValue(value)} does not contain ${formatValue(expected)}` };
      }

    case 'notContains':
      {
        const contained = typeof value === 'string' ? value.includes(String(expected)) : Array.isArray(value) ? value.some((entry) => deepEqual(entry, expected)) : false;
        return contained ? { passed: false, message: `${formatValue(value)} unexpectedly contains ${formatValue(expected)}` } : { passed: true };
      }

    default:
      return { passed: false, message: `unsupported operator "${operator}"` };
  }
}

/**
 * Evaluate a `ValueCheck`-style object against an already resolved value.
 * Used for JSON-path checks, captured values and array element checks.
 */
export function evaluateValueCheck(
  target: string,
  rawCheck: ValueCheck | unknown,
  resolved: { found: boolean; value: unknown },
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const check = normalizeCheck(rawCheck);
  const entries = Object.entries(check) as [string, unknown][];

  for (const [operator, expected] of entries) {
    if (expected === undefined) continue;

    if (operator === 'every' || operator === 'some') {
      const value = resolved.value;
      const expression = `${target} ${OPERATOR_LABELS[operator]} ${JSON.stringify(expected)}`;
      if (!resolved.found || !Array.isArray(value)) {
        results.push({
          target,
          expression,
          passed: false,
          message: `expected an array at ${target}, got ${describeType(value)}`,
        });
        continue;
      }
      const selector = normalizeCheck(expected);
      const perItem = value.map((item, itemIndex) =>
        evaluateValueCheck(`${target}[${itemIndex}]`, selector, { found: true, value: item }),
      );
      const itemPassed = perItem.map((itemResults) => itemResults.every((entry) => entry.passed));
      const passed = operator === 'every' ? itemPassed.every(Boolean) : itemPassed.some(Boolean);
      const children =
        operator === 'every'
          ? perItem.filter((_entry, itemIndex) => !itemPassed[itemIndex]).flat()
          : passed
            ? undefined
            : (perItem[0] ?? []);
      results.push({
        target,
        expression,
        passed,
        ...(children && children.length > 0 ? { children } : {}),
        message: passed
          ? undefined
          : operator === 'every'
            ? `not every item matched (${itemPassed.filter(Boolean).length}/${value.length} passed)`
            : `no item matched ${JSON.stringify(expected)}`,
      });
      continue;
    }

    if (operator === 'schema') {
      const schema = expected as Record<string, unknown>;
      const expression = `${target} matches JSON Schema`;
      if (!resolved.found) {
        results.push({ target, expression, passed: false, message: 'value is missing at this path' });
        continue;
      }
      try {
        const validation = validateJsonSchema(schema, resolved.value);
        results.push({
          target,
          expression,
          passed: validation.valid,
          actual: validation.valid ? undefined : resolved.value,
          message: validation.valid ? undefined : `schema validation failed:\n${validation.errors.map((entry) => `  • ${entry}`).join('\n')}`,
        });
      } catch (error) {
        results.push({ target, expression, passed: false, message: (error as Error).message });
      }
      continue;
    }

    const outcome = evaluateOperator(operator, expected, resolved);
    results.push({
      target,
      expression: `${target} ${OPERATOR_LABELS[operator] ?? operator} ${formatValue(expected)}`,
      passed: outcome.passed,
      expected,
      actual: resolved.found ? resolved.value : undefined,
      message: outcome.message,
    });
  }

  if (entries.length === 0) {
    results.push({
      target,
      expression: `${target} has an empty assertion`,
      passed: false,
      message: 'assertion object contains no operators',
    });
  }

  return results;
}

export function evaluateJsonPathChecks(
  body: unknown,
  checks: Record<string, ValueCheck>,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  for (const [path, check] of Object.entries(checks)) {
    const resolved = getPath(body, path);
    results.push(...evaluateValueCheck(`$.${path.replace(/^\$?\.?/, '')}`, check, resolved));
  }
  return results;
}
