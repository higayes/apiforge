/**
 * Environment-variable interpolation for configuration files.
 *
 * A second, deliberately tiny syntax lives beside the `{{...}}` template engine
 * because the two solve different problems:
 *
 *   apiforge.yaml / environments/*.yaml   ${VAR}          — process environment
 *   suites/*.suite.yaml                   {{variable}}    — suite data
 *
 * Configuration is read *before* any suite context exists, so `${...}` is
 * resolved at load time and must not depend on test state. It is common in
 * Docker/CI/12-factor setups and is safe by default:
 *
 *   ${API_URL}                 required — fails with an actionable error if unset
 *   ${API_URL:-http://localhost:4010}   fallback when unset *or* empty
 *   ${API_URL-http://localhost:4010}    fallback only when unset
 *   ${TOKEN:?a token is required}       required, custom error message
 *   $${LITERAL}                escapes to the literal text `${LITERAL}`
 *
 * Unset required variables never fall through silently as the empty string:
 * a missing base URL would otherwise produce requests to `""` and confusing
 * network errors far from the cause.
 */
import { ConfigError } from '../errors.js';

const PLACEHOLDER = /\$\$?\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\?)([^}]*))?\}/g;

export interface ExpandEnvOptions {
  /** Environment to read from (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * Treat every `${X}` as required and throw when `X` is unset. Default: true.
   * Batch-mutation tools may pass false to inspect files without a shell.
   */
  strict?: boolean;
}

export interface ExpandEnvResult {
  value: string;
  /** Names that were read from the environment, in order of appearance. */
  used: string[];
  /** Names relied on the fallback/default. */
  defaulted: string[];
}

/**
 * Expand `${...}` placeholders in a single string.
 * Throws `ConfigError` with the variable name and available fallback guidance.
 */
export function expandEnvString(input: string, options: ExpandEnvOptions = {}): ExpandEnvResult {
  const env = options.env ?? process.env;
  const strict = options.strict !== false;
  const used: string[] = [];
  const defaulted: string[] = [];

  const value = input.replace(
    PLACEHOLDER,
    (match: string, name: string, operator?: string, fallback?: string) => {
      // `$${X}` is an escape for a literal `${X}`.
      if (match.startsWith('$$')) return match.slice(1);

      const current = env[name];
      const isSet = current !== undefined;
      const isNonEmpty = isSet && current !== '';

      used.push(name);

      switch (operator) {
        case ':-':
          if (isNonEmpty) return current as string;
          defaulted.push(name);
          return fallback ?? '';
        case '-':
          if (isSet) return current as string;
          defaulted.push(name);
          return fallback ?? '';
        case ':?':
          if (isNonEmpty) return current as string;
          throw new ConfigError(
            `Environment variable "${name}" is required: ${fallback || 'not set'}`,
            [
              `Set it before running APIFORGE, or provide a default with \${${name}:-value}.`,
              `Referenced by: ${match}`,
            ],
          );
        default:
          if (isNonEmpty) return current as string;
          if (!strict) return '';
          throw new ConfigError(`Environment variable "${name}" is not set`, [
            `Defined in ${'`'}${match}${'`'} — set it in your shell or CI, or add a default: \${${name}:-some-default}`,
          ]);
      }
    },
  );

  return { value, used, defaulted };
}

/** Deeply expand `${...}` in every string value of a configuration document. */
export function expandEnvDeep<T>(value: T, options: ExpandEnvOptions = {}): T {
  if (typeof value === 'string') {
    const expanded = expandEnvString(value, options);
    // Return the raw string when nothing was substituted, to keep identity.
    return (expanded.used.length === 0 ? value : expanded.value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvDeep(entry, options)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandEnvDeep(entry, options);
    }
    return out as T;
  }
  return value;
}

/** List the environment variables a document depends on (for `env validate`). */
export function findEnvReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) {
      if (match[0].startsWith('$$')) continue;
      const name = match[1];
      if (name) found.add(name);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) findEnvReferences(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      findEnvReferences(entry, found);
    }
  }
  return found;
}
