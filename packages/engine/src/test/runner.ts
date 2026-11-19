/**
 * Suite runner: resolves variables/environments, executes each test (including
 * data rows), evaluates assertions, captures values for request chaining and
 * applies thresholds.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ConfigError, RequestError, describeUnknownError } from '../errors.js';
import type { EnvironmentDefinition, SuiteDefinition, TestDefinition } from '../config/schema.js';
import type {
  AssertionResult,
  RequestSummary,
  ResponseSummary,
  SuiteRun,
  TestCaseResult,
  ThresholdResult,
} from '../types.js';
import { executeRequest, type HttpResponseData } from '../http/client.js';
import { evaluateExpect } from '../assertions/expect.js';
import { getPath, setPath } from '../util/path.js';
import { renderTemplate, renderValue, type TemplateContext } from '../util/template.js';
import { redactBodyText, redactSecretsInUrl, REDACTED } from '../util/redaction.js';
import { computeThresholds, type ThresholdInput } from './thresholds.js';
import { logger as defaultLogger } from '../logger-holder.js';

export const BODY_PREVIEW_LIMIT = 4000;

export interface RunnerOptions {
  /** Environment definition merged into every suite. */
  environment?: EnvironmentDefinition;
  environmentName?: string;
  /** Extra variables from the CLI (`--var key=value`). */
  variables?: Record<string, string>;
  /** Extra secrets from the CLI (`--secret key=value`). */
  secrets?: Record<string, string>;
  /** Values inlined into the suite file (`variables`, `secrets`). */
  suiteVariables?: Record<string, unknown>;
  /** Filter tests by name substring or tag. */
  filter?: string;
  tags?: string[];
  /** Environment variables exposed via `{{$env.NAME}}`; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Global timeout override for all requests. */
  timeoutMs?: number;
  /** Insecure TLS opt-in. */
  insecureTLS?: boolean;
  signal?: AbortSignal;
  /** Directory used to resolve relative `dataFile` entries. */
  baseDir?: string;
  /** Called after every finished test (progress feedback / streaming reporters). */
  onTestFinished?: (result: TestCaseResult, suite: SuiteDefinition) => void;
  /** Called before a test starts. */
  onTestStarting?: (test: TestDefinition, index: number, total: number) => void;
}

export interface SuiteRunnerFailure {
  suite: string;
  error: string;
}

interface DataRow {
  index?: number;
  values: Record<string, unknown>;
}

async function loadDataRows(test: TestDefinition, baseDir: string): Promise<DataRow[]> {
  const rows: DataRow[] = [];
  if (test.dataFile) {
    const file = isAbsolute(test.dataFile) ? test.dataFile : resolve(baseDir, test.dataFile);
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      throw new ConfigError(`Could not read data file for test "${test.name}": ${file}`, [describeUnknownError(error)]);
    }
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (extension === '.csv') {
      rows.push(...parseCsv(content).map((values) => ({ values })));
    } else if (extension === '.json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new ConfigError(`Data file for test "${test.name}" is not valid JSON: ${file}`, [describeUnknownError(error)]);
      }
      if (!Array.isArray(parsed)) {
        throw new ConfigError(`Data file for test "${test.name}" must contain a JSON array of objects: ${file}`);
      }
      parsed.forEach((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new ConfigError(`Each entry in ${file} must be an object`);
        }
        rows.push({ values: entry as Record<string, unknown> });
      });
    } else {
      throw new ConfigError(`Unsupported data file format for test "${test.name}": ${extension || '(none)'}`, [
        'Supported formats: .json (array of objects) and .csv (header row required).',
      ]);
    }
  }
  if (test.data) rows.push(...test.data.map((values) => ({ values })));
  return rows.map((row, index) => ({ ...row, index }));
}

/** RFC 4180-ish CSV parser with quoted fields. */
export function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((entry) => !(entry.length === 1 && (entry[0] ?? '').trim() === ''));
  const header = nonEmpty.shift();
  if (!header) return [];
  return nonEmpty.map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key.trim()] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

function matchesFilter(test: TestDefinition, filter: string | undefined, tags: string[] | undefined): boolean {
  if (tags && tags.length > 0) {
    const testTags = test.tags ?? [];
    if (!tags.some((tag) => testTags.includes(tag))) return false;
  }
  if (filter) {
    const needle = filter.toLowerCase();
    return test.name.toLowerCase().includes(needle) || (test.id ?? '').toLowerCase().includes(needle);
  }
  return true;
}

function toResponseSummary(response: HttpResponseData): ResponseSummary {
  const preview = redactBodyText(response.text.slice(0, BODY_PREVIEW_LIMIT));
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    bodyPreview: preview,
    bodyTruncated: response.bodyTruncated || response.text.length > BODY_PREVIEW_LIMIT,
    sizeBytes: response.bodyBytes,
    durationMs: response.durationMs,
    redirects: response.redirects,
    ...(response.jsonParseError ? { jsonParseError: response.jsonParseError } : {}),
  };
}

