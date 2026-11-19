import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestReport } from '../../src/test/report.js';
import { runSuite } from '../../src/test/runner.js';
import { parseSuiteDocument } from '../../src/config/schema.js';
import {
  renderTestReport,
  renderPerformanceReport,
  renderSecurityReport,
  renderContractReport,
} from '../../src/report/terminal.js';
import { renderTestJson } from '../../src/report/json.js';
import { renderJUnit } from '../../src/report/junit.js';
import { renderTestHtml } from '../../src/report/html.js';
import { writeReports } from '../../src/report/writer.js';
import { detectColorSupport, createPalette } from '../../src/report/color.js';
import { runSecurity, buildSecurityReport } from '../../src/security/index.js';
import { runPerformance } from '../../src/performance/runner.js';
import { runContract } from '../../src/contract/runner.js';
import { closeHttpResources } from '../../src/http/client.js';
import { startMockServer, type MockServer } from '../helpers/mock-server.js';
import type { TestReport } from '../../src/types.js';

let server: MockServer;
let tempDir: string;
const tool = { name: 'apiforge', version: '0.1.0' };

beforeAll(async () => {
  server = await startMockServer();
  tempDir = await mkdtemp(join(tmpdir(), 'apiforge-reports-'));
});

afterAll(async () => {
  await server.close();
  await closeHttpResources();
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  server.reset();
});

async function sampleReport(): Promise<TestReport> {
  const passing = await runSuite(
    parseSuiteDocument({
      name: 'Public API',
      description: 'Read-only endpoints',
      baseUrl: server.url,
      tests: [
        {
          name: 'lists users <script>alert(1)</script>',
          path: '/json',
          expect: { status: 200, jsonPath: { id: 42 } },
        },
        { name: 'skipped check', path: '/json', skip: 'maintenance' },
      ],
    }),
    { environmentName: 'staging' },
  );
  const failing = await runSuite(
    parseSuiteDocument({
      name: 'Failing suite',
      baseUrl: server.url,
      tests: [
        {
          name: 'expects 201',
          path: '/json',
          expect: { status: 201, headers: { 'x-missing': { exists: true } } },
        },
      ],
    }),
  );
  return buildTestReport({
    title: 'APIFORGE Test Report',
    suites: [passing, failing],
    tool,
    environment: 'staging',
  });
}

describe('terminal reporter', () => {
  it('renders counts, failures and assertion messages', async () => {
    const report = await sampleReport();
    const output = renderTestReport(report, { color: false });
    expect(output).toContain('Public API');
    expect(output).toContain('Failing suite');
    expect(output).toContain('3 total');
    expect(output).toContain('1 passed');
    expect(output).toContain('expected HTTP 201, received HTTP 200');
    expect(output).toContain('Some checks failed');
    expect(output).not.toMatch(/\u001B\[/);
  });

  it('emits ANSI colours when enabled', async () => {
    const report = await sampleReport();
    expect(renderTestReport(report, { color: true })).toMatch(/\u001B\[/);
  });

  it('shows passing tests in verbose mode', async () => {
    const report = await sampleReport();
    const output = renderTestReport(report, { color: false, verbose: true });
    expect(output).toContain('lists users');
  });

  it('renders performance reports', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 5,
      concurrency: 1,
      tool,
    });
    const output = renderPerformanceReport(report, { color: false });
    expect(output).toContain('Performance results');
    expect(output).toContain('Latency p95');
    expect(output).toContain('Requests/sec');
  });

  it('renders security reports with evidence and remediation', async () => {
    const result = await runSecurity({
      url: `${server.url}/security/weak`,
      timeoutMs: 5000,
      checks: { tls: false },
      tool,
    });
    const report = buildSecurityReport({ title: 'Security', target: server.url, tool, result });
    const output = renderSecurityReport(report, { color: false });
    expect(output).toContain('Security analysis');
    expect(output).toContain('remediation:');
    expect(output).toContain('evidence:');
    expect(output).toContain('/100');
  });

  it('renders contract reports', async () => {
    const baselineFile = join(tempDir, 'terminal-contract.json');
    const report = await runContract({ url: `${server.url}/json`, baselineFile, tool });
    const output = renderContractReport(report, { color: false });
    expect(output).toContain('Contract check');
    expect(report.snapshotUpdated).toBe(true);
    expect(output).toContain('Snapshot');
    expect(output).toContain('Response shape matches the baseline');
  });
});

describe('JSON reporter', () => {
  it('emits valid, complete JSON with redaction', async () => {
    const report = await sampleReport();
    const json = JSON.parse(renderTestJson(report)) as TestReport;
    expect(json.kind).toBe('test');
    expect(json.totals.total).toBe(3);
    expect(json.suites).toHaveLength(2);
    expect(json.tool).toEqual(tool);
    expect(json.generatedAt).toBeTruthy();
  });

  it('redacts sensitive response headers', async () => {
    const suite = await runSuite(
      parseSuiteDocument({
        name: 'secrets',
        baseUrl: server.url,
        tests: [
          {
            name: 'echo auth',
            path: '/echo',
            headers: { authorization: 'Bearer super-secret-token' },
          },
        ],
      }),
    );
    const json = renderTestJson(buildTestReport({ title: 'x', suites: [suite], tool }));
    expect(json).not.toContain('super-secret-token');
    expect(json).toContain('[REDACTED]');
  });
});

