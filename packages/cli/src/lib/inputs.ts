/**
 * Resolution of CLI inputs shared across commands: variable/secret parsing,
 * target URLs, headers, bodies, environment selection and report options.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ConfigError,
  UsageError,
  type BodyDefinition,
  type EnvironmentDefinition,
  type PerformanceSpec,
  type SecuritySpec,
  type ContractSpec,
  type TestDefinition,
  parseDocument,
  parseEnvironmentDocument,
  parsePerformanceDocument,
  parseSecurityDocument,
  parseContractDocument,
  parseProjectDocument,
} from '@apiforge/engine';

export interface KeyValuePair {
  key: string;
  value: string;
}

/**
 * Parse `key=value` pairs from repeated flags (`--var a=1 --var b=2`) and/or a
 * comma-separated list (`--var a=1,b=2`). Values may contain `=` and commas
 * when quoted by the shell as separate arguments.
 */
export function parseKeyValuePairs(
  entries: string[] | undefined,
  flagName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!entries) return out;
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new UsageError(`Invalid ${flagName} value: empty entry`);
    }
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`Invalid ${flagName} value "${entry}"`, [
        `Expected the form ${flagName === '--var' ? 'key=value' : 'NAME=value'}`,
      ]);
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (key === '') throw new UsageError(`Invalid ${flagName} value "${entry}": the key is empty`);
    out[key] = value;
  }
  return out;
}

/**
 * Parse `-H` / `--header` values.
 *
 * Both conventional spellings are accepted: curl's `Name: value` (what people
 * copy from README examples and Postman) and the unambiguous `Name=value`.
 * A header name can never contain `:`, but it can contain `=`, so the colon
 * form is only used when no `=` appears before the first colon.
 */
export function parseHeaders(entries: string[] | undefined): Record<string, string> {
  if (!entries || entries.length === 0) return {};
  const normalized = entries.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const colon = entry.indexOf(':');
    if (colon <= 0) return entry; // no colon: leave for the NAME=value parser
    const equals = entry.indexOf('=');
    if (equals !== -1 && equals < colon) return entry; // `a=b:c` is NAME=value
    const name = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).trim();
    if (name === '') return entry;
    return `${name}=${value}`;
  });
  return parseKeyValuePairs(normalized, '--header');
}

export function parseTimeout(
  value: string | undefined,
  flagName = '--timeout',
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 600_000) {
    throw new UsageError(`Invalid ${flagName} value "${value}"`, [
      'Expected a positive number of milliseconds (max 600000).',
    ]);
  }
  return Math.round(parsed);
}

export function parseIntInRange(
  value: string | undefined,
  flagName: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`Invalid ${flagName} value "${value}"`, [
      `Expected an integer between ${min} and ${max}.`,
    ]);
  }
  return parsed;
}

export function parseNumberInRange(
  value: string | undefined,
  flagName: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`Invalid ${flagName} value "${value}"`, [
      `Expected a number between ${min} and ${max}.`,
    ]);
  }
  return parsed;
}

export function assertHttpUrl(rawUrl: string, flagName = 'target'): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError(`Invalid ${flagName} URL "${rawUrl}"`, [
      'Provide a full URL such as https://api.example.com/health',
    ]);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`Unsupported protocol "${url.protocol}" in ${flagName}`, [
      'Only http:// and https:// URLs are supported.',
    ]);
  }
  return url.toString();
}

