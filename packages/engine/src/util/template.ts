/**
 * Minimal `{{...}}` template engine used for URLs, headers, bodies, assertions
 * and environment files.
 *
 * Supported expressions:
 *   {{variable}}            → variable / environment variable / secret / step capture
 *   {{steps.createUser.json.id}} → post-response capture from a previous test
 *   {{$env.NAME}}           → process environment variable (explicit namespace)
 *   {{$random.uuid}}        → dynamic helpers: uuid, int(min,max), string(n), hex(n)
 *   {{$now.iso}} | {{$now.unix}} | {{$now.ms}}
 *
 * Unknown variables fail loudly in strict mode (default) instead of silently
 * producing broken requests.
 */
import { ConfigError } from '../errors.js';
import { getPath } from './path.js';

export interface TemplateContext {
  variables: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  steps?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  now?: Date;
}

export interface RenderOptions {
  strict?: boolean;
  /** Disable `$random`/`$now` helpers (used when tests must be deterministic). */
  builtins?: boolean;
}

export interface RenderIssue {
  expression: string;
}

/**
 * Placeholder pattern.
 *
 * SECURITY: this must stay free of nested quantifiers. The previous form
 * `/\{\{\s*([^{}]+?)\s*\}\}/g` had three quantifiers that could each consume the
 * same run of whitespace, so a truncated opener such as `'{{{{' + ' '.repeat(n)`
 * forced the engine to retry every split of that run — O(n²) backtracking, which
 * measured 308 s for n = 10 000 (CodeQL js/polynomial-redos).
 *
 * `[^{}]+` is the only quantifier: the exclusion of braces makes each consumed
 * character unique, so backtracking cannot cascade. Surrounding whitespace is
 * stripped from the capture at the call sites instead, which yields the exact
 * same expressions as before (verified by an exhaustive equality fuzz over
 * ~950 k inputs; see tests/util/template.test.ts).
 */
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

const randomInt = (min: number, max: number): number => {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
};

const randomHex = (length: number): string => {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, length);
};

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const randomString = (length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += RANDOM_ALPHABET.charAt(Math.floor(Math.random() * RANDOM_ALPHABET.length));
  }
  return out;
};

function resolveBuiltin(expression: string, now: Date): { handled: boolean; value?: unknown } {
  if (expression === '$random.uuid') return { handled: true, value: crypto.randomUUID() };
  if (expression === '$now.iso') return { handled: true, value: now.toISOString() };
  if (expression === '$now.unix') return { handled: true, value: Math.floor(now.getTime() / 1000) };
  if (expression === '$now.ms') return { handled: true, value: now.getTime() };

  const intMatch = /^\$random\.int\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(expression);
  if (intMatch) {
    const min = Number.parseInt(intMatch[1] as string, 10);
    const max = Number.parseInt(intMatch[2] as string, 10);
    return { handled: true, value: randomInt(Math.min(min, max), Math.max(min, max)) };
  }
  const stringMatch = /^\$random\.string\(\s*(\d+)\s*\)$/.exec(expression);
  if (stringMatch) {
    return {
      handled: true,
      value: randomString(Math.min(1024, Number.parseInt(stringMatch[1] as string, 10))),
    };
  }
  const hexMatch = /^\$random\.hex\(\s*(\d+)\s*\)$/.exec(expression);
  if (hexMatch) {
    return {
      handled: true,
      value: randomHex(Math.min(1024, Number.parseInt(hexMatch[1] as string, 10))),
    };
  }
  return { handled: false };
}

