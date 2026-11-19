/**
 * Security analysis engine — passive, read-only configuration checks for APIs
 * you are authorized to test.
 *
 * Scope is intentionally limited to defensive review:
 *  - response security headers and CORS policy,
 *  - cookie flags,
 *  - TLS usage/warnings and HSTS,
 *  - information disclosure through headers,
 *  - sensitive data exposure in response bodies,
 *  - authentication signalling,
 *  - unsafe HTTP methods advertised in `Allow`/`Access-Control-Allow-Methods`.
 *
 * It never attempts exploits, fuzzing, injection, or destructive behaviour.
 * `unsafe-methods` performs at most a single `OPTIONS` request (RFC 9110 §9.3.7
 * defines OPTIONS as safe/idempotent) and only when explicitly enabled.
 */
import { request } from 'undici';
import type { Severity, SecurityCheckStatus, SecurityFinding } from '../types.js';
import { executeRequest, type HttpRequestOptions, DEFAULT_TIMEOUT_MS } from '../http/client.js';
import { redactUrl, REDACTED } from '../util/redaction.js';
import { checkSchemaCompiles } from '../assertions/json-schema.js';

export interface SecurityRunOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: HttpRequestOptions['body'];
  auth?: HttpRequestOptions['auth'];
  cookies?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  insecureTLS?: boolean;
  /** Severity at or above which the run is considered failed. */
  threshold?: Severity;
  checks?: {
    headers?: boolean;
    cors?: boolean | { origin: string; withCredentials?: boolean };
    cookies?: boolean;
    disclosure?: boolean;
    auth?: boolean;
    methods?: boolean | { methods: string[] };
    tls?: boolean;
  };
  action?: string;
  tool: { name: string; version: string };
  title?: string;
}

export interface SecurityRunResult {
  findings: SecurityFinding[];
  counts: Record<SecurityCheckStatus, number> & { bySeverity: Record<Severity, number> };
  score: number;
  passed: boolean;
  threshold: Severity;
  response: { status: number; headers: Record<string, string>; bodyPreview: string };
  startedAt: string;
  endedAt: string;
}

const PASS = 'pass' as const;

function finding(
  partial: Omit<SecurityFinding, 'status'> & { status: SecurityCheckStatus },
): SecurityFinding {
  return partial;
}

/* ------------------------------- Header checks ------------------------------ */

