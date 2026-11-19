/**
 * HTTP engine.
 *
 * A thin, predictable layer over Undici that:
 *  - never follows redirects silently (the redirect chain is recorded),
 *  - enforces a hard per-request timeout and honours AbortSignal cancellation,
 *  - distinguishes network errors, timeouts and cancellation,
 *  - caps response body capture so a huge payload can't exhaust memory,
 *  - never logs or returns secrets in clear text.
 */
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';
import { RequestError } from '../errors.js';
import type { RedirectHop } from '../types.js';
import type { AuthDefinition, BodyDefinition } from '../config/schema.js';
import { redactHeaders, redactUrl } from '../util/redaction.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 10;
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  cookies?: Record<string, string>;
  auth?: AuthDefinition;
  body?: BodyDefinition | undefined;
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Maximum bytes of the response body to keep (rest is discarded). */
  maxBodyBytes?: number;
  /** How many times to retry on transient failures (network errors, 5xx, 429). */
  retries?: number;
  retryDelayMs?: number;
  /** Per-request agent (connection pool) reuse. */
  dispatcher?: Dispatcher;
  /** Skip TLS verification; only ever set through an explicit opt-in flag. */
  insecureTLS?: boolean;
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw body text (may be truncated). */
  text: string;
  bodyTruncated: boolean;
  bodyBytes: number;
  durationMs: number;
  redirects: RedirectHop[];
  /** Sanitized URL that was requested (secrets masked). */
  url: string;
  attempts: number;
  /** Parsed JSON body when the content is JSON; `undefined` otherwise. */
  json: unknown;
  jsonParseError?: string;
}