export async function readJsonFileInput<T>(path: string, label: string): Promise<T> {
  const absolute = resolve(path);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') throw new ConfigError(`${label} not found: ${path}`);
    if (code === 'EISDIR') throw new ConfigError(`${label} is a directory: ${path}`);
    throw new ConfigError(`Could not read ${label}: ${path}`, [String((error as Error).message)]);
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${path}`, [
      String((error as Error).message),
    ]);
  }
}

/** Load a JSON/YAML *input* document (performance/security/contract specs, project file). */
export async function readStructuredInput(path: string, label: string): Promise<unknown> {
  const absolute = resolve(path);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') throw new ConfigError(`${label} not found: ${path}`);
    if (code === 'EISDIR') throw new ConfigError(`${label} is a directory: ${path}`);
    throw new ConfigError(`Could not read ${label}: ${path}`, [String((error as Error).message)]);
  }
  return parseDocument(content, absolute);
}

export interface BodyInputOptions {
  body?: string;
  bodyFile?: string;
  form?: string[];
  json?: boolean;
}

/** Build a `BodyDefinition` from `--body`, `--body-file` and `--form` flags. */
export async function resolveBody(options: BodyInputOptions): Promise<BodyDefinition | undefined> {
  const provided = [
    options.body !== undefined,
    options.bodyFile !== undefined,
    (options.form?.length ?? 0) > 0,
  ].filter(Boolean);
  if (provided.length > 1) {
    throw new UsageError('Only one of --body, --body-file and --form may be used');
  }
  if (options.form && options.form.length > 0) {
    return { urlencoded: parseKeyValuePairs(options.form, '--form') };
  }
  if (options.bodyFile !== undefined) {
    const absolute = resolve(options.bodyFile);
    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') throw new ConfigError(`Body file not found: ${options.bodyFile}`);
      throw new ConfigError(`Could not read body file: ${options.bodyFile}`, [
        String((error as Error).message),
      ]);
    }
    if (options.json || absolute.endsWith('.json')) {
      try {
        return { json: JSON.parse(content) as unknown };
      } catch (error) {
        throw new ConfigError(`Body file is not valid JSON: ${options.bodyFile}`, [
          String((error as Error).message),
        ]);
      }
    }
    return { text: content };
  }
  if (options.body !== undefined) {
    if (options.json) {
      try {
        return { json: JSON.parse(options.body) as unknown };
      } catch (error) {
        throw new UsageError(`--body is not valid JSON: ${(error as Error).message}`, [
          'Remove --json to send the body as plain text.',
        ]);
      }
    }
    // Auto-detect JSON objects/arrays so `--body '{"a":1}'` just works.
    const trimmed = options.body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { json: JSON.parse(trimmed) as unknown };
      } catch {
        return { text: options.body };
      }
    }
    return { text: options.body };
  }
  return undefined;
}

/** Load an environment by name from a project, or from an explicit file. */
export async function resolveEnvironment(
  environments: Map<string, { environment: EnvironmentDefinition }>,
  name: string | undefined,
  file: string | undefined,
): Promise<{ environment?: EnvironmentDefinition; name?: string }> {
  if (file) {
    const document = await readStructuredInput(file, 'environment file');
    const environment = parseEnvironmentDocument(document, file);
    return { environment, name: name ?? environment.name ?? file };
  }
  if (!name) return {};
  const found = environments.get(name);
  if (!found) {
    const available = [...environments.keys()];
    throw new ConfigError(`Environment "${name}" not found`, [
      available.length > 0
        ? `Available environments: ${available.join(', ')}`
        : 'No environments were found. Create environments/<name>.yaml or pass --env-file <path>.',
    ]);
  }
  return { environment: found.environment, name };
}

/** Build a synthetic one-test suite definition from CLI flags (used by `run`). */
export function testFromFlags(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: BodyDefinition;
  expectStatus?: number;
}): TestDefinition {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(input.method)) {
    throw new UsageError(`Invalid HTTP method "${input.method}"`);
  }
  return {
    name: `${input.method.toUpperCase()} ${input.url}`,
    method: input.method.toUpperCase(),
    url: input.url,
    ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
    ...(input.body ? { body: input.body } : {}),
    expect:
      input.expectStatus !== undefined
        ? { status: input.expectStatus }
        : { status: { min: 200, max: 299 } },
  };
}

export function parsePerformanceSpecDocument(document: unknown, context: string): PerformanceSpec {
  return parsePerformanceDocument(document, context);
}

export function parseSecuritySpecDocument(document: unknown, context: string): SecuritySpec {
  return parseSecurityDocument(document, context);
}

export function parseContractSpecDocument(document: unknown, context: string): ContractSpec {
  return parseContractDocument(document, context);
}

export function parseProjectConfigDocument(
  document: unknown,
  context: string,
): ReturnType<typeof parseProjectDocument> {
  return parseProjectDocument(document, context);
}