function stringifyValue(value: unknown): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function resolveExpression(
  expression: string,
  ctx: TemplateContext,
  options: RenderOptions = {},
): unknown {
  const builtinsEnabled = options.builtins !== false;
  const now = ctx.now ?? new Date();

  if (builtinsEnabled) {
    const builtin = resolveBuiltin(expression, now);
    if (builtin.handled) return builtin.value;
  }

  if (expression.startsWith('$env.')) {
    const name = expression.slice('$env.'.length);
    const fromCtx = ctx.env?.[name];
    const value = fromCtx !== undefined ? fromCtx : process.env[name];
    if (value === undefined) {
      if (options.strict === false) return undefined;
      throw new ConfigError(`Environment variable "${name}" is not set`, [
        `Referenced by template {{${expression}}}`,
      ]);
    }
    return value;
  }

  const scopes: Record<string, unknown>[] = [];
  if (ctx.secrets) scopes.push({ secrets: ctx.secrets, ...ctx.secrets });
  if (ctx.variables) scopes.push(ctx.variables);
  if (ctx.steps) scopes.push({ steps: ctx.steps });

  // Most specific scope wins: steps > variables > secrets/environment.
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i] as Record<string, unknown>;
    const direct = getPath(scope, expression);
    if (direct.found && direct.value !== undefined) return direct.value;
  }
  return undefined;
}

export function renderTemplate(
  input: string,
  ctx: TemplateContext,
  options: RenderOptions = {},
): string {
  const strict = options.strict !== false;
  if (!input.includes('{{')) return input;

  return input.replace(PLACEHOLDER, (match, rawExpression: string) => {
    const expression = rawExpression.trim();
    if (expression === '') return match;
    let value: unknown;
    try {
      value = resolveExpression(expression, ctx, options);
    } catch (error) {
      if (strict) throw error;
      return match;
    }
    if (value === undefined) {
      if (strict) {
        throw new ConfigError(`Unknown template variable "{{${expression}}}"`, [
          'Define it in `variables`, the environment file, capture it from a previous test, or use `$env.NAME` for environment variables.',
        ]);
      }
      return match;
    }
    return stringifyValue(value);
  });
}

/** Deeply render every string value inside an object/array (keys are preserved). */
export function renderValue<T>(value: T, ctx: TemplateContext, options: RenderOptions = {}): T {
  if (typeof value === 'string') return renderTemplate(value, ctx, options) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => renderValue(entry, ctx, options)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderValue(entry, ctx, options);
    }
    return out as T;
  }
  return value;
}

/** A whole-string placeholder: same rationale as `PLACEHOLDER` (no nested quantifiers). */
const SINGLE_PLACEHOLDER = /^\{\{([^{}]+)\}\}$/;

/**
 * Like `renderValue`, but a string consisting of *exactly one* placeholder keeps
 * the resolved value's native type:
 *
 *   expect: { id: "{{userId}}" }   // data row userId = 1  → number 1, not "1"
 *
 * This is what makes data-driven suites work with numbers and booleans: a CSV
 * column is a string, but `equals: "{{userId}}"` must compare like a number
 * when the reference holds one. Mixed strings ("prefix-{{id}}") still
 * interpolate to text, which is the only sensible result.
 */
export function renderTypedValue<T>(
  value: T,
  ctx: TemplateContext,
  options: RenderOptions = {},
): T {
  if (typeof value === 'string') {
    const single = SINGLE_PLACEHOLDER.exec(value);
    if (single) {
      const expression = (single[1] ?? '').trim();
      if (expression !== '') {
        try {
          const resolved = resolveExpression(expression, ctx, options);
          if (resolved !== undefined) return resolved as T;
          if (options.strict !== false) {
            throw new ConfigError(`Unknown template variable "{{${expression}}}"`, [
              'Define it in `variables`, the environment file, capture it from a previous test, or use `$env.NAME` for environment variables.',
            ]);
          }
        } catch (error) {
          if (options.strict !== false || error instanceof ConfigError) throw error;
        }
      }
    }
    return renderTemplate(value, ctx, options) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTypedValue(entry, ctx, options)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderTypedValue(entry, ctx, options);
    }
    return out as T;
  }
  return value;
}

/** True when a string contains at least one template placeholder. */
export function hasTemplate(input: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(input);
}

/** List unresolved `{{...}}` expressions inside a rendered string (diagnostics). */
export function findPlaceholders(input: string): string[] {
  const found: string[] = [];
  for (const match of input.matchAll(PLACEHOLDER)) {
    const expression = (match[1] ?? '').trim();
    if (expression) found.push(expression);
  }
  return found;
}