describe('JUnit reporter', () => {
  it('produces well-formed XML with failures and skips', async () => {
    const report = await sampleReport();
    const xml = renderJUnit(report);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<failure');
    expect(xml).toContain('<skipped');
    expect(xml).toContain('</testsuites>');

    // No raw markup from test names may break the document.
    expect(xml).toContain('lists users &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xml).not.toContain('<script>alert');

    // Balanced tags for the elements we emit.
    const opens = (xml.match(/<testcase/g) ?? []).length;
    const closes =
      (xml.match(/<\/testcase>/g) ?? []).length + (xml.match(/<testcase[^>]*\/>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('escapes XML-special characters', async () => {
    const suite = await runSuite(
      parseSuiteDocument({
        name: 'a & b <c>',
        baseUrl: server.url,
        tests: [{ name: 'x "y"', path: '/json' }],
      }),
    );
    const xml = renderJUnit(buildTestReport({ title: 't & t', suites: [suite], tool }));
    expect(xml).toContain('a &amp; b &lt;c&gt;');
    expect(xml).toContain('x &quot;y&quot;');
  });
});

describe('HTML reporter', () => {
  it('renders a self-contained, accessible document', async () => {
    const report = await sampleReport();
    const html = renderTestHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('class="skip-link"');
    expect(html).toMatch(/<main[^>]*id="main"[^>]*>|<main id="main"[^>]*>/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    // No external resources of any kind.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js)["']/i);
    expect(html).not.toMatch(/@import/);
  });

  it('escapes user content to prevent XSS', async () => {
    const report = await sampleReport();
    const html = renderTestHtml(report);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The only inline script is the filter helper.
    expect((html.match(/<script>/g) ?? []).length).toBe(1);
  });

  it('uses semantic tables with scoped headers when tabular data exists', async () => {
    const report = await sampleReport();
    expect(renderTestHtml(report)).not.toContain('scope="col"');

    const withThresholds = await runSuite(
      parseSuiteDocument({
        name: 'thresholded',
        baseUrl: server.url,
        thresholds: [
          { metric: 'successRate', min: 100 },
          { metric: 'p95', max: 999999 },
        ],
        tests: [{ name: 'ok', path: '/json' }],
      }),
    );
    const html = renderTestHtml(buildTestReport({ title: 'T', suites: [withThresholds], tool }));
    expect(html).toContain('scope="col"');
    expect(html).toContain('<caption');
    expect(html).toContain('Suite thresholds');
    // Unknown metrics render as n/a instead of silently passing.
    expect(html).toContain('n/a');
  });
});

describe('report writer', () => {
  it('writes every requested format and reports artifacts', async () => {
    const report = await sampleReport();
    const outDir = join(tempDir, 'out');
    const artifacts = await writeReports(report, {
      outDir,
      formats: ['json', 'html', 'junit'],
      baseName: 'sample',
      writeLatest: true,
    });
    expect(artifacts.map((artifact) => artifact.format).sort()).toEqual(['html', 'json', 'junit']);
    for (const artifact of artifacts) {
      const content = await readFile(artifact.path, 'utf8');
      expect(content.length).toBeGreaterThan(50);
      expect(artifact.bytes).toBe(Buffer.byteLength(content));
    }
    const latest = await readFile(join(outDir, 'latest.json'), 'utf8');
    expect(JSON.parse(latest).kind).toBe('test');
  });

  it('skips the terminal format', async () => {
    const report = await sampleReport();
    const artifacts = await writeReports(report, {
      outDir: join(tempDir, 'terminal-only'),
      formats: ['terminal'],
    });
    expect(artifacts).toEqual([]);
  });

  it('fails loudly when the report path cannot be created', async () => {
    const report = await sampleReport();
    const outDir = join(tempDir, 'blocked');
    await writeReports(report, { outDir, formats: ['json'], baseName: 'blocker' });
    // `blocker.json` now exists as a file, so a directory of that name cannot be made.
    await expect(
      writeReports(report, { outDir: join(outDir, 'blocker.json', 'nested'), formats: ['json'] }),
    ).rejects.toThrow(/Could not create report directory/);
  });
});

describe('colour handling', () => {
  it('respects NO_COLOR and FORCE_COLOR', () => {
    const original = {
      NO_COLOR: process.env.NO_COLOR,
      FORCE_COLOR: process.env.FORCE_COLOR,
      TERM: process.env.TERM,
    };
    try {
      process.env.NO_COLOR = '1';
      delete process.env.FORCE_COLOR;
      expect(detectColorSupport({ isTTY: true })).toBe(false);

      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = '1';
      expect(detectColorSupport({ isTTY: false })).toBe(true);

      process.env.FORCE_COLOR = '0';
      expect(detectColorSupport({ isTTY: true })).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('produces plain text when disabled', () => {
    const palette = createPalette(false);
    expect(palette.green('ok')).toBe('ok');
    expect(createPalette(true).green('ok')).toMatch(/\u001B\[32m/);
  });
});