function buildUrl(base: string, query?: HttpRequestOptions['query']): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RequestError('protocol', `Invalid URL: ${base}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RequestError('protocol', `Unsupported protocol "${url.protocol}" (only http and https are allowed)`);
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

function applyAuth(
  url: URL,
  headers: Record<string, string>,
  auth: AuthDefinition | undefined,
): void {
  if (!auth) return;
  switch (auth.type) {
    case 'bearer':
      headers.Authorization = `Bearer ${auth.token}`;
      break;
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      break;
    case 'apikey':
      if (auth.in === 'query') {
        url.searchParams.set(auth.name, auth.value);
      } else {
        headers[auth.name] = auth.value;
      }
      break;
  }
}

function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('; ');
}

function encodeForm(data: Record<string, string | number | boolean>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) params.append(key, String(value));
  return params.toString();
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

export interface PreparedBody {
  body: string | Buffer | undefined;
  contentType?: string;
}

export function prepareBody(body: BodyDefinition | undefined): PreparedBody {
  if (!body) return { body: undefined };
  if ('json' in body) return { body: JSON.stringify(body.json), contentType: 'application/json' };
  if ('text' in body) return { body: body.text, contentType: undefined };
  if ('form' in body) {
    // `form` is modelled as multipart-compatible key/value data. To stay
    // dependency-free we send it URL-encoded unless the caller overrides the
    // content type, which is the safest default for text-only fields.
    return { body: encodeForm(body.form), contentType: 'application/x-www-form-urlencoded' };
  }
  if ('urlencoded' in body) return { body: encodeForm(body.urlencoded), contentType: 'application/x-www-form-urlencoded' };
  // `file` bodies are materialized by the engine layer (it has filesystem access).
  return { body: undefined };
}

function headerPairsToRecord(pairs: string[] | Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(pairs)) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const key = pairs[i];
      const value = pairs[i + 1];
      if (key === undefined || value === undefined) continue;
      const existing = out[key];
      out[key] = existing === undefined ? value : `${existing}, ${value}`;
    }
    return out;
  }
  for (const [key, value] of Object.entries(pairs)) {
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'AbortError')) ||
    (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ABORT_ERR')
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestError('cancelled', 'Request cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RequestError('cancelled', 'Request cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const sharedAgents = new Map<string, Agent>();

function getAgent(insecureTLS: boolean): Agent {
  const key = insecureTLS ? 'insecure' : 'default';
  let agent = sharedAgents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { ...(insecureTLS ? { rejectUnauthorized: false } : {}) },
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
      connections: 64,
    });
    sharedAgents.set(key, agent);
  }
  return agent;
}

/** Close pooled connections (called on CLI shutdown so the process can exit). */
export async function closeHttpResources(): Promise<void> {
  const agents = [...sharedAgents.values()];
  sharedAgents.clear();
  await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
}

/**
 * Undici (like Node's http module) does not decompress response bodies. We
 * decompress here so assertions see the real payload; decoding failures fall
 * back to the raw Buffer rather than failing the request.
 */
function decodeContentEncoding(buffer: Buffer, encodingHeader: string | undefined): Buffer {
  const encoding = (encodingHeader ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return buffer;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(buffer);
    if (encoding === 'deflate') return inflateSync(buffer);
    if (encoding === 'br') return brotliDecompressSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

async function readBody(response: Dispatcher.ResponseData, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (response.body === null) return { text: '', truncated: false, bytes: 0 };
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (bytes + buffer.byteLength > maxBytes) {
        const remaining = maxBytes - bytes;
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        bytes += buffer.byteLength;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      bytes += buffer.byteLength;
    }
  } catch (error) {
    if (isAbort(error)) throw new RequestError('cancelled', 'Request cancelled while reading the response body');
    throw new RequestError('network', `Failed while reading the response body: ${(error as Error).message}`, error);
  }
  if (truncated) {
    // Drain the remaining stream so the connection can be reused safely.
    try {
      await response.body.dump();
    } catch {
      /* ignore */
    }
  }
  const raw = Buffer.concat(chunks);
  const encodingHeader = response.headers['content-encoding'];
  const decoded = truncated
    ? raw
    : decodeContentEncoding(raw, Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader);
  return { text: decoded.toString('utf8'), truncated, bytes: raw.byteLength };
}

function parseJson(text: string, contentType: string): { json: unknown; error?: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { json: undefined };
  const looksJson = /json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson) return { json: undefined };
  try {
    return { json: JSON.parse(trimmed) as unknown };
  } catch (error) {
    return { json: undefined, error: (error as Error).message };
  }
}

interface SingleAttemptResult extends Omit<HttpResponseData, 'attempts'> {
  retryable: boolean;
}

async function performAttempt(
  options: Required<Pick<HttpRequestOptions, 'method'>> & HttpRequestOptions,
  method: string,
  headers: Record<string, string>,
  dispatcher: Dispatcher,
  startUrl: URL,
): Promise<SingleAttemptResult> {
  const followRedirects = options.followRedirects !== false;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const redirects: RedirectHop[] = [];
  const started = performance.now();

  let currentUrl = startUrl;
  let currentMethod = method;
  let payload = options.body;
  let attemptHeaders = { ...headers };

  for (let hop = 0; ; hop += 1) {
    if (options.signal?.aborted) throw new RequestError('cancelled', 'Request cancelled');

    const prepared = currentMethod === 'GET' || currentMethod === 'HEAD' ? { body: undefined } : prepareBody(payload);
    const outboundHeaders = { ...attemptHeaders };
    if (prepared.contentType && !hasHeader(outboundHeaders, 'content-type')) {
      outboundHeaders['content-type'] = prepared.contentType;
    }
    if (prepared.body !== undefined && !hasHeader(outboundHeaders, 'content-length')) {
      outboundHeaders['content-length'] = String(Buffer.byteLength(prepared.body));
    }
    if (!hasHeader(outboundHeaders, 'accept')) outboundHeaders.accept = '*/*';

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await request(currentUrl, {
        method: currentMethod as Dispatcher.HttpMethod,
        headers: outboundHeaders,
        body: prepared.body,
        signal,
        dispatcher,
      });

      const location = response.headers.location;
      const statusCode = response.statusCode;
      const isRedirect =
        followRedirects && statusCode >= 300 && statusCode < 400 && typeof location === 'string';
      const bodyResult = isRedirect ? { text: '', truncated: false, bytes: 0 } : await readBody(response, maxBodyBytes);
      clearTimeout(timer);

      if (isRedirect) {
        const target = new URL(String(location), currentUrl).toString();
        redirects.push({ status: statusCode, location: redactUrl(target) });
        await response.body?.dump().catch(() => undefined);
        if (hop >= maxRedirects) {
          throw new RequestError(
            'network',
            `Too many redirects (limit ${maxRedirects}); last redirect pointed to ${redactUrl(target)}`,
          );
        }
        currentUrl = new URL(String(location), currentUrl);
        if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          payload = undefined;
          const rest = { ...attemptHeaders };
          for (const key of Object.keys(rest)) {
            if (['content-type', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) delete rest[key];
          }
          attemptHeaders = rest;
        }
        continue;
      }

      const headersRecord = headerPairsToRecord(
        response.headers as unknown as Record<string, string | string[]>,
      );
      const contentType = headersRecord['content-type'] ?? '';
      const parsed = parseJson(bodyResult.text, contentType);

      return {
        status: statusCode,
        statusText: (response.statusText ?? '').trim(),
        headers: headersRecord,
        text: bodyResult.text,
        bodyTruncated: bodyResult.truncated,
        bodyBytes: bodyResult.bytes,
        durationMs: Math.round(performance.now() - started),
        redirects,
        url: redactUrl(currentUrl.toString()),
        json: parsed.json,
        ...(parsed.error ? { jsonParseError: parsed.error } : {}),
        retryable: RETRYABLE_STATUS.has(statusCode),
      };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof RequestError) throw error;
      if (isAbort(error) || timeoutController.signal.aborted) {
        if (options.signal?.aborted) throw new RequestError('cancelled', 'Request cancelled');
        throw new RequestError('timeout', `Request timed out after ${timeoutMs}ms`);
      }
      const cause = (error as { cause?: unknown }).cause;
      const code = (error as { code?: string }).code ?? (cause as { code?: string } | undefined)?.code;
      const detail = cause instanceof Error ? cause.message : (error as Error).message;
      throw new RequestError(
        'network',
        `Network error${code ? ` (${code})` : ''}: ${detail}`,
        error,
      );
    }
  }
}

/**
 * Execute an HTTP request, including redirect handling and optional retries.
 * Throws `RequestError` for network/timeout/cancellation failures.
 */
export async function executeRequest(options: HttpRequestOptions): Promise<HttpResponseData> {
  const method = options.method.toUpperCase();
  const url = buildUrl(options.url, options.query);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value;
  applyAuth(url, headers, options.auth);
  if (options.cookies && Object.keys(options.cookies).length > 0 && !hasHeader(headers, 'cookie')) {
    headers.cookie = serializeCookies(options.cookies);
  }
  if (!hasHeader(headers, 'user-agent')) headers['user-agent'] = 'apiforge/0.1 (+https://github.com/apiforge/apiforge)';

  const dispatcher = options.dispatcher ?? getAgent(options.insecureTLS === true);
  const retries = Math.max(0, options.retries ?? 0);
  const retryDelay = options.retryDelayMs ?? 150;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const result = await performAttempt(options, method, headers, dispatcher, url);
      if (result.retryable && attempt <= retries) {
        await sleep(retryDelay * attempt, options.signal);
        continue;
      }
      const { retryable: _retryable, ...response } = result;
      return { ...response, attempts: attempt };
    } catch (error) {
      const retryable =
        error instanceof RequestError && (error.kind === 'network' || error.kind === 'timeout');
      if (retryable && attempt <= retries && !options.signal?.aborted) {
        await sleep(retryDelay * attempt, options.signal);
        continue;
      }
      throw error;
    }
  }
}

/** Redacted view of the outbound request, safe for reports. */
export function summarizeOutboundRequest(method: string, url: string, headers: Record<string, string> | undefined): {
  method: string;
  url: string;
  headers: Record<string, string>;
} {
  return { method: method.toUpperCase(), url: redactUrl(url), headers: redactHeaders(headers ?? {}) };
}
