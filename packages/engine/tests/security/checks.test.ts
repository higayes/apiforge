import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkAdvertisedMethods,
  checkAuth,
  checkCookies,
  checkCors,
  checkDisclosure,
  checkSecurityHeaders,
  checkTls,
  passesThreshold,
  runSecurity,
  scoreFindings,
} from '../../src/security/checks.js';
import { buildSecurityReport } from '../../src/security/report.js';
import { closeHttpResources } from '../../src/http/client.js';
import { startMockServer, type MockServer } from '../helpers/mock-server.js';

let server: MockServer;
const tool = { name: 'apiforge', version: '0.1.0' };

beforeAll(async () => {
  server = await startMockServer();
});

afterAll(async () => {
  await server.close();
  await closeHttpResources();
});

describe('checkSecurityHeaders', () => {
  it('flags missing headers on a bare HTTPS response', () => {
    const findings = checkSecurityHeaders(
      { 'content-type': 'application/json' },
      'https://api.example.com/x',
    );
    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain('headers.missing.strict-transport-security');
    expect(ids).toContain('headers.missing.x-content-type-options');
    expect(findings.every((finding) => finding.remediation.length > 0)).toBe(true);
  });

  it('passes hardened responses', () => {
    const findings = checkSecurityHeaders(
      {
        'content-type': 'application/json',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
      },
      'https://api.example.com/x',
    );
    expect(findings.filter((finding) => finding.status === 'warn')).toEqual([]);
  });

  it('validates HSTS strength', () => {
    const findings = checkSecurityHeaders(
      { 'strict-transport-security': 'max-age=60', 'x-content-type-options': 'nosniff' },
      'https://api.example.com',
    );
    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain('headers.hsts.short-max-age');
    expect(ids).toContain('headers.hsts.no-subdomains');
  });

  it('accepts nosniff case-insensitively and flags invalid values', () => {
    const ok = checkSecurityHeaders({ 'x-content-type-options': 'NoSniff' }, 'https://x.dev');
    expect(ok.some((finding) => finding.id === 'headers.x-content-type-options.invalid')).toBe(
      false,
    );
    const bad = checkSecurityHeaders({ 'x-content-type-options': 'sniff' }, 'https://x.dev');
    expect(bad.some((finding) => finding.id === 'headers.x-content-type-options.invalid')).toBe(
      true,
    );
  });

  it('only requires browser-facing headers for HTML responses', () => {
    const json = checkSecurityHeaders({ 'content-type': 'application/json' }, 'https://x.dev');
    const html = checkSecurityHeaders({ 'content-type': 'text/html' }, 'https://x.dev');
    expect(json.some((finding) => finding.id === 'headers.missing.content-security-policy')).toBe(
      false,
    );
    expect(html.some((finding) => finding.id === 'headers.missing.content-security-policy')).toBe(
      true,
    );
  });
});