function captureValues(
  capture: TestDefinition['capture'],
  response: HttpResponseData,
): Record<string, unknown> {
  const captured: Record<string, unknown> = {};
  if (!capture) return captured;
  for (const [name, spec] of Object.entries(capture)) {
    if (typeof spec === 'string') {
      captured[name] = getPath(response.json, spec).value;
      continue;
    }
    if ('jsonPath' in spec) {
      captured[name] = getPath(response.json, spec.jsonPath).value;
    } else if ('header' in spec) {
      const target = spec.header.toLowerCase();
      for (const [key, value] of Object.entries(response.headers)) {
        if (key.toLowerCase() === target) {
          captured[name] = value;
          break;
        }
      }
    } else if ('status' in spec) {
      captured[name] = response.status;
    } else if ('body' in spec) {
      captured[name] = response.json ?? response.text;
    }
  }
  return captured;
}

function resolveUrl(
  test: TestDefinition,
  baseUrl: string | undefined,
  ctx: TemplateContext,
  suiteName: string,
): string {
  if (test.url !== undefined) return renderTemplate(test.url, ctx);
  if (!baseUrl) {
    throw new ConfigError(`Test "${test.name}" in suite "${suiteName}" uses \`path\` but no \`baseUrl\` is configured`, [
      'Set `baseUrl` in the suite, the selected environment, or the project configuration.',
    ]);
  }
  const prefix = renderTemplate(baseUrl, ctx).replace(/\/+$/, '');
  const path = renderTemplate(test.path ?? '/', ctx);
  return `${prefix}${path.startsWith('/') ? '' : '/'}${path}`;
}

