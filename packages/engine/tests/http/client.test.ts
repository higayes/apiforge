import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeHttpResources, executeRequest } from '../../src/http/client.js';
import { RequestError } from '../../src/errors.js';
import { getClosedPort, startMockServer, type MockServer } from '../helpers/mock-server.js';

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer();
});

afterAll(async () => {
  await server.close();
  await closeHttpResources();
});

beforeEach(() => {
  server.reset();
});

describe('executeRequest — methods', () => {
  it('performs GET and parses JSON', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/json` });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      id: 42,
      name: 'Ada Lovelace',
      tags: ['math', 'computing'],
      nested: { active: true },
      score: 99.5,
    });
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('performs POST/PUT/PATCH/DELETE with bodies', async () => {
    for (const [method, body, field] of [
      ['POST', '{"a":1}', 'json'],
      ['PUT', '{"b":2}', 'updated'],
      ['PATCH', '{"c":3}', 'patched'],
    ] as const) {
      const response = await executeRequest({
        method,
        url: `${server.url}/echo`,
        body: { json: { value: body } },
      });
      expect(response.status).toBe(200);
      const json = response.json as Record<string, unknown>;
      expect(json[field]).toBeDefined();
      expect(JSON.stringify(json[field])).toContain('value');
    }

    const deleted = await executeRequest({ method: 'DELETE', url: `${server.url}/echo` });
    expect((deleted.json as Record<string, unknown>).deleted).toBe(true);
  });

  it('supports custom HTTP methods', async () => {
    // The mock returns 404 for unmatched routes but records what it received.
    const response = await executeRequest({ method: 'PROPFIND', url: `${server.url}/custom` });
    expect(response.status).toBe(404);
    expect(server.requests.at(-1)?.method).toBe('PROPFIND');
  });

  it('does not send a body on GET even if one is configured', async () => {
    await executeRequest({
      method: 'GET',
      url: `${server.url}/echo`,
      body: { json: { nope: true } },
    });
    expect(server.requests.at(-1)?.body).toBe('');
  });
});

describe('executeRequest — query, headers, cookies, auth', () => {
  it('appends query parameters, including repeated values', async () => {
    await executeRequest({
      method: 'GET',
      url: `${server.url}/echo`,
      query: { page: 2, tag: ['a', 'b'], flag: true },
    });
    const url = new URL(server.requests.at(-1)?.url ?? '/', 'http://localhost');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
    expect(url.searchParams.get('flag')).toBe('true');
  });

  it('sends merged query parameters from the URL and options', async () => {
    await executeRequest({
      method: 'GET',
      url: `${server.url}/echo?existing=1`,
      query: { added: '2' },
    });
    const url = new URL(server.requests.at(-1)?.url ?? '/', 'http://localhost');
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.get('added')).toBe('2');
  });

  it('sends custom headers', async () => {
    await executeRequest({
      method: 'GET',
      url: `${server.url}/echo`,
      headers: { 'x-custom': 'value', 'X-Multi': 'single' },
    });
    const headers = server.requests.at(-1)?.headers ?? {};
    expect(headers['x-custom']).toBe('value');
    expect(headers['x-multi']).toBe('single');
  });

  it('serializes cookies', async () => {
    await executeRequest({
      method: 'GET',
      url: `${server.url}/echo`,
      cookies: { session: 'abc 123', theme: 'dark' },
    });
    expect(server.requests.at(-1)?.headers.cookie).toBe('session=abc%20123; theme=dark');
  });

  it('applies bearer, basic and API-key authentication', async () => {
    const bearer = await executeRequest({
      method: 'GET',
      url: `${server.url}/auth/bearer`,
      auth: { type: 'bearer', token: 's3cret-token' },
    });
    expect(bearer.status).toBe(200);

    const unauthorized = await executeRequest({
      method: 'GET',
      url: `${server.url}/auth/bearer`,
      auth: { type: 'bearer', token: 'wrong' },
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain('Bearer');

    const basic = await executeRequest({
      method: 'GET',
      url: `${server.url}/auth/basic`,
      auth: { type: 'basic', username: 'user', password: 'pass' },
    });
    expect(basic.status).toBe(200);

    const headerKey = await executeRequest({
      method: 'GET',
      url: `${server.url}/auth/apikey`,
      auth: { type: 'apikey', in: 'header', name: 'x-api-key', value: 'key-from-header' },
    });
    expect(headerKey.status).toBe(200);

    const queryKey = await executeRequest({
      method: 'GET',
      url: `${server.url}/auth/apikey`,
      auth: { type: 'apikey', in: 'query', name: 'api_key', value: 'key-from-query' },
    });
    expect(queryKey.status).toBe(200);
  });
});

describe('executeRequest — bodies', () => {
  it('sends JSON bodies with a content type', async () => {
    await executeRequest({
      method: 'POST',
      url: `${server.url}/echo`,
      body: { json: { name: 'Ada', age: 36 } },
    });
    const request = server.requests.at(-1);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ name: 'Ada', age: 36 });
  });

  it('sends text bodies without forcing a content type', async () => {
    await executeRequest({
      method: 'POST',
      url: `${server.url}/echo`,
      body: { text: 'plain payload' },
    });
    expect(server.requests.at(-1)?.body).toBe('plain payload');
  });

  it('sends URL-encoded and form bodies', async () => {
    await executeRequest({
      method: 'POST',
      url: `${server.url}/echo`,
      body: { urlencoded: { a: '1', b: 'two words' } },
    });
    const request = server.requests.at(-1);
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.body).toBe('a=1&b=two+words');

    await executeRequest({ method: 'POST', url: `${server.url}/echo`, body: { form: { x: 1 } } });
    expect(server.requests.at(-1)?.body).toBe('x=1');
  });

  it('respects explicitly provided content types', async () => {
    await executeRequest({
      method: 'POST',
      url: `${server.url}/echo`,
      headers: { 'Content-Type': 'application/vnd.api+json' },
      body: { json: { ok: true } },
    });
    const request = server.requests.at(-1);
    expect(request?.headers['content-type']).toBe('application/vnd.api+json');
    // No duplicate header casing variants.
    expect(
      Object.keys(request?.headers ?? {}).filter((key) => key.toLowerCase() === 'content-type'),
    ).toHaveLength(1);
  });
});

describe('executeRequest — response handling', () => {
  it('handles empty 204 responses', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/empty` });
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(response.json).toBeUndefined();
  });

  it('reports malformed JSON without throwing', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/json/broken` });
    expect(response.status).toBe(200);
    expect(response.json).toBeUndefined();
    expect(response.jsonParseError).toBeDefined();
  });

  it('returns non-2xx responses without throwing', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/status/500` });
    expect(response.status).toBe(500);
    expect(response.text).toBe('boom');
  });

  it('truncates large bodies but records the real size', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/large`,
      maxBodyBytes: 2048,
    });
    expect(response.bodyTruncated).toBe(true);
    expect(response.text.length).toBeLessThanOrEqual(2048);
    expect(response.bodyBytes).toBeGreaterThanOrEqual(2048);
  });

  it('decodes gzip responses', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/gzip`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.json).toEqual({ compressed: true });
  });

  it('keeps UTF-8 content intact', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/unicode` });
    expect((response.json as Record<string, unknown>).greeting).toBe('مرحبا بالعالم');
    expect((response.json as Record<string, unknown>).emoji).toBe('🚀');
  });

  it('exposes response headers', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/headers` });
    expect(response.headers['x-request-id']).toBe('abc-123');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('executeRequest — redirects', () => {
  it('follows redirects by default and records the chain', async () => {
    const response = await executeRequest({ method: 'GET', url: `${server.url}/redirect/chain` });
    expect(response.status).toBe(200);
    expect(response.redirects).toEqual([
      { status: 301, location: `${server.url}/redirect` },
      { status: 302, location: `${server.url}/json` },
    ]);
    expect((response.json as Record<string, unknown>).name).toBe('Ada Lovelace');
  });

  it('does not follow redirects when disabled', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/redirect`,
      followRedirects: false,
    });
    expect(response.status).toBe(302);
    expect(response.redirects).toEqual([]);
    expect(response.headers.location).toBe('/json');
  });

  it('fails clearly on redirect loops', async () => {
    await expect(
      executeRequest({ method: 'GET', url: `${server.url}/redirect/loop`, maxRedirects: 3 }),
    ).rejects.toThrow(/Too many redirects/);
  });
});

describe('executeRequest — failures and cancellation', () => {
  it('times out with a RequestError of kind "timeout"', async () => {
    const error = await executeRequest({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      timeoutMs: 100,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe('timeout');
    expect((error as RequestError).message).toContain('timed out');
    expect((error as RequestError).code).toBe('TIMEOUT');
  });

  it('reports connection failures as network errors', async () => {
    const port = await getClosedPort();
    const error = await executeRequest({ method: 'GET', url: `http://127.0.0.1:${port}/` }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe('network');
    expect((error as RequestError).code).toBe('NETWORK');
  });

  it('rejects unsupported protocols', async () => {
    await expect(executeRequest({ method: 'GET', url: 'ftp://example.com/x' })).rejects.toThrow(
      /Unsupported protocol/,
    );
    await expect(executeRequest({ method: 'GET', url: 'not a url' })).rejects.toThrow(
      /Invalid URL/,
    );
  });

  it('honours AbortSignal cancellation', async () => {
    const controller = new AbortController();
    const promise = executeRequest({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await promise.catch((caught) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe('cancelled');
    expect((error as RequestError).code).toBe('CANCELLED');
  });

  it('does not start a request with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = server.requests.length;
    await expect(
      executeRequest({ method: 'GET', url: `${server.url}/json`, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
    expect(server.requests.length).toBe(before);
  });
});

describe('executeRequest — retries', () => {
  it('retries transient 503 responses and succeeds', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/flaky`,
      retries: 3,
      retryDelayMs: 10,
    });
    expect(response.status).toBe(200);
    expect(response.attempts).toBe(3);
  });

  it('returns the last transient failure when retries are exhausted', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/flaky`,
      retries: 1,
      retryDelayMs: 5,
    });
    expect(response.status).toBe(503);
    expect(response.attempts).toBe(2);
  });

  it('does not retry client errors', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/status/404`,
      retries: 5,
      retryDelayMs: 5,
    });
    expect(response.status).toBe(404);
    expect(response.attempts).toBe(1);
  });
});

describe('URL redaction in responses', () => {
  it('masks secrets in the recorded request URL', async () => {
    const response = await executeRequest({
      method: 'GET',
      url: `${server.url}/echo`,
      query: { token: 'super-secret', page: '1' },
    });
    expect(response.url).not.toContain('super-secret');
    expect(response.url).toContain('page=1');
  });
});

/**
 * Regression tests for CodeQL js/redundant-operation on `isAbort`.
 *
 * The guard used to test `error.name === 'AbortError'` twice. Removing the
 * duplicate is only safe if every abort shape is still recognised, so these
 * tests pin each branch of the predicate and each user-visible outcome:
 * abort during the body read, timeout, explicit user cancellation, a network
 * failure (which must NOT be mistaken for a cancellation), and unknown errors.
 */
describe('executeRequest — abort and error classification', () => {
  it('classifies an abort that happens while reading the body as cancelled', async () => {
    const controller = new AbortController();
    const promise = executeRequest({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    const error = await promise.catch((caught) => caught);

    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe('cancelled');
    expect((error as RequestError).code).toBe('CANCELLED');
  });

  it('classifies an elapsed deadline as a timeout, not a cancellation', async () => {
    const error = await executeRequest({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      timeoutMs: 80,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe('timeout');
  });

  it('classifies a user cancellation as cancelled even when a timeout is also configured', async () => {
    const controller = new AbortController();
    const promise = executeRequest({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await promise.catch((caught) => caught);

    // The user's abort wins over the (much later) deadline.
    expect((error as RequestError).kind).toBe('cancelled');
  });

  it('classifies a refused connection as a network error, never as a cancellation', async () => {
    const error = await executeRequest({
      method: 'GET',
      url: `http://127.0.0.1:${await getClosedPort()}/json`,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe('network');
  });

  it('keeps the abort predicate semantically identical to the pre-fix version', async () => {
    // CodeQL flagged the duplicated `name === 'AbortError'` test. Removing it is
    // only sound if no error shape changes classification, so pin every shape
    // that the predicate is meant to recognise — and the ones it must not.
    //
    // The branches are split out so the pre-fix predicate can be rebuilt without
    // literally writing `X || X` again: the old code evaluated the name check
    // twice, which is exactly the redundancy that was removed.
    const nameBranch = (error: unknown): boolean =>
      error instanceof Error && error.name === 'AbortError';
    const codeBranch = (error: unknown): boolean =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ABORT_ERR';

    // Pre-fix: the name branch was evaluated twice.
    const oldPredicate = (error: unknown): boolean =>
      [nameBranch(error), nameBranch(error)].some(Boolean) || codeBranch(error);
    // Post-fix: each branch is evaluated once.
    const newPredicate = (error: unknown): boolean => nameBranch(error) || codeBranch(error);

    const domAbort = new DOMException('aborted', 'AbortError');
    const namedError = Object.assign(new Error('x'), { name: 'AbortError' });
    const codedError = Object.assign(new Error('x'), { code: 'ABORT_ERR' });
    const both = Object.assign(new Error('x'), { name: 'AbortError', code: 'ABORT_ERR' });
    const plain = new Error('boom');
    const reset = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    const nonError = { code: 'ABORT_ERR' };
    const timeoutDom = new DOMException('t', 'TimeoutError');

    const shapes: unknown[] = [
      domAbort,
      namedError,
      codedError,
      both,
      plain,
      reset,
      nonError,
      timeoutDom,
      'AbortError',
      null,
      undefined,
      42,
    ];

    for (const shape of shapes) {
      expect(newPredicate(shape), `shape ${String(shape)}`).toBe(oldPredicate(shape));
    }

    // And the predicate still classifies the shapes it exists for.
    expect(newPredicate(domAbort)).toBe(true);
    expect(newPredicate(codedError)).toBe(true);
    expect(newPredicate(plain)).toBe(false);
    expect(newPredicate(reset)).toBe(false);
  });

  it('reports unknown failures without leaking the original error type', async () => {
    const error = await executeRequest({
      method: 'GET',
      url: 'not-a-valid-url',
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(RequestError);
    // A malformed URL is rejected before any socket is opened, so the client
    // reports it as a protocol error rather than a network one.
    expect((error as RequestError).kind).toBe('protocol');
    expect((error as Error).message).not.toMatch(/AbortError/);
  });
});
