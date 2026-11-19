#!/usr/bin/env node
/**
 * APIFORGE examples server.
 *
 * A dependency-free HTTP API used by `npm run examples` and by the project in
 * `examples/`. It exists so the examples are runnable out of the box without
 * touching the public internet, credentials, or a third-party service.
 *
 * Endpoints
 *   GET    /health                    health probe
 *   GET    /api/users                 list users (wrapped collection)
 *   GET    /api/users/:id             single user, 404 when unknown
 *   POST   /api/users                 create a user (201 + Location)
 *   PUT    /api/users/:id             replace a user
 *   PATCH  /api/users/:id             partially update a user
 *   DELETE /api/users/:id             delete a user (204)
 *   GET    /api/secure                requires `Authorization: Bearer demo-token`
 *   GET    /api/slow                  responds after ~250 ms
 *   GET    /api/flaky                 fails the first 2 calls, then succeeds
 *   GET    /api/redirect              ../../health (relative redirect)
 *   GET    /api/headers               echoes request headers
 *   GET    /api/echo                  echoes method, query, headers and body
 *   POST   /api/echo                  same, with a request body
 *   GET    /api/echo.gzip             echo with gzip compression
 *   GET    /api/metrics               minimal metrics document
 *   GET    /api/cookies               sets cookies with weak attributes
 *   GET    /api/insecure              deliberately weak security posture
 *   GET    /api/hardened              deliberately strong security posture
 *   OPTIONS /api/users                CORS preflight (permissive, see below)
 *
 * Usage:
 *   node scripts/demo-server.mjs            # listens on 127.0.0.1:4010
 *   PORT=8080 node scripts/demo-server.mjs
 *   node scripts/demo-server.mjs --json     # prints {"url": "..."} and stays up
 *
 * Safe by default: binds to the loopback interface only.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const PORT = Number(process.env.PORT ?? 4010);
const HOST = process.env.HOST ?? '127.0.0.1';
const JSON_OUTPUT = process.argv.includes('--json');

const users = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin', active: true },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.com', role: 'engineer', active: true },
  { id: 3, name: 'Alan Turing', email: 'alan@example.com', role: 'engineer', active: false },
];
let nextId = 4;

// `/api/flaky` fails its first two calls so suites and retries can be shown.
let flakyCalls = 0;

const HARDENED_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cache-control': 'no-store',
};

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseJsonBody(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function route(req, res, body) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Intentionally permissive CORS so `apiforge security` has something real to
  // report. `/api/hardened` opts out below and shows the correct posture.
  const hardened = path === '/api/hardened';
  res.setHeader('access-control-allow-origin', hardened ? 'https://app.example.com' : '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  if (!hardened) res.setHeader('x-powered-by', 'apiforge-demo');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === '/health') {
    return sendJson(res, 200, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  }

  if (path === '/api/metrics') {
    return sendJson(res, 200, {
      requests: { total: 1280, errors: 4 },
      latencyMs: { p50: 12, p95: 48, p99: 120 },
    });
  }

  if (path === '/api/slow') {
    setTimeout(() => sendJson(res, 200, { slow: true }), 250);
    return;
  }

  if (path === '/api/flaky') {
    flakyCalls += 1;
    if (flakyCalls <= 2) {
      return sendJson(res, 503, { error: 'temporarily unavailable', attempt: flakyCalls });
    }
    return sendJson(res, 200, { ok: true, attempt: flakyCalls });
  }

  if (path === '/api/redirect') {
    res.writeHead(302, { location: './secure' });
    res.end();
    return;
  }

  if (path === '/api/secure' || path === '/secure') {
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Bearer demo-token') {
      return sendJson(
        res,
        401,
        { error: 'unauthorized' },
        {
          // The challenge below is intentionally complete (RFC 6750 shape).
          'www-authenticate': 'Bearer realm="apiforge-demo", error="invalid_token"',
        },
      );
    }
    return sendJson(res, 200, { ok: true, user: 'demo', scopes: ['read', 'write'] });
  }

  if (path === '/api/headers') {
    return sendJson(res, 200, { headers: req.headers });
  }

  if (path === '/api/echo' || path === '/api/echo.gzip') {
    const payload = {
      method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body: parseJsonBody(body) ?? body ?? null,
    };
    if (path.endsWith('.gzip')) {
      const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': compressed.length,
      });
      res.end(compressed);
      return;
    }
    return sendJson(res, 200, payload);
  }

  if (path === '/api/cookies') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': ['session=abc123; Path=/', 'tracking=xyz; SameSite=None'],
    });
    res.end(JSON.stringify({ cookies: ['session', 'tracking'] }));
    return;
  }

  if (path === '/api/insecure') {
    // Deliberately weak: stack trace in the body, server banner, no hardening.
    return sendJson(res, 200, {
      env: { nodeEnv: 'development', databasePassword: 'hunter2-example-only' },
      stack: 'Error: simulated\n    at handler (/app/src/server.js:42:13)',
      debug: true,
    });
  }

  if (path === '/api/hardened') {
    return sendJson(res, 200, { ok: true }, HARDENED_HEADERS);
  }

  // ------------------------------- users ----------------------------------
  const userMatch = /^\/api\/users\/(\d+)$/.exec(path);

  if (path === '/api/users' && method === 'GET') {
    const page = Number(url.searchParams.get('page') ?? '1');
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const start = (page - 1) * limit;
    return sendJson(res, 200, {
      data: users.slice(start, start + limit),
      meta: { page, limit, total: users.length },
    });
  }

  if (path === '/api/users' && method === 'POST') {
    const payload = parseJsonBody(body);
    if (!payload || typeof payload.name !== 'string' || payload.name.trim() === '') {
      return sendJson(res, 422, { error: 'validation failed', fields: { name: 'required' } });
    }
    const created = {
      id: nextId++,
      name: payload.name,
      // Derived when omitted so the declared schema (`email: string`) holds for
      // every representation of a user.
      email:
        typeof payload.email === 'string' && payload.email !== ''
          ? payload.email
          : `${String(payload.name)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '.')}.${nextId - 1}@example.com`,
      role: payload.role ?? 'member',
      active: payload.active ?? true,
    };
    users.push(created);
    return sendJson(res, 201, created, { location: `/api/users/${created.id}` });
  }

  if (userMatch) {
    const id = Number(userMatch[1]);
    const index = users.findIndex((user) => user.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'not found', id });

    if (method === 'GET') return sendJson(res, 200, users[index]);

    if (method === 'PUT') {
      const payload = parseJsonBody(body) ?? {};
      users[index] = {
        ...users[index],
        ...payload,
        // The contract declares `email` as a string; never let a partial body
        // replace it with null/undefined.
        email: typeof payload.email === 'string' ? payload.email : users[index].email,
        id,
      };
      return sendJson(res, 200, users[index]);
    }

    if (method === 'PATCH') {
      const payload = parseJsonBody(body) ?? {};
      users[index] = { ...users[index], ...payload, id };
      return sendJson(res, 200, users[index]);
    }

    if (method === 'DELETE') {
      users.splice(index, 1);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (path === '/api/users' && method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === '/api/session') {
    return sendJson(
      res,
      200,
      { token: 'demo-token', tokenType: 'Bearer', expiresIn: 3600, requestId: randomUUID() },
      { 'cache-control': 'no-store' },
    );
  }

  return sendJson(res, 404, { error: 'not_found', path, method });
}

const server = createServer((req, res) => {
  readBody(req)
    .then((body) => route(req, res, body))
    .catch((error) => {
      sendJson(res, 500, { error: 'internal_error', message: String(error) });
    });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify({ url, port: PORT })}\n`);
  } else {
    process.stdout.write(`APIFORGE demo API listening on ${url}\n`);
    process.stdout.write('Press Ctrl+C to stop.\n');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
