/**
 * Translates a declarative `expect` block into individual assertion results.
 */
import type { AssertionResult, RequestSummary, ResponseSummary } from '../types.js';
import type { ExpectDefinition, HeaderCheck } from '../config/schema.js';
import { formatValue } from '../util/diff.js';
import { testUserPattern } from '../util/safe-regex.js';
import { validateJsonSchema } from './json-schema.js';
import { evaluateJsonPathChecks } from './value-check.js';

export interface AssertionContextData {
  request: RequestSummary;
  response: ResponseSummary;
  /** Parsed JSON body, or undefined when the body is not valid JSON. */
  json: unknown;
  /** Raw response body text (already truncated to a safe size upstream). */
  text: string;
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): { found: boolean; value: string | undefined } {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return { found: true, value };
  }
  return { found: false, value: undefined };
}

function statusAssertions(
  status: number,
  expectation: NonNullable<ExpectDefinition['status']>,
): AssertionResult[] {
  if (typeof expectation === 'number') {
    return [
      {
        target: 'status',
        expression: `status equals ${expectation}`,
        passed: status === expectation,
        expected: expectation,
        actual: status,
        message:
          status === expectation
            ? undefined
            : `expected HTTP ${expectation}, received HTTP ${status}`,
      },
    ];
  }
  if (Array.isArray(expectation)) {
    const passed = expectation.includes(status);
    return [
      {
        target: 'status',
        expression: `status in [${expectation.join(', ')}]`,
        passed,
        expected: expectation,
        actual: status,
        message: passed
          ? undefined
          : `expected HTTP status in [${expectation.join(', ')}], received HTTP ${status}`,
      },
    ];
  }
  if ('in' in expectation) {
    const passed = expectation.in.includes(status);
    return [
      {
        target: 'status',
        expression: `status in [${expectation.in.join(', ')}]`,
        passed,
        expected: expectation.in,
        actual: status,
        message: passed
          ? undefined
          : `expected HTTP status in [${expectation.in.join(', ')}], received HTTP ${status}`,
      },
    ];
  }
  const passed = status >= expectation.min && status <= expectation.max;
  return [
    {
      target: 'status',
      expression: `status between ${expectation.min} and ${expectation.max}`,
      passed,
      expected: [expectation.min, expectation.max],
      actual: status,
      message: passed
        ? undefined
        : `expected HTTP status between ${expectation.min} and ${expectation.max}, received HTTP ${status}`,
    },
  ];
}

function evaluateHeaderCheck(
  headers: Record<string, string>,
  name: string,
  check: HeaderCheck,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const { found, value } = headerValue(headers, name);
  const label = `header ${name}`;

  for (const [operator, expected] of Object.entries(check) as [keyof HeaderCheck, unknown][]) {
    if (expected === undefined) continue;
    if (operator === 'exists') {
      const wantExists = expected !== false;
      results.push({
        target: label,
        expression: `${label} ${wantExists ? 'exists' : 'is absent'}`,
        passed: found === wantExists,
        actual: found ? value : undefined,
        message:
          found === wantExists
            ? undefined
            : wantExists
              ? `expected header "${name}" to be present`
              : `expected header "${name}" to be absent`,
      });
      continue;
    }
    if (!found) {
      results.push({
        target: label,
        expression: `${label} ${operator} ${formatValue(expected)}`,
        passed: false,
        expected,
        message: `expected header "${name}" to be present, but it was absent`,
      });
      continue;
    }
    const actual = value ?? '';
    let passed = false;
    let message: string | undefined;
    switch (operator) {
      case 'equals':
        passed = actual === expected;
        message = passed
          ? undefined
          : `expected header "${name}" to equal ${formatValue(expected)}, got ${formatValue(actual)}`;
        break;
      case 'notEquals':
        passed = actual !== expected;
        message = passed
          ? undefined
          : `expected header "${name}" to differ from ${formatValue(expected)}`;
        break;
      case 'contains':
        passed = actual.includes(String(expected));
        message = passed
          ? undefined
          : `expected header "${name}" to contain ${formatValue(expected)}, got ${formatValue(actual)}`;
        break;
      case 'notContains':
        passed = !actual.includes(String(expected));
        message = passed
          ? undefined
          : `expected header "${name}" not to contain ${formatValue(expected)}`;
        break;
      case 'matches': {
        // User-authored pattern: compiled through the size-bounded,
        // nesting-aware helper so a pathological regex cannot hang the run.
        const outcome = testUserPattern(String(expected), actual);
        if (outcome.reason !== undefined) {
          message = outcome.reason;
          passed = false;
          break;
        }
        passed = outcome.passed;
        message = passed
          ? undefined
          : `expected header "${name}" to match /${String(expected)}/, got ${formatValue(actual)}`;
        break;
      }
      case 'in':
        passed = Array.isArray(expected) && (expected as string[]).includes(actual);
        message = passed
          ? undefined
          : `expected header "${name}" to be one of ${formatValue(expected)}, got ${formatValue(actual)}`;
        break;
      default:
        message = `unsupported header operator "${String(operator)}"`;
    }
    results.push({
      target: label,
      expression: `${label} ${operator} ${formatValue(expected)}`,
      passed,
      expected,
      actual,
      message,
    });
  }

  if (results.length === 0) {
    results.push({
      target: label,
      expression: `${label} has an empty assertion`,
      passed: false,
      message: 'header assertion contains no operators',
    });
  }
  return results;
}