const SECURITY_HEADERS: Array<{
  name: string;
  severity: Severity;
  explanation: string;
  remediation: string;
  appliesTo?: (ctx: { contentType: string; isHttps: boolean }) => boolean;
}> = [
  {
    name: 'strict-transport-security',
    severity: 'medium',
    explanation: 'HSTS is missing, so browsers may be downgraded to plain HTTP on later visits.',
    remediation: 'Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on HTTPS responses.',
    appliesTo: (ctx) => ctx.isHttps,
  },
  {
    name: 'content-security-policy',
    severity: 'low',
    explanation: 'A Content-Security-Policy helps browsers mitigate injected content when responses are rendered.',
    remediation:
      "Send a restrictive `Content-Security-Policy` (for JSON APIs, `default-src 'none'; frame-ancestors 'none'` is a safe baseline).",
    appliesTo: (ctx) => /text\/html/i.test(ctx.contentType),
  },
  {
    name: 'x-content-type-options',
    severity: 'medium',
    explanation: 'Without `nosniff`, browsers may MIME-sniff responses and execute content unexpectedly.',
    remediation: 'Send `X-Content-Type-Options: nosniff`.',
  },
  {
    name: 'x-frame-options',
    severity: 'low',
    explanation: 'The response can be embedded in an iframe, enabling clickjacking against browser clients.',
    remediation: 'Send `X-Frame-Options: DENY` (or use CSP `frame-ancestors`).',
    appliesTo: (ctx) => /text\/html/i.test(ctx.contentType),
  },
  {
    name: 'referrer-policy',
    severity: 'low',
    explanation: 'Without a Referrer-Policy, sensitive URL data can leak to third parties via the Referer header.',
    remediation: 'Send `Referrer-Policy: strict-origin-when-cross-origin` (or stricter).',
    appliesTo: (ctx) => /text\/html/i.test(ctx.contentType),
  },
  {
    name: 'permissions-policy',
    severity: 'info',
    explanation: 'A Permissions-Policy limits access to powerful browser features for embedded documents.',
    remediation: 'Send a `Permissions-Policy` that disables features the API does not need (e.g. `geolocation=(), camera=(), microphone=()`).',
    appliesTo: (ctx) => /text\/html/i.test(ctx.contentType),
  },
];

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function checkSecurityHeaders(
  headers: Record<string, string>,
  url: string,
): SecurityFinding[] {
  const isHttps = url.startsWith('https://');
  const contentType = headerValue(headers, 'content-type') ?? '';
  const findings: SecurityFinding[] = [];

  for (const expected of SECURITY_HEADERS) {
    if (expected.appliesTo && !expected.appliesTo({ contentType, isHttps })) continue;
    const value = headerValue(headers, expected.name);
    if (value === undefined) {
      findings.push(
        finding({
          id: `headers.missing.${expected.name}`,
          title: `Missing ${expected.name} header`,
          category: 'security-headers',
          status: 'warn',
          severity: expected.severity,
          description: expected.explanation,
          evidence: `Response headers did not include "${expected.name}".`,
          remediation: expected.remediation,
          references: ['https://owasp.org/www-project-secure-headers/'],
        }),
      );
      continue;
    }
    findings.push(
      finding({
        id: `headers.present.${expected.name}`,
        title: `${expected.name} is set`,
        category: 'security-headers',
        status: PASS,
        severity: 'info',
        description: `The response sets "${expected.name}".`,
        evidence: `${expected.name}: ${value}`,
        remediation: 'No action needed.',
      }),
    );
  }

  const xContentType = headerValue(headers, 'x-content-type-options');
  if (xContentType !== undefined && xContentType.toLowerCase() !== 'nosniff') {
    findings.push(
      finding({
        id: 'headers.x-content-type-options.invalid',
        title: 'Weak X-Content-Type-Options value',
        category: 'security-headers',
        status: 'warn',
        severity: 'medium',
        description: 'The only effective value for X-Content-Type-Options is `nosniff`.',
        evidence: `X-Content-Type-Options: ${xContentType}`,
        remediation: 'Set `X-Content-Type-Options: nosniff`.',
      }),
    );
  }

  const hsts = headerValue(headers, 'strict-transport-security');
  if (hsts !== undefined) {
    const maxAgeMatch = /max-age\s*=\s*(\d+)/i.exec(hsts);
    const maxAge = maxAgeMatch ? Number.parseInt(maxAgeMatch[1] as string, 10) : 0;
    if (maxAge < 15_552_000) {
      findings.push(
        finding({
          id: 'headers.hsts.short-max-age',
          title: 'HSTS max-age is below 180 days',
          category: 'security-headers',
          status: 'warn',
          severity: 'low',
          description: 'Short HSTS lifetimes reduce protection against downgrade attacks.',
          evidence: `strict-transport-security: ${hsts}`,
          remediation: 'Use `max-age=31536000; includeSubDomains` (and submit to the HSTS preload list when appropriate).',
        }),
      );
    }
    if (!/includesubdomains/i.test(hsts)) {
      findings.push(
        finding({
          id: 'headers.hsts.no-subdomains',
          title: 'HSTS does not include subdomains',
          category: 'security-headers',
          status: 'warn',
          severity: 'low',
          description: 'Subdomains remain reachable over plain HTTP when `includeSubDomains` is absent.',
          evidence: `strict-transport-security: ${hsts}`,
          remediation: 'Add `includeSubDomains` once every subdomain supports HTTPS.',
        }),
      );
    }
  }

  return findings;
}

/* --------------------------------- CORS ----------------------------------- */

