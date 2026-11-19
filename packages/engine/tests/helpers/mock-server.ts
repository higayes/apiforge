/**
 * Local mock HTTP server used by integration tests.
 *
 * Every test runs against a real socket on 127.0.0.1: no request mocking, no
 * simulated results. Routes are deterministic and cover the behaviours the
 * engine must handle: status codes, headers, cookies, redirects, delays,
 * malformed JSON, large bodies, auth, CORS, compression and connection resets.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: number;
}

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
  reset(): void;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, server: MockServer) => void | Promise<void>;

const routes: Record<string, Handler> = {
  'GET /json': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 42, name: 'Ada Lovelace', tags: ['math', 'computing'], nested: { active: true }, score: 99.5 }));
  },
  'GET /json/broken': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id": 1, "name": "broken"');
  },
  'GET /text': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello world\nsecond line\n');
  },
  'GET /empty': (_req, res) => {
    res.writeHead(204);
    res.end();
  },
  'GET /status/404': (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  },
  'GET /status/500': (_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  },
  'GET /slow': (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"slow":true}');
    }, 250);
  },
  'GET /delay/1s': (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('late');
    }, 1000);
  },
  'GET /redirect': (_req, res) => {
    res.writeHead(302, { location: '/json' });
    res.end();
  },
  'GET /redirect/chain': (_req, res) => {
    res.writeHead(301, { location: '/redirect' });
    res.end();
  },
  'GET /redirect/loop': (_req, res) => {
    res.writeHead(302, { location: '/redirect/loop' });
    res.end();
  },
  'GET /echo': (req, res, _body, server) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        requestCount: server.requests.length,
      }),
    );
  },
  'POST /echo': (req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: (() => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return null;
          }
        })(),
      }),
    );
  },
  'POST /created': (_req, res, body) => {
    res.writeHead(201, { 'content-type': 'application/json', location: '/users/7' });
    const parsed = (() => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    res.end(JSON.stringify({ id: 7, ...parsed }));
  },
  'PUT /echo': (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ updated: body }));
  },
  'PATCH /echo': (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ patched: body }));
  },
  'DELETE /echo': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  },
  'GET /headers': (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'abc-123',
      'x-ratelimit-limit': '100',
      'cache-control': 'no-store',
    });
    res.end('{}');
  },
  'GET /security/hardened': (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'access-control-allow-origin': 'https://app.example.com',
      'cache-control': 'no-store',
    });
    res.end('{"ok":true}');
  },
  'GET /security/weak': (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      server: 'Apache/2.4.1 (Ubuntu)',
      'x-powered-by': 'Express 4.18.2',
      'access-control-allow-origin': '*',
      'set-cookie': 'session=abc123; Path=/',
    });
    res.end(JSON.stringify({ debug: 'SQLSyntaxErrorException: near "SELECT"', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' }));
  },
  'GET /cookies/set': (_req, res) => {
    res.setHeader('Set-Cookie', [
      'good=1; Path=/; HttpOnly; Secure; SameSite=Lax',
      'bad=2; Path=/',
    ]);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"cookies":true}');
  },
  'GET /large': (_req, res) => {
    const chunk = 'x'.repeat(1024);
    res.writeHead(200, { 'content-type': 'text/plain' });
    for (let i = 0; i < 64; i += 1) res.write(chunk);
    res.end();
  },
  'GET /gzip': (_req, res) => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(payload);
  },
  'GET /auth/bearer': (req, res) => {
    const auth = req.headers.authorization ?? '';
    if (auth === 'Bearer s3cret-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"authenticated":true}');
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="mock"' });
    res.end('{"error":"unauthorized"}');
  },
  'GET /auth/basic': (req, res) => {
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    if (req.headers.authorization === expected) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"authenticated":true}');
      return;
    }
    res.writeHead(401, { 'www-authenticate': 'Basic realm="mock"' });
    res.end();
  },
  'GET /auth/apikey': (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.headers['x-api-key'] === 'key-from-header' || url.searchParams.get('api_key') === 'key-from-query') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"authenticated":true}');
      return;
    }
    res.writeHead(403);
    res.end();
  },
  'GET /users/1': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 1, name: 'Grace Hopper', email: 'grace@example.com' }));
  },
  'GET /flaky': (_req, res, _body, server) => {
    // Fails twice, succeeds on the third attempt per server instance.
    const attempts = server.requests.filter((request) => request.url.startsWith('/flaky')).length;
    if (attempts < 3) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  },
  'OPTIONS /methods': (_req, res) => {
    res.writeHead(204, { allow: 'GET, HEAD, OPTIONS', 'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE' });
    res.end();
  },
  'GET /unicode': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ greeting: 'مرحبا بالعالم', emoji: '🚀' }));
  },
};

/** Route keys look like "GET /json"; unmatched routes return 404 JSON. */
export async function startMockServer(options: { host?: string } = {}): Promise<MockServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
        receivedAt: Date.now(),
      };
      // Record *before* handling so `/flaky` and `/echo` can count themselves.
      // The server object is captured lazily below.
      mock.requests.push(recorded);

      const key = `${req.method} ${pathname}`;
      const handler = routes[key];
      if (handler) {
        void handler(req, res, body, mock);
        return;
      }

      // Parameterized fallbacks for realistic resource routes.
      const userMatch = /^\/users\/(\d+)$/.exec(pathname);
      if (userMatch && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: Number(userMatch[1]), name: 'Grace Hopper', email: 'grace@example.com' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no mock route', path: pathname, method: req.method }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  const mock: MockServer = {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests: [],
    reset(): void {
      mock.requests.length = 0;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };

  return mock;
}

/** A TCP port that refuses connections (closed immediately). */
export async function getClosedPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