function bodyAssertions(
  body: NonNullable<ExpectDefinition['body']>,
  ctx: AssertionContextData,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const text = ctx.text;

  if (body.equals !== undefined) {
    const expected = body.equals;
    let passed: boolean;
    let message: string | undefined;
    if (typeof expected === 'string') {
      passed = text === expected;
      if (!passed) {
        const trimmedMatches = text.trim() === expected.trim();
        message = trimmedMatches
          ? 'body matches only after trimming surrounding whitespace'
          : `body does not equal the expected text (expected ${expected.length} chars, received ${text.length} chars)`;
      }
    } else {
      const actualJson = ctx.json;
      passed = JSON.stringify(actualJson) === JSON.stringify(expected);
      if (!passed) message = `JSON body does not equal the expected value`;
    }
    results.push({
      target: 'body',
      expression: 'body equals expected value',
      passed,
      expected: typeof expected === 'string' ? expected : JSON.stringify(expected),
      actual: typeof expected === 'string' ? text : JSON.stringify(ctx.json),
      message,
    });
  }

  if (body.notEquals !== undefined) {
    const passed = text !== body.notEquals;
    results.push({
      target: 'body',
      expression: `body does not equal ${formatValue(body.notEquals)}`,
      passed,
      expected: `not ${formatValue(body.notEquals)}`,
      actual: text,
      message: passed ? undefined : 'body equals a value it was expected to differ from',
    });
  }

  if (body.contains !== undefined) {
    const passed = text.includes(body.contains);
    results.push({
      target: 'body',
      expression: `body contains ${formatValue(body.contains)}`,
      passed,
      expected: body.contains,
      message: passed ? undefined : `body does not contain ${formatValue(body.contains)}`,
    });
  }

  if (body.notContains !== undefined) {
    const passed = !text.includes(body.notContains);
    results.push({
      target: 'body',
      expression: `body does not contain ${formatValue(body.notContains)}`,
      passed,
      expected: `not containing ${formatValue(body.notContains)}`,
      message: passed ? undefined : `body unexpectedly contains ${formatValue(body.notContains)}`,
    });
  }

  if (body.matches !== undefined) {
    let passed = false;
    let message: string | undefined;
    // User-authored pattern: bounded and nesting-checked, see safe-regex.ts.
    const outcome = testUserPattern(body.matches, text);
    if (outcome.reason !== undefined) {
      message = outcome.reason;
    } else {
      passed = outcome.passed;
      message = passed
        ? undefined
        : `body does not match /${body.matches}/${outcome.truncated ? ' (input truncated before matching)' : ''}`;
    }
    results.push({
      target: 'body',
      expression: `body matches /${body.matches}/`,
      passed,
      expected: body.matches,
      message,
    });
  }

  if (body.schema !== undefined) {
    try {
      const validation = validateJsonSchema(body.schema, ctx.json);
      results.push({
        target: 'body',
        expression: 'body matches JSON Schema',
        passed: validation.valid,
        message: validation.valid
          ? undefined
          : `schema validation failed:\n${validation.errors.map((entry) => `  • ${entry}`).join('\n')}`,
      });
    } catch (error) {
      results.push({
        target: 'body',
        expression: 'body matches JSON Schema',
        passed: false,
        message: (error as Error).message,
      });
    }
  }

  return results;
}