export function checkCors(headers: Record<string, string>, options: { origin?: string }): SecurityFinding[] {
  const allowOrigin = headerValue(headers, 'access-control-allow-origin');
  const allowCredentials = (headerValue(headers, 'access-control-allow-credentials') ?? '').toLowerCase() === 'true';
  const allowMethods = headerValue(headers, 'access-control-allow-methods');
  const requestedOrigin = options.origin;
  const findings: SecurityFinding[] = [];

  if (allowOrigin === undefined) {
    findings.push(
      finding({
        id: 'cors.not-configured',
        title: 'No CORS headers present',
        category: 'cors',
        status: 'info',
        severity: 'info',
        description: 'The endpoint does not send CORS headers. This is expected for server-to-server APIs; browser clients will not be able to call it cross-origin.',
        evidence: 'No Access-Control-Allow-Origin header.',
        remediation: 'If browser clients must call this API, configure an explicit allow-list of trusted origins.',
      }),
    );
    return findings;
  }

  if (allowOrigin.trim() === '*') {
    findings.push(
      finding({
        id: 'cors.wildcard',
        title: 'CORS allows any origin (*)',
        category: 'cors',
        status: allowCredentials ? 'fail' : 'warn',
        severity: allowCredentials ? 'critical' : 'medium',
        description: allowCredentials
          ? 'The endpoint reflects any origin AND allows credentials, letting any website make authenticated calls on behalf of signed-in users.'
          : 'Any website can read responses from this endpoint in a browser.',
        evidence: `access-control-allow-origin: *${allowCredentials ? '\naccess-control-allow-credentials: true' : ''}`,
        remediation: 'Replace `*` with an explicit allow-list of trusted origins, and only send `Access-Control-Allow-Credentials: true` when strictly required.',
        references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS'],
      }),
    );
  } else if (requestedOrigin !== undefined && allowOrigin.trim() === requestedOrigin) {
    findings.push(
      finding({
        id: 'cors.reflects-origin',
        title: 'CORS reflects the request origin',
        category: 'cors',
        status: allowCredentials ? 'warn' : 'info',
        severity: allowCredentials ? 'high' : 'info',
        description: allowCredentials
          ? 'The endpoint echoes any requested origin while allowing credentials — any site can act as the user.'
          : 'The endpoint echoes the requested origin. Verify the server validates it against an allow-list.',
        evidence: `Requested origin: ${requestedOrigin}\naccess-control-allow-origin: ${allowOrigin}${
          allowCredentials ? '\naccess-control-allow-credentials: true' : ''
        }`,
        remediation: 'Validate the Origin header against an explicit allow-list before reflecting it.',
      }),
    );
  } else {
    findings.push(
      finding({
        id: 'cors.explicit-origin',
        title: 'CORS uses an explicit origin',
        category: 'cors',
        status: PASS,
        severity: 'info',
        description: 'Access-Control-Allow-Origin is not a wildcard.',
        evidence: `access-control-allow-origin: ${allowOrigin}`,
        remediation: 'No action needed.',
      }),
    );
  }

  if (allowMethods && /\b(metrics?|debug|trace|stub)\b/i.test(allowMethods)) {
    findings.push(
      finding({
        id: 'cors.unexpected-methods',
        title: 'CORS advertises unusual methods',
        category: 'cors',
        status: 'warn',
        severity: 'low',
        description: 'The Access-Control-Allow-Methods list includes non-standard methods.',
        evidence: `access-control-allow-methods: ${allowMethods}`,
        remediation: 'Expose only the methods the browser clients actually need.',
      }),
    );
  }

  return findings;
}

/* -------------------------------- Cookies --------------------------------- */