export async function runSuite(
  suite: SuiteDefinition,
  options: RunnerOptions = {},
  suitePath?: string,
): Promise<SuiteRun> {
  const startedAt = new Date();
  const started = performance.now();
  const results: TestCaseResult[] = [];
  const stepValues: Record<string, unknown> = {};
  const baseDir = options.baseDir ?? (suitePath ? dirname(suitePath) : process.cwd());

  const environment = options.environment;
  const baseUrl = suite.baseUrl ?? environment?.baseUrl;

  const variables: Record<string, unknown> = {
    ...(environment?.variables ?? {}),
    ...(suite.variables ?? {}),
    ...(options.suiteVariables ?? {}),
    ...(options.variables ?? {}),
  };
  const secrets: Record<string, unknown> = {
    ...(environment?.secrets ?? {}),
    ...(suite.secrets ?? {}),
    ...(options.secrets ?? {}),
  };

  const ctx = (extraVariables: Record<string, unknown> = {}): TemplateContext => ({
    variables: { ...variables, ...extraVariables },
    secrets,
    steps: stepValues,
    env: options.env ?? process.env,
  });

  const selectedTests = suite.tests
    .map((test, index) => ({ test, index }))
    .filter(({ test }) => matchesFilter(test, options.filter, options.tags));

  if (options.filter || (options.tags && options.tags.length > 0)) {
    defaultLogger.debug(`Filter matched ${selectedTests.length} of ${suite.tests.length} tests`, {
      suite: suite.name,
    });
  }

  let runIndex = 0;
  for (const { test } of selectedTests) {
    runIndex += 1;
    options.onTestStarting?.(test, runIndex, selectedTests.length);

    if (test.skip === true || typeof test.skip === 'string') {
      const skipped: TestCaseResult = {
        name: test.name,
        request: { method: test.method ?? 'GET', url: '—' },
        status: 'skipped',
        assertions: [],
        durationMs: 0,
        startedAt: new Date().toISOString(),
        skipReason: typeof test.skip === 'string' ? test.skip : 'Skipped by configuration',
        ...(test.id ? { id: test.id } : {}),
      };
      results.push(skipped);
      options.onTestFinished?.(skipped, suite);
      continue;
    }

    let dataRows: DataRow[];
    try {
      dataRows = await loadDataRows(test, baseDir);
    } catch (error) {
      const result: TestCaseResult = {
        name: test.name,
        ...(test.id ? { id: test.id } : {}),
        request: { method: test.method ?? 'GET', url: '—' },
        status: 'error',
        assertions: [],
        error: error instanceof ConfigError ? error.toUserMessage() : describeUnknownError(error),
        durationMs: 0,
        startedAt: new Date().toISOString(),
      };
      results.push(result);
      options.onTestFinished?.(result, suite);
      continue;
    }
    const rows: DataRow[] = dataRows.length > 0 ? dataRows : [{ values: {} }];

    for (const row of rows) {
      const testStartedAt = new Date();
      const testStarted = performance.now();
      const rowVariables = { ...variables, ...row.values, data: row.values };

      let request: RequestSummary = { method: test.method ?? 'GET', url: '—' };
      try {
        const rowCtx = ctx(rowVariables);
        const url = resolveUrl(test, baseUrl, rowCtx, suite.name);
        const headers: Record<string, string> = {
          ...(environment?.headers ?? {}),
          ...(suite.defaults?.headers ?? {}),
          ...(test.headers ?? {}),
        };
        const renderedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
          renderedHeaders[key] = renderTemplate(value, rowCtx);
        }
        const query = renderValue({ ...(suite.defaults?.query ?? {}), ...(test.query ?? {}) }, rowCtx);
        const cookies = renderValue({ ...(test.cookies ?? {}) }, rowCtx);
        const auth = test.auth
          ? (renderValue(test.auth, rowCtx) as typeof test.auth)
          : undefined;
        const body = test.body ? renderValue(test.body, rowCtx) : undefined;

        const timeoutMs = options.timeoutMs ?? test.timeoutMs ?? suite.defaults?.timeoutMs ?? environment?.timeoutMs;
        const secretValues = Object.values(secrets).filter((value): value is string => typeof value === 'string');
        const method = test.method ?? 'GET';
        request = { method, url: redactSecretsInUrl(url, secretValues) };
        const renderedName = renderTemplate(test.name, rowCtx, { strict: false });

        const response = await executeRequest({
          method: test.method ?? 'GET',
          url,
          headers: renderedHeaders,
          query,
          cookies,
          ...(auth ? { auth } : {}),
          ...(body ? { body } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(test.followRedirects ?? suite.defaults?.followRedirects) !== undefined
            ? { followRedirects: (test.followRedirects ?? suite.defaults?.followRedirects) as boolean }
            : {},
          ...(test.maxRedirects !== undefined ? { maxRedirects: test.maxRedirects } : {}),
          retries: test.retries ?? suite.defaults?.retries ?? 0,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.insecureTLS ? { insecureTLS: true } : {}),
        });

        const captured = captureValues(test.capture, response);
        if (test.id && Object.keys(captured).length > 0) {
          stepValues[test.id] = captured;
        }

        const assertions: AssertionResult[] = evaluateExpect(test.expect, {
          request,
          response: toResponseSummary(response),
          json: response.json,
          text: response.text,
        });

        const failed = assertions.filter((assertion) => !assertion.passed);
        const result: TestCaseResult = {
          name: renderedName,
          ...(test.id ? { id: test.id } : {}),
          request,
          status: failed.length === 0 ? 'passed' : 'failed',
          assertions,
          response: toResponseSummary(response),
          durationMs: Math.round(performance.now() - testStarted),
          startedAt: testStartedAt.toISOString(),
          ...(test.tags ? { tags: test.tags } : {}),
          ...(row.index !== undefined && dataRows.length > 0 ? { dataRow: row.index } : {}),
        };
        results.push(result);
        options.onTestFinished?.(result, suite);
      } catch (error) {
        const message =
          error instanceof RequestError
            ? error.message
            : error instanceof ConfigError
              ? error.toUserMessage()
              : describeUnknownError(error);
        const result: TestCaseResult = {
          name: test.name,
          ...(test.id ? { id: test.id } : {}),
          request,
          status: 'error',
          assertions: [],
          error: message,
          durationMs: Math.round(performance.now() - testStarted),
          startedAt: testStartedAt.toISOString(),
          ...(test.tags ? { tags: test.tags } : {}),
          ...(row.index !== undefined && dataRows.length > 0 ? { dataRow: row.index } : {}),
        };
        results.push(result);
        options.onTestFinished?.(result, suite);

        if (options.signal?.aborted) {
          break;
        }
      }
    }
    if (options.signal?.aborted) break;
  }

  const totals = {
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errored: results.filter((result) => result.status === 'error').length,
  };

  const thresholdInput: ThresholdInput = {
    total: totals.total,
    passed: totals.passed,
    failed: totals.failed + totals.errored,
    successRate: totals.total - totals.skipped > 0 ? (totals.passed / (totals.total - totals.skipped)) * 100 : 0,
    durationMs: Math.round(performance.now() - started),
  };
  const thresholds = computeThresholds(suite.thresholds, thresholdInput, `suite:${suite.name}`);
  const passed =
    totals.failed === 0 && totals.errored === 0 && thresholds.every((threshold) => threshold.passed);

  return {
    suite: suite.name,
    ...(suite.description ? { description: suite.description } : {}),
    ...(suitePath ? { file: suitePath } : {}),
    ...(options.environmentName ? { environment: options.environmentName } : {}),
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    results,
    totals,
    thresholds,
    passed,
  };
}

/** Merge captured step values into a nested store, returning a new object. */
export function mergeStepValues(
  target: Record<string, unknown>,
  id: string,
  captured: Record<string, unknown>,
): Record<string, unknown> {
  let next = target;
  for (const key of Object.keys(captured)) {
    next = setPath(next, `${id}.${key}`, captured[key]);
  }
  return next;
}
