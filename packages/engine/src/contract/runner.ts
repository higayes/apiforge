/**
 * Contract runner: fetches the live response, infers its shape, compares it to
 * a stored baseline, and (optionally) validates against a JSON Schema / OpenAPI
 * schema file. `--update` writes the new baseline.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ContractReport } from '../types.js';
import { ConfigError } from '../errors.js';
import { executeRequest, type HttpRequestOptions } from '../http/client.js';
import { validateJsonSchema, dereferenceLocalRefs } from '../assertions/json-schema.js';
import { diffShapes, inferShape, isCompatible } from './shape.js';
import { redactBodyText, redactUrl } from '../util/redaction.js';

export interface ContractRunOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: HttpRequestOptions['query'];
  body?: HttpRequestOptions['body'];
  auth?: HttpRequestOptions['auth'];
  cookies?: Record<string, string>;
  timeoutMs?: number;
  baselineFile: string;
  update?: boolean;
  schemaFile?: string;
  signal?: AbortSignal;
  insecureTLS?: boolean;
  title?: string;
  tool: { name: string; version: string };
}

interface BaselineFile {
  apiforgeContract: 1;
  method: string;
  url: string;
  capturedAt: string;
  shape: unknown;
}

export async function readJsonFile<T>(file: string, label: string): Promise<T> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') throw new ConfigError(`${label} not found: ${file}`);
    throw new ConfigError(`Could not read ${label}: ${file}`, [String((error as Error).message)]);
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${file}`, [(error as Error).message]);
  }
}

export async function runContract(options: ContractRunOptions): Promise<ContractReport> {
  const started = performance.now();
  const method = (options.method ?? 'GET').toUpperCase();
  const response = await executeRequest({
    method,
    url: options.url,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.query ? { query: options.query } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.cookies ? { cookies: options.cookies } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    retries: 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.insecureTLS ? { insecureTLS: true } : {}),
  });

  if (response.json === undefined) {
    throw new ConfigError('Contract testing requires a JSON response body', [
      `Received HTTP ${response.status} with content-type "${response.headers['content-type'] ?? 'unknown'}"`,
      response.jsonParseError
        ? `JSON parse error: ${response.jsonParseError}`
        : 'Body was empty or not JSON.',
    ]);
  }

  const currentShape = inferShape(response.json);
  const changes = [];
  let exists = true;
  let baseline: BaselineFile | undefined;

  try {
    baseline = await readJsonFile<BaselineFile>(options.baselineFile, 'Contract baseline');
  } catch (error) {
    if (error instanceof ConfigError && error.message.startsWith('Contract baseline not found'))
      exists = false;
    else throw error;
  }

  if (baseline) {
    changes.push(...diffShapes(inferShapeFromBaseline(baseline.shape), currentShape));
  }

  let schemaValidation: { valid: boolean; errors: string[] } | undefined;
  if (options.schemaFile) {
    const schemaDocument = await readJsonFile<Record<string, unknown>>(
      options.schemaFile,
      'JSON Schema',
    );
    const dereferenced = dereferenceLocalRefs(schemaDocument) as Record<string, unknown>;
    schemaValidation = validateJsonSchema(dereferenced, response.json);
  }

  const shouldWrite = options.update === true || !exists;
  if (shouldWrite) {
    const payload: BaselineFile = {
      apiforgeContract: 1,
      method,
      url: redactUrl(options.url),
      capturedAt: new Date().toISOString(),
      shape: currentShape,
    };
    await mkdir(dirname(options.baselineFile), { recursive: true });
    await writeFile(options.baselineFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  // When the baseline is being refreshed, detected changes are *reported* but
  // the check succeeds: the user explicitly asked to accept the new shape.
  const compatible = baseline ? (options.update === true ? true : isCompatible(changes)) : true;
  const schemaOk = schemaValidation ? schemaValidation.valid : true;

  return {
    kind: 'contract',
    title: options.title ?? 'APIFORGE contract report',
    generatedAt: new Date().toISOString(),
    tool: options.tool,
    target: redactUrl(options.url),
    ...(baseline ? { baselineFile: options.baselineFile } : {}),
    snapshotUpdated: shouldWrite,
    compatible,
    changes,
    ...(schemaValidation ? { schemaValidation } : {}),
    response: {
      status: response.status,
      bodyPreview: redactBodyText(response.text.slice(0, 4000)),
    },
    durationMs: Math.round(performance.now() - started),
    // A fresh baseline is a successful write; a mismatch is a failure.
    passed: compatible && schemaOk,
  };
}

function inferShapeFromBaseline(shape: unknown): ReturnType<typeof inferShape> {
  // Baseline files store a shape already; guard against hand-edited files.
  if (shape !== null && typeof shape === 'object' && 'type' in (shape as Record<string, unknown>)) {
    return shape as ReturnType<typeof inferShape>;
  }
  throw new ConfigError('Contract baseline has an invalid "shape" field', [
    'The baseline file must contain an `apiforgeContract` version and a `shape` object. Delete the file to regenerate it.',
  ]);
}

export function baselinePathFor(cwd: string, name: string): string {
  return resolve(cwd, '.apiforge', 'contracts', `${name.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}