export function checkCookies(headers: Record<string, string>, isHttps: boolean): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const setCookie = headerValue(headers, 'set-cookie');
  if (!setCookie) {
    findings.push(
      finding({
        id: 'cookies.none',
        title: 'No cookies set',
        category: 'cookies',
        status: PASS,
        severity: 'info',
        description: 'The response does not set any cookies.',
        remediation: 'No action needed.',
      }),
    );
    return findings;
  }

  // Multiple cookies may be joined with ", " by the HTTP layer; split on the
  // well-known attribute boundary rather than on commas inside Expires values.
  const cookieStrings = setCookie.split(/,(?=\s*[^;=,\s]+\s*=)/g);
  for (const cookie of cookieStrings) {
    const cookieName = (cookie.split('=')[0] ?? '').trim() || 'cookie';
    const lower = cookie.toLowerCase();
    if (isHttps && !lower.includes('secure')) {
      findings.push(
        finding({
          id: `cookies.secure.${cookieName}`,
          title: `Cookie "${cookieName}" is missing the Secure flag`,
          category: 'cookies',
          status: 'warn',
          severity: 'medium',
          description: 'Cookies without Secure are sent over plain HTTP and can be intercepted.',
          evidence: `Set-Cookie: ${cookie.replace(/=[^;]*/, `=${REDACTED}`)}`,
          remediation: 'Add the `Secure` attribute to all cookies.',
        }),
      );
    }
    if (!lower.includes('httponly')) {
      findings.push(
        finding({
          id: `cookies.httponly.${cookieName}`,
          title: `Cookie "${cookieName}" is readable from JavaScript`,
          category: 'cookies',
          status: 'warn',
          severity: 'medium',
          description: 'Cookies without HttpOnly can be stolen through XSS.',
          evidence: `Set-Cookie: ${cookie.replace(/=[^;]*/, `=${REDACTED}`)}`,
          remediation: 'Add the `HttpOnly` attribute to session cookies.',
        }),
      );
    }
    if (!lower.includes('samesite')) {
      findings.push(
        finding({
          id: `cookies.samesite.${cookieName}`,
          title: `Cookie "${cookieName}" has no SameSite attribute`,
          category: 'cookies',
          status: 'warn',
          severity: 'low',
          description: 'Cookies without SameSite may be sent on cross-site requests (CSRF risk).',
          evidence: `Set-Cookie: ${cookie.replace(/=[^;]*/, `=${REDACTED}`)}`,
          remediation: 'Set `SameSite=Lax` (or `Strict`) unless cross-site usage is required.',
        }),
      );
    }
  }

  if (findings.length === 0) {
    findings.push(
      finding({
        id: 'cookies.flags-ok',
        title: 'Cookie security attributes are present',
        category: 'cookies',
        status: PASS,
        severity: 'info',
        description: 'Cookies set by the endpoint include Secure, HttpOnly and SameSite attributes.',
        remediation: 'No action needed.',
      }),
    );
  }
  return findings;
}

/* ---------------------------- Info disclosure ----------------------------- */

const DISCLOSURE_HEADERS: Array<{ name: string; severity: Severity; detail: string }> = [
  { name: 'server', severity: 'low', detail: 'The Server header discloses server software and version.' },
  { name: 'x-powered-by', severity: 'low', detail: 'The X-Powered-By header discloses the application framework.' },
  { name: 'x-aspnet-version', severity: 'low', detail: 'The X-AspNet-Version header discloses framework versions.' },
  { name: 'x-aspnetmvc-version', severity: 'low', detail: 'The X-AspNetMvc-Version header discloses framework versions.' },
  { name: 'x-generator', severity: 'low', detail: 'The X-Generator header discloses the CMS or generator.' },
  { name: 'via', severity: 'info', detail: 'The Via header discloses intermediary proxies.' },
];

const SENSITIVE_BODY_PATTERNS: Array<{ id: string; pattern: RegExp; label: string; severity: Severity }> = [
  { id: 'stripe-key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/, label: 'Stripe secret key', severity: 'critical' },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id', severity: 'critical' },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, label: 'GitHub token', severity: 'critical' },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, label: 'Slack token', severity: 'critical' },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, label: 'Embedded private key', severity: 'critical' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, label: 'JSON Web Token in response body', severity: 'medium' },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key', severity: 'high' },
];