/**
 * Evaluate an `expect` block against a response.
 * An empty/omitted expect block produces no assertions (the request still ran).
 */
export function evaluateExpect(
  expect: ExpectDefinition | undefined,
  ctx: AssertionContextData,
): AssertionResult[] {
  if (!expect) return [];
  const results: AssertionResult[] = [];

  if (expect.status !== undefined)
    results.push(...statusAssertions(ctx.response.status, expect.status));

  if (expect.statusText !== undefined) {
    const passed = ctx.response.statusText === expect.statusText;
    results.push({
      target: 'statusText',
      expression: `status text equals ${formatValue(expect.statusText)}`,
      passed,
      expected: expect.statusText,
      actual: ctx.response.statusText,
      message: passed
        ? undefined
        : `expected status text ${formatValue(expect.statusText)}, got ${formatValue(ctx.response.statusText)}`,
    });
  }

  if (expect.headers) {
    for (const [name, check] of Object.entries(expect.headers)) {
      results.push(...evaluateHeaderCheck(ctx.response.headers, name, check));
    }
  }

  if (expect.jsonPath) {
    if (ctx.json === undefined) {
      results.push({
        target: 'json',
        expression: 'response body is JSON',
        passed: false,
        message: `cannot evaluate jsonPath assertions: response is not valid JSON${ctx.response.jsonParseError ? ` (${ctx.response.jsonParseError})` : ''}`,
      });
    } else {
      results.push(...evaluateJsonPathChecks(ctx.json, expect.jsonPath));
    }
  }

  if (expect.body) results.push(...bodyAssertions(expect.body, ctx));

  if (expect.time) {
    const duration = ctx.response.durationMs;
    if (expect.time.lessThan !== undefined) {
      const limit = Number(expect.time.lessThan);
      if (!Number.isFinite(limit)) {
        results.push({
          target: 'time',
          expression: `response time < ${String(expect.time.lessThan)}ms`,
          passed: false,
          expected: `< ${String(expect.time.lessThan)}ms`,
          actual: `${duration}ms`,
          message: `the "lessThan" limit must be a number, got ${String(expect.time.lessThan)} (unresolved template?)`,
        });
      } else {
        const passed = duration < limit;
        results.push({
          target: 'time',
          expression: `response time < ${limit}ms`,
          passed,
          expected: `< ${limit}ms`,
          actual: `${duration}ms`,
          message: passed
            ? undefined
            : `response took ${duration}ms, expected less than ${limit}ms`,
        });
      }
    }
    if (expect.time.moreThan !== undefined) {
      const limit = Number(expect.time.moreThan);
      if (!Number.isFinite(limit)) {
        results.push({
          target: 'time',
          expression: `response time > ${String(expect.time.moreThan)}ms`,
          passed: false,
          expected: `> ${String(expect.time.moreThan)}ms`,
          actual: `${duration}ms`,
          message: `the "moreThan" limit must be a number, got ${String(expect.time.moreThan)} (unresolved template?)`,
        });
      } else {
        const passed = duration > limit;
        results.push({
          target: 'time',
          expression: `response time > ${limit}ms`,
          passed,
          expected: `> ${limit}ms`,
          actual: `${duration}ms`,
          message: passed
            ? undefined
            : `response took ${duration}ms, expected more than ${limit}ms`,
        });
      }
    }
  }

  return results;
}