describe('checkCors', () => {
  it('reports an informational finding when CORS is absent', () => {
    expect(checkCors({}, {})[0]?.status).toBe('info');
  });

  it('fails wildcard origin combined with credentials', () => {
    const findings = checkCors(
      { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' },
      { origin: 'https://evil.example' },
    );
    const wildcard = findings.find((finding) => finding.id === 'cors.wildcard');
    expect(wildcard?.status).toBe('fail');
    expect(wildcard?.severity).toBe('critical');
  });

  it('warns when the origin is reflected with credentials', () => {
    const findings = checkCors(
      {
        'access-control-allow-origin': 'https://evil.example',
        'access-control-allow-credentials': 'true',
      },
      { origin: 'https://evil.example' },
    );
    expect(findings.find((finding) => finding.id === 'cors.reflects-origin')?.severity).toBe(
      'high',
    );
  });

  it('passes explicit origins', () => {
    const findings = checkCors(
      { 'access-control-allow-origin': 'https://app.example.com' },
      { origin: 'https://other.example.com' },
    );
    expect(
      findings.some(
        (finding) => finding.id === 'cors.explicit-origin' && finding.status === 'pass',
      ),
    ).toBe(true);
  });
});

describe('checkCookies', () => {
  it('flags missing Secure/HttpOnly/SameSite flags', () => {
    const findings = checkCookies({ 'set-cookie': 'session=abc; Path=/' }, true);
    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain('cookies.secure.session');
    expect(ids).toContain('cookies.httponly.session');
    expect(ids).toContain('cookies.samesite.session');
    expect(findings[0]?.evidence).not.toContain('abc');
  });

  it('passes properly flagged cookies', () => {
    const findings = checkCookies(
      { 'set-cookie': 'session=abc; HttpOnly; Secure; SameSite=Lax' },
      true,
    );
    expect(findings.some((finding) => finding.status === 'pass')).toBe(true);
  });

  it('does not require Secure on plain HTTP (reported by TLS checks instead)', () => {
    const findings = checkCookies({ 'set-cookie': 'a=1; HttpOnly; SameSite=Strict' }, false);
    expect(findings.some((finding) => finding.id.startsWith('cookies.secure'))).toBe(false);
  });
});

describe('checkDisclosure', () => {
  it('flags versioned server banners', () => {
    const findings = checkDisclosure({ server: 'nginx/1.25.3', 'x-powered-by': 'Express' }, '');
    const server = findings.find((finding) => finding.id === 'disclosure.server');
    expect(server?.status).toBe('warn');
    expect(server?.severity).toBe('low');
    expect(findings.find((finding) => finding.id === 'disclosure.x-powered-by')?.status).toBe(
      'info',
    );
  });

  it('masks secrets found in bodies', () => {
    // Assembled at runtime so the literal never appears in the repository: GitHub's
    // push protection flags any live-key-shaped string as a leaked secret.
    const fakeStripeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
    const findings = checkDisclosure({}, JSON.stringify({ key: fakeStripeKey }));
    const secret = findings.find((finding) => finding.id === 'disclosure.secret.stripe-key');
    expect(secret?.status).toBe('fail');
    expect(secret?.severity).toBe('critical');
    expect(secret?.evidence).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('detects stack traces and SQL errors without leaking embedded credentials', () => {
    const findings = checkDisclosure(
      {},
      'SQLSyntaxErrorException near SELECT {"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"}',
    );
    const stack = findings.find((finding) => finding.id === 'disclosure.stack-trace');
    expect(stack).toBeDefined();
    expect(stack?.evidence).not.toContain('dozjgNryP4J3jVmNHl0w5N');
    expect(stack?.evidence).toContain('[REDACTED]');
  });

  it('detects JWTs and AWS keys', () => {
    const jwts = checkDisclosure(
      {},
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    );
    expect(jwts.some((finding) => finding.id === 'disclosure.secret.jwt')).toBe(true);
    const aws = checkDisclosure({}, 'AKIAIOSFODNN7EXAMPLE');
    expect(aws.some((finding) => finding.id === 'disclosure.secret.aws-access-key')).toBe(true);
  });
});

describe('checkAuth', () => {
  it('warns when 401 lacks WWW-Authenticate', () => {
    const findings = checkAuth({}, 401);
    expect(findings[0]?.id).toBe('auth.missing-www-authenticate');
  });

  it('passes when the challenge is present', () => {
    const findings = checkAuth({ 'www-authenticate': 'Bearer realm="api"' }, 401);
    expect(findings[0]?.status).toBe('pass');
  });

  it('notes successful unauthenticated access', () => {
    const findings = checkAuth({}, 200);
    expect(findings[0]?.id).toBe('auth.unauthenticated-response');
  });

  it('suggests rate-limit headers on auth failures', () => {
    const findings = checkAuth({ 'www-authenticate': 'Bearer' }, 403);
    expect(findings.some((finding) => finding.id === 'auth.no-rate-limit-signal')).toBe(true);
  });
});

describe('checkTls', () => {
  it('fails plain HTTP targets', () => {
    const findings = checkTls('http://api.example.com', {});
    expect(findings[0]?.status).toBe('fail');
    expect(findings[0]?.severity).toBe('high');
  });

  it('passes HTTPS targets', () => {
    expect(checkTls('https://api.example.com', {})[0]?.status).toBe('pass');
  });
});

describe('checkAdvertisedMethods', () => {
  it('flags unsafe advertised methods', () => {
    const findings = checkAdvertisedMethods({
      allow: 'GET, HEAD, DELETE',
      corsAllowMethods: 'PUT',
    });
    expect(findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(['methods.delete', 'methods.put']),
    );
  });

  it('ignores safe methods', () => {
    expect(checkAdvertisedMethods({ allow: 'GET, HEAD, OPTIONS' })).toEqual([]);
  });

  it('reports when nothing is advertised', () => {
    expect(checkAdvertisedMethods({})[0]?.id).toBe('methods.none-advertised');
  });
});

describe('scoring and thresholds', () => {
  it('penalizes failing findings by severity and clamps to 0-100', () => {
    expect(scoreFindings([])).toBe(100);
    const findings = checkCors(
      { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' },
      {},
    );
    expect(findings).toHaveLength(1);
    expect(scoreFindings(findings)).toBe(60);
    expect(scoreFindings([...findings, ...findings])).toBe(20);
  });

  it('ignores info/pass findings when scoring', () => {
    const findings = checkAuth({}, 200);
    expect(scoreFindings(findings)).toBe(100);
  });

  it('applies severity thresholds only to failing findings', () => {
    const findings = checkCors(
      { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' },
      {},
    );
    expect(passesThreshold(findings, 'critical')).toBe(false);
    expect(passesThreshold(findings, 'high')).toBe(false);
    expect(passesThreshold([], 'low')).toBe(true);
  });
});

describe('runSecurity (integration)', () => {
  it('analyses the weak mock endpoint end to end', async () => {
    const result = await runSecurity({
      url: `${server.url}/security/weak`,
      timeoutMs: 5000,
      checks: { cors: { origin: 'https://evil.example' }, methods: true },
      tool,
    });
    expect(result.findings.length).toBeGreaterThan(5);
    const ids = result.findings.map((finding) => finding.id);
    expect(ids).toContain('disclosure.server');
    expect(ids).toContain('cors.wildcard');
    expect(ids).toContain('cookies.httponly.session');
    expect(result.counts.fail).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
    expect(result.passed).toBe(false);
    // Raw cookie values must not leak into evidence.
    expect(JSON.stringify(result.findings)).not.toContain('session=abc123');
  });

  it('passes a hardened endpoint (TLS check disabled: the mock server is plain HTTP)', async () => {
    const result = await runSecurity({
      url: `${server.url}/security/hardened`,
      timeoutMs: 5000,
      checks: { tls: false },
      tool,
    });
    expect(result.counts.fail).toBe(0);
    expect(result.passed).toBe(true);
  });

  it('fails plain-HTTP targets on the TLS check by default', async () => {
    const result = await runSecurity({
      url: `${server.url}/security/hardened`,
      timeoutMs: 5000,
      tool,
    });
    expect(result.findings.find((finding) => finding.id === 'tls.not-used')?.status).toBe('fail');
    expect(result.passed).toBe(false);
  });

  it('produces a complete SecurityReport', async () => {
    const result = await runSecurity({
      url: `${server.url}/security/hardened`,
      timeoutMs: 5000,
      checks: { tls: false },
      tool,
    });
    const report = buildSecurityReport({
      title: 'Security',
      target: 'http://mock',
      tool,
      result,
    });
    expect(report.kind).toBe('security');
    expect(report.counts.bySeverity).toBeDefined();
    expect(report.startedAt <= report.generatedAt).toBe(true);
  });

  it('supports disabling individual checks', async () => {
    const result = await runSecurity({
      url: `${server.url}/security/weak`,
      timeoutMs: 5000,
      checks: { headers: false, disclosure: false, cookies: false, auth: false, tls: false },
      tool,
    });
    expect(result.findings).toEqual([]);
  });
});