export function checkDisclosure(
  headers: Record<string, string>,
  bodyText: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const header of DISCLOSURE_HEADERS) {
    const value = headerValue(headers, header.name);
    if (value === undefined) continue;
    if (header.name === 'server' || header.name === 'x-powered-by') {
      const versioned = /\d+\.\d+/.test(value);
      findings.push(
        finding({
          id: `disclosure.${header.name}`,
          title: versioned ? `${header.name} header reveals version information` : `${header.name} header is present`,
          category: 'information-disclosure',
          status: versioned ? 'warn' : 'info',
          severity: versioned ? header.severity : 'info',
          description: header.detail,
          evidence: `${header.name}: ${value}`,
          remediation: `Remove or generalize the ${header.name} header in production (e.g. \`server_tokens off\` in nginx).`,
        }),
      );
      continue;
    }
    findings.push(
      finding({
        id: `disclosure.${header.name}`,
        title: `${header.name} header is present`,
        category: 'information-disclosure',
        status: 'info',
        severity: header.severity,
        description: header.detail,
        evidence: `${header.name}: ${value}`,
        remediation: `Consider removing the ${header.name} header in production.`,
      }),
    );
  }

  const errorLeak = /(?:Error:|Exception in thread|Stack trace|at\s+[\w$.]+\s*\([^)]*:\d+:\d+\)|SQLSyntaxErrorException|ORA-\d{5}|psql: error)/i.exec(bodyText);
  if (errorLeak) {
    const snippetStart = Math.max(0, (errorLeak.index ?? 0) - 40);
    findings.push(
      finding({
        id: 'disclosure.stack-trace',
        title: 'Possible stack trace or database error in response body',
        category: 'information-disclosure',
        status: 'warn',
        severity: 'medium',
        description: 'Verbose error output can reveal internals (file paths, SQL, library versions) to attackers.',
        evidence: `…${bodyText.slice(snippetStart, snippetStart + 200).replace(/\s+/g, ' ')}…`,
        remediation: 'Return generic error messages to clients and log technical details server-side with a correlation id.',
      }),
    );
  }

  for (const probe of SENSITIVE_BODY_PATTERNS) {
    const match = probe.pattern.exec(bodyText);
    if (!match) continue;
    const value = match[0];
    const masked = value.length <= 8 ? REDACTED : `${value.slice(0, 4)}${REDACTED}`;
    findings.push(
      finding({
        id: `disclosure.secret.${probe.id}`,
        title: `Possible ${probe.label} exposed in response body`,
        category: 'sensitive-data',
        status: 'fail',
        severity: probe.severity,
        description: `The response body appears to contain a ${probe.label}. Responses must never include credentials or secrets.`,
        evidence: `Matched value: ${masked}`,
        remediation: 'Remove the secret from the response, rotate it, and audit where it is stored and logged.',
      }),
    );
  }

  return findings;
}

/* ----------------------------- Authentication ----------------------------- */

export function checkAuth(headers: Record<string, string>, status: number): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const wwwAuthenticate = headerValue(headers, 'www-authenticate');
  const rateLimit = headerValue(headers, 'ratelimit-limit') ?? headerValue(headers, 'x-ratelimit-limit') ?? headerValue(headers, 'retry-after');

  if (status === 401) {
    if (wwwAuthenticate === undefined) {
      findings.push(
        finding({
          id: 'auth.missing-www-authenticate',
          title: '401 response without WWW-Authenticate',
          category: 'authentication',
          status: 'warn',
          severity: 'low',
          description: 'RFC 9110 requires a WWW-Authenticate challenge on 401 responses.',
          evidence: `HTTP ${status} with no WWW-Authenticate header.`,
          remediation: 'Send `WWW-Authenticate: Bearer realm="api"` (or the appropriate scheme).',
        }),
      );
    } else {
      findings.push(
        finding({
          id: 'auth.www-authenticate',
          title: '401 response includes an authentication challenge',
          category: 'authentication',
          status: PASS,
          severity: 'info',
          description: 'The endpoint advertises supported authentication via WWW-Authenticate.',
          evidence: `www-authenticate: ${wwwAuthenticate}`,
          remediation: 'No action needed.',
        }),
      );
    }
  }

  if (status === 200 || status === 201) {
    findings.push(
      finding({
        id: 'auth.unauthenticated-response',
        title: 'Endpoint responded successfully without credentials',
        category: 'authentication',
        status: 'info',
        severity: 'info',
        description:
          'The endpoint returned a success status to an unauthenticated request. Confirm this data is intentionally public.',
        evidence: `HTTP ${status} without an Authorization header.`,
        remediation: 'Verify the route is meant to be public; otherwise require authentication and return 401.',
      }),
    );
  }

  if (status === 401 || status === 403) {
    if (rateLimit === undefined) {
      findings.push(
        finding({
          id: 'auth.no-rate-limit-signal',
          title: 'No rate-limit headers on authentication failures',
          category: 'authentication',
          status: 'info',
          severity: 'low',
          description: 'Rate-limit headers help clients back off and indicate brute-force protection.',
          evidence: 'No RateLimit-*, X-RateLimit-* or Retry-After headers observed.',
          remediation: 'Publish standard rate-limit headers (e.g. `RateLimit-Limit`, `RateLimit-Remaining`, `Retry-After`).',
        }),
      );
    }
  }

  return findings;
}

/* ------------------------------- TLS checks ------------------------------- */

export function checkTls(url: string, headers: Record<string, string>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  if (!url.startsWith('https://')) {
    findings.push(
      finding({
        id: 'tls.not-used',
        title: 'Endpoint is served over plain HTTP',
        category: 'tls',
        status: 'fail',
        severity: 'high',
        description: 'Traffic over HTTP is unencrypted and can be read or modified in transit.',
        evidence: `Target URL scheme: ${new URL(url).protocol}`,
        remediation: 'Serve the API exclusively over HTTPS and redirect HTTP requests.',
      }),
    );
    return findings;
  }

  const hsts = headerValue(headers, 'strict-transport-security');
  findings.push(
    finding({
      id: 'tls.https',
      title: 'Endpoint uses HTTPS',
      category: 'tls',
      status: PASS,
      severity: 'info',
      description: 'TLS is in use and the certificate chain was verified by the client.',
      evidence: hsts ? `strict-transport-security: ${hsts}` : 'HTTPS connection established; HSTS header checked separately.',
      remediation: 'No action needed.',
    }),
  );
  return findings;
}

/* ------------------------- Unsafe method detection ------------------------ */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const UNSAFE_METHODS = new Set(['PUT', 'DELETE', 'PATCH', 'CONNECT']);

export function checkAdvertisedMethods(headerValues: { allow?: string; corsAllowMethods?: string }): SecurityFinding[] {
  const advertised = new Set<string>();
  for (const value of [headerValues.allow, headerValues.corsAllowMethods]) {
    if (!value) continue;
    for (const method of value.split(',')) {
      const trimmed = method.trim().toUpperCase();
      if (trimmed) advertised.add(trimmed);
    }
  }

  if (advertised.size === 0) {
    return [
      finding({
        id: 'methods.none-advertised',
        title: 'No methods advertised',
        category: 'http-methods',
        status: 'info',
        severity: 'info',
        description: 'The endpoint does not advertise supported methods via Allow or Access-Control-Allow-Methods.',
        remediation: 'Advertise supported methods on OPTIONS responses via the Allow header.',
      }),
    ];
  }

  const findings: SecurityFinding[] = [];
  for (const method of advertised) {
    if (SAFE_METHODS.has(method)) continue;
    const isRisky = UNSAFE_METHODS.has(method);
    findings.push(
      finding({
        id: `methods.${method.toLowerCase()}`,
        title: `Unsafe method ${method} is advertised`,
        category: 'http-methods',
        status: isRisky ? 'warn' : 'info',
        severity: isRisky ? 'low' : 'info',
        description: isRisky
          ? `The endpoint advertises ${method}, which mutates or removes state. Confirm it is protected by authentication and authorization.`
          : `The endpoint advertises the non-standard method ${method}.`,
        evidence: `Advertised methods: ${[...advertised].join(', ')}`,
        remediation: 'Restrict state-changing methods to authenticated, authorized callers and disable them on public resources.',
      }),
    );
  }
  return findings;
}

/**
 * Ask the server which methods it advertises with an RFC-compliant OPTIONS
 * request. OPTIONS is safe by definition, so this is not intrusive.
 */
export async function probeAllowedMethods(
  options: SecurityRunOptions,
): Promise<{ allow?: string; corsAllowMethods?: string; error?: string }> {
  try {
    const response = await request(options.url, {
      method: 'OPTIONS',
      headers: { ...(options.headers ?? {}), 'user-agent': 'apiforge-security/0.1' },
      signal: AbortSignal.timeout(options.timeoutMs ?? Math.min(DEFAULT_TIMEOUT_MS, 5000)),
    });
    await response.body.dump().catch(() => undefined);
    const headers = response.headers as Record<string, string | string[] | undefined>;
    const allow = Array.isArray(headers.allow) ? headers.allow.join(', ') : headers.allow;
    const corsAllowMethodsRaw = headers['access-control-allow-methods'];
    const corsAllowMethods = Array.isArray(corsAllowMethodsRaw) ? corsAllowMethodsRaw.join(', ') : corsAllowMethodsRaw;
    return {
      ...(allow ? { allow } : {}),
      ...(corsAllowMethods ? { corsAllowMethods } : {}),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/* --------------------------------- Scoring -------------------------------- */

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 40, high: 20, medium: 8, low: 3, info: 0 };

export function scoreFindings(findings: SecurityFinding[]): number {
  let penalty = 0;
  for (const entry of findings) {
    if (entry.status === 'pass' || entry.status === 'skipped') continue;
    if (entry.status === 'info') continue;
    penalty += SEVERITY_WEIGHT[entry.severity];
  }
  return Math.max(0, Math.min(100, 100 - penalty));
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** True when no failing finding reaches the configured severity threshold. */
export function passesThreshold(findings: SecurityFinding[], threshold: Severity): boolean {
  const limit = SEVERITY_RANK[threshold];
  return !findings.some(
    (entry) => entry.status === 'fail' && SEVERITY_RANK[entry.severity] >= limit,
  );
}

/* --------------------------------- Runner --------------------------------- */

export async function runSecurity(options: SecurityRunOptions): Promise<SecurityRunResult> {
  const startedAt = new Date().toISOString();
  const checks = options.checks ?? {};
  const threshold = options.threshold ?? 'high';
  const findings: SecurityFinding[] = [];

  const response = await executeRequest({
    method: options.method ?? 'GET',
    url: options.url,
    headers: { ...(options.headers ?? {}), 'user-agent': 'apiforge-security/0.1' },
    ...(options.body ? { body: options.body } : {}),
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.cookies ? { cookies: options.cookies } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.insecureTLS ? { insecureTLS: true } : {}),
  });

  if (checks.headers !== false) findings.push(...checkSecurityHeaders(response.headers, options.url));
  if (checks.tls !== false) findings.push(...checkTls(options.url, response.headers));

  if (checks.cors !== false && checks.cors !== undefined) {
    const origin = typeof checks.cors === 'object' ? checks.cors.origin : 'https://example.invalid';
    const corsHeaders = await requestWithOrigin(options, origin);
    findings.push(...checkCors(corsHeaders.headers, { origin }));
  }

  if (checks.cookies !== false) findings.push(...checkCookies(response.headers, options.url.startsWith('https://')));
  if (checks.disclosure !== false) findings.push(...checkDisclosure(response.headers, response.text.slice(0, 64 * 1024)));
  if (checks.auth !== false) findings.push(...checkAuth(response.headers, response.status));

  if (checks.methods !== false && checks.methods !== undefined) {
    const probe = await probeAllowedMethods(options);
    if (probe.error) {
      findings.push(
        finding({
          id: 'methods.probe-failed',
          title: 'Could not determine advertised methods',
          category: 'http-methods',
          status: 'skipped',
          severity: 'info',
          description: 'The OPTIONS probe failed, so method advertisement could not be analysed.',
          evidence: probe.error,
          remediation: 'No action needed; re-run with `--check methods` if the endpoint supports OPTIONS.',
        }),
      );
    } else {
      findings.push(
        ...checkAdvertisedMethods({
          ...(probe.allow ? { allow: probe.allow } : {}),
          ...(probe.corsAllowMethods ? { corsAllowMethods: probe.corsAllowMethods } : {}),
        }),
      );
    }
  }

  const counts: Record<SecurityCheckStatus, number> = { pass: 0, warn: 0, fail: 0, info: 0, skipped: 0 };
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const entry of findings) {
    counts[entry.status] += 1;
    if (entry.status === 'fail' || entry.status === 'warn') bySeverity[entry.severity] += 1;
  }

  return {
    findings,
    counts: { ...counts, bySeverity },
    score: scoreFindings(findings),
    passed: passesThreshold(findings, threshold),
    threshold,
    response: {
      status: response.status,
      headers: response.headers,
      bodyPreview: response.text.slice(0, 2000),
    },
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

async function requestWithOrigin(
  options: SecurityRunOptions,
  origin: string,
): Promise<{ headers: Record<string, string> }> {
  try {
    const response = await request(options.url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.headers ?? {}),
        origin,
        'user-agent': 'apiforge-security/0.1',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? Math.min(DEFAULT_TIMEOUT_MS, 5000)),
    });
    await response.body.dump().catch(() => undefined);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    return { headers };
  } catch {
    return { headers: {} };
  }
}

/** Validate an OpenAPI/JSON schema document standalone (used by `--check schema`). */
export function validateSchemaDocument(schema: Record<string, unknown>): string | undefined {
  return checkSchemaCompiles(schema);
}

export { redactUrl };
