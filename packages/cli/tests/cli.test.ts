import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { makeTempProject, runCli } from './helpers/cli.js';
import { startMockServer, type MockServer } from '../../engine/tests/helpers/mock-server.js';

let server: MockServer;
let tempRoot: string;
const tempDirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const dir = await makeTempProject(files);
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  server = await startMockServer();
  tempRoot = await makeTempProject({});
  tempDirs.push(tempRoot);
});

afterAll(async () => {
  await server.close();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('meta commands', () => {
  it('prints the version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints help listing every command', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    for (const command of [
      'init',
      'test',
      'run',
      'performance',
      'security',
      'contract',
      'report',
      'import',
      'validate',
      'env',
    ]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain('Exit codes');
  });

  it('documents exit codes', async () => {
    const result = await runCli(['exit-codes', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Array<{ code: number }>;
    expect(payload.map((entry) => entry.code)).toEqual([0, 1, 2, 3, 4, 130]);
  });

  it('reports version details', async () => {
    const result = await runCli(['version', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { name: string; node: string; platform: string };
    expect(payload.name).toBe('apiforge');
    expect(payload.node).toMatch(/^v\d+/);
    expect(payload.platform).toContain(' ');
  });

  it('prints shell completion scripts', async () => {
    const bash = await runCli(['completion', 'bash']);
    expect(bash.code).toBe(0);
    expect(bash.stdout).toContain('_apiforge_completions');
    const zsh = await runCli(['completion', 'zsh']);
    expect(zsh.stdout).toContain('#compdef apiforge');
    const fish = await runCli(['completion', 'fish']);
    expect(fish.stdout).toContain('complete -c apiforge');
    const bad = await runCli(['completion', 'tcsh']);
    expect(bad.code).toBe(2);
  });
});

describe('init', () => {
  it('scaffolds a project that validates', async () => {
    const dir = await project({});
    const init = await runCli(['init'], { cwd: dir });
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('Created');

    for (const file of ['apiforge.yaml', 'environments/local.yaml', 'suites/health.suite.yaml']) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }

    const validate = await runCli(['validate'], { cwd: dir });
    expect(validate.stdout).toContain('All files are valid');
  });

  it('does not overwrite without --force', async () => {
    const dir = await project({ 'apiforge.yaml': 'name: Custom\n' });
    const init = await runCli(['init'], { cwd: dir });
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('Skipped');
    expect(await readFile(join(dir, 'apiforge.yaml'), 'utf8')).toBe('name: Custom\n');

    const forced = await runCli(['init', '--force'], { cwd: dir });
    expect(forced.code).toBe(0);
    expect(await readFile(join(dir, 'apiforge.yaml'), 'utf8')).toContain(
      'APIFORGE project configuration',
    );
  });

  it('emits JSON in --json mode', async () => {
    const dir = await project({});
    const result = await runCli(['init', '--json'], { cwd: dir });
    const payload = JSON.parse(result.stdout) as { ok: boolean; created: string[] };
    expect(payload.ok).toBe(true);
    expect(payload.created.length).toBeGreaterThan(0);
  });
});

describe('test', () => {
  const suite = (baseUrl: string): string => `name: Smoke
baseUrl: ${baseUrl}
tests:
  - name: JSON endpoint
    path: /json
    expect:
      status: 200
      jsonPath:
        id: 42
  - name: Failing expectation
    path: /json
    expect:
      status: 201
`;

  it('passes a green suite with exit code 0 and writes reports', async () => {
    const dir = await project({
      'green.suite.yaml': suite(server.url).replace(/  - name: Failing expectation[\s\S]*$/, ''),
    });
    const result = await runCli(['test', 'green.suite.yaml', '--reporter', 'json,html,junit'], {
      cwd: dir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('All checks passed');
    const files = await readdir(join(dir, 'reports'));
    expect(files.some((file) => file.endsWith('.json'))).toBe(true);
    expect(files.some((file) => file.endsWith('.html'))).toBe(true);
    expect(files.some((file) => file.endsWith('.xml'))).toBe(true);
    expect(files).toContain('latest.json');
  });

  it('fails a red suite with exit code 1', async () => {
    const dir = await project({ 'red.suite.yaml': suite(server.url) });
    const result = await runCli(['test', 'red.suite.yaml', '--reporter', 'terminal'], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('expected HTTP 201, received HTTP 200');
  });

  it('supports --json output without polluting stdout', async () => {
    const dir = await project({
      'green.suite.yaml': suite(server.url).replace(/  - name: Failing expectation[\s\S]*$/, ''),
    });
    const result = await runCli(['test', 'green.suite.yaml', '--json'], { cwd: dir });
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      kind: string;
      passed: boolean;
      totals: { total: number };
    };
    expect(payload.kind).toBe('test');
    expect(payload.passed).toBe(true);
    expect(payload.totals.total).toBe(1);
  });

  it('honours --filter and --var', async () => {
    const dir = await project({
      'vars.suite.yaml': `name: Vars
baseUrl: ${server.url}
tests:
  - name: alpha
    path: /users/{{userId}}
    expect: { status: 200 }
  - name: beta
    path: /json
    expect: { status: 200 }
`,
    });
    const filtered = await runCli(
      ['test', 'vars.suite.yaml', '--filter', 'alpha', '--var', 'userId=3', '--json'],
      {
        cwd: dir,
      },
    );
    const payload = JSON.parse(filtered.stdout) as {
      totals: { total: number };
      suites: Array<{ results: Array<{ name: string }> }>;
    };
    expect(payload.totals.total).toBe(1);
    expect(payload.suites[0]?.results[0]?.name).toBe('alpha');
  });

  it('applies --bail', async () => {
    const dir = await project({ 'bail.suite.yaml': suite(server.url) });
    const result = await runCli(['test', 'bail.suite.yaml', '--bail', '--json'], { cwd: dir });
    const payload = JSON.parse(result.stdout) as { totals: { total: number } };
    expect(result.code).toBe(1);
    expect(payload.totals.total).toBe(2);
  });

  it('uses environments and reports the environment name', async () => {
    const dir = await project({
      'apiforge.yaml': 'name: Env project\n',
      'environments/mock.yaml': `baseUrl: ${server.url}\n`,
      'suites/env.suite.yaml':
        'name: Env suite\ntests:\n  - name: ok\n    path: /json\n    expect: { status: 200 }\n',
    });
    const result = await runCli(['test', '--env', 'mock', '--json'], { cwd: dir });
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { environment?: string };
    expect(payload.environment).toBe('mock');
  });

  it('errors clearly for unknown environments', async () => {
    const dir = await project({
      'apiforge.yaml': 'name: x\n',
      'environments/mock.yaml': `baseUrl: ${server.url}\n`,
      'suites/env.suite.yaml': 'name: s\ntests:\n  - name: ok\n    path: /json\n',
    });
    const result = await runCli(['test', '--env', 'nope'], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Environment "nope" not found');
    expect(result.stderr).toContain('mock');
  });

  it('exits with a config error when no suites exist', async () => {
    const dir = await project({});
    const result = await runCli(['test'], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('No test suites were found');
  });

  it('reports invalid suites with field-level detail', async () => {
    const dir = await project({
      'bad.suite.yaml': 'name: bad\ntests:\n  - name: x\n    timeoutMs: -1\n',
    });
    const result = await runCli(['test', 'bad.suite.yaml'], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Invalid bad.suite.yaml');
    expect(result.stderr).toContain('timeoutMs');
  });

  it('supports --json errors on stderr with a stable exit code', async () => {
    const dir = await project({});
    const result = await runCli(['test', 'missing.yaml', '--json'], { cwd: dir });
    expect(result.code).toBe(3);
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { exitCode: number } };
    expect(payload.ok).toBe(false);
    expect(payload.error.exitCode).toBe(3);
  });
});

describe('run', () => {
  it('sends an ad-hoc GET and asserts the status', async () => {
    const result = await runCli(['run', `${server.url}/json`, '--expect-status', '200', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      passed: boolean;
      suites: Array<{ results: Array<{ response?: { status: number } }> }>;
    };
    expect(payload.passed).toBe(true);
    expect(payload.suites[0]?.results[0]?.response?.status).toBe(200);
  });

  it('fails when the expectation is not met', async () => {
    const result = await runCli(['run', `${server.url}/status/500`, '--expect-status', '200']);
    expect(result.code).toBe(1);
  });

  it('accepts curl-style "Name: value" headers', async () => {
    // The README documents this form; it must work verbatim.
    const result = await runCli([
      'run',
      `${server.url}/echo`,
      '-H',
      'authorization: Bearer audit-token',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      suites: Array<{ results: Array<{ response?: { bodyPreview: string } }> }>;
    };
    const body = payload.suites[0]?.results[0]?.response?.bodyPreview ?? '';
    // The preview is truncated, so assert on the header name/key presence.
    expect(body.toLowerCase()).toContain('authorization');
  });

  it('keeps colons inside a header value', async () => {
    const result = await runCli([
      'run',
      `${server.url}/echo`,
      '-H',
      'x-origin: https://example.com:8443/path',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      suites: Array<{ results: Array<{ response?: { bodyPreview: string } }> }>;
    };
    const body = payload.suites[0]?.results[0]?.response?.bodyPreview ?? '';
    expect(body).toContain('https://example.com:8443/path');
  });

  it('sends JSON bodies and headers', async () => {
    const result = await runCli([
      'run',
      `${server.url}/echo`,
      '-X',
      'POST',
      '-H',
      'x-custom=1',
      '-d',
      '{"hello":"world"}',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      suites: Array<{ results: Array<{ response?: { bodyPreview: string } }> }>;
    };
    const body = payload.suites[0]?.results[0]?.response?.bodyPreview ?? '';
    expect(body).toContain('hello');
    expect(body).toContain('x-custom');
  });

  it('rejects invalid URLs with a usage error', async () => {
    const result = await runCli(['run', 'not-a-url']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Invalid target URL');
  });

  it('rejects conflicting body flags', async () => {
    const result = await runCli(['run', `${server.url}/echo`, '-d', 'a', '--form', 'b=c']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Only one of');
  });
});

describe('performance', () => {
  it('runs a bounded load test and writes reports', async () => {
    const dir = await project({});
    const result = await runCli(
      ['performance', `${server.url}/json`, '-n', '10', '-c', '2', '--json'],
      { cwd: dir },
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      kind: string;
      stats: { totalRequests: number; successful: number };
    };
    expect(payload.kind).toBe('performance');
    expect(payload.stats.totalRequests).toBe(10);
    expect(payload.stats.successful).toBe(10);
  });

  it('fails when a threshold is not met', async () => {
    const result = await runCli([
      'performance',
      `${server.url}/json`,
      '-n',
      '3',
      '-c',
      '1',
      '--expect-p95',
      '0.000001',
      '--json',
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      passed: boolean;
      thresholds: Array<{ passed: boolean }>;
    };
    expect(payload.passed).toBe(false);
    expect(payload.thresholds.some((threshold) => !threshold.passed)).toBe(true);
  });

  it('validates flag ranges', async () => {
    const tooMany = await runCli(['performance', `${server.url}/json`, '-c', '500']);
    expect(tooMany.code).toBe(2);
    expect(tooMany.stderr).toContain('--concurrency');
    const negative = await runCli(['performance', `${server.url}/json`, '-n', '-5']);
    expect(negative.code).toBe(2);
  });

  it('loads specifications from files', async () => {
    const dir = await project({
      'perf.yaml': `target:\n  url: ${server.url}/json\nconcurrency: 2\nmaxRequests: 4\nthresholds:\n  - metric: successRate\n    min: 100\n`,
    });
    const result = await runCli(['performance', '--config', 'perf.yaml', '--json'], { cwd: dir });
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { stats: { totalRequests: number } };
    expect(payload.stats.totalRequests).toBe(4);
  });
});

describe('security', () => {
  it('analyses a target and exits according to the threshold', async () => {
    const strict = await runCli([
      'security',
      '--url',
      `${server.url}/security/weak`,
      '--threshold',
      'high',
      '--json',
    ]);
    expect(strict.code).toBe(1);
    const payload = JSON.parse(strict.stdout) as {
      kind: string;
      passed: boolean;
      findings: Array<{ id: string }>;
    };
    expect(payload.kind).toBe('security');
    expect(payload.passed).toBe(false);
    expect(payload.findings.some((finding) => finding.id === 'tls.not-used')).toBe(true);

    const lenient = await runCli([
      'security',
      '--url',
      `${server.url}/security/weak`,
      '--threshold',
      'critical',
    ]);
    expect(lenient.code).toBe(0);
  });

  it('validates the specification file and check names', async () => {
    const dir = await project({});
    const unknownCheck = await runCli(
      ['security', '--url', `${server.url}/json`, '--check', 'nonsense'],
      { cwd: dir },
    );
    expect(unknownCheck.code).toBe(3);
    expect(unknownCheck.stderr).toContain('Unknown security check');

    const noTarget = await runCli(['security'], { cwd: dir });
    expect(noTarget.code).toBe(3);
    expect(noTarget.stderr).toContain('A target is required');
  });

  it('never prints raw secret values from findings', async () => {
    const result = await runCli(['security', '--url', `${server.url}/security/weak`, '--verbose']);
    expect(result.stdout).not.toContain('dozjgNryP4J3jVmNHl0w5N');
    expect(result.stdout).toContain('[REDACTED]');
  });
});

describe('contract', () => {
  it('creates a baseline, then confirms compatibility', async () => {
    const dir = await project({});
    const first = await runCli(
      ['contract', `${server.url}/json`, '--name', 'contract-smoke', '--json'],
      { cwd: dir },
    );
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as { snapshotUpdated: boolean; passed: boolean };
    expect(firstPayload.snapshotUpdated).toBe(true);
    expect(firstPayload.passed).toBe(true);

    const second = await runCli(['contract', `${server.url}/json`, '--name', 'contract-smoke'], {
      cwd: dir,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('matches the baseline');
  });
});

describe('import', () => {
  it('imports an OpenAPI document into a runnable suite', async () => {
    const dir = await project({
      'openapi.yaml': `openapi: 3.0.0
info: { title: Mock, version: "1" }
servers: [{ url: "${server.url}" }]
paths:
  /json:
    get:
      operationId: getJson
      responses:
        "200": { description: ok }
`,
    });
    const result = await runCli(['import', 'openapi.yaml'], { cwd: dir });
    expect(result.code).toBe(0);
    const generated = await readFile(join(dir, 'openapi.suite.yaml'), 'utf8');
    expect(generated).toContain('getJson');
    expect(generated).toContain(`baseUrl: ${server.url}`);

    const run = await runCli(['test', 'openapi.suite.yaml'], { cwd: dir });
    expect(run.code).toBe(0);
  });

  it('fails for missing or invalid specifications', async () => {
    const dir = await project({ 'bad.yaml': 'not: an-openapi-document\n' });
    const missing = await runCli(['import', 'nope.yaml'], { cwd: dir });
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain('Specification not found');
    const invalid = await runCli(['import', 'bad.yaml'], { cwd: dir });
    expect(invalid.code).toBe(3);
    expect(invalid.stderr).toContain('not an OpenAPI specification');
  });
});

describe('report', () => {
  it('re-renders a minimal report without a thresholds array', async () => {
    // Regression: `thresholds` is optional, and a report without it crashed the
    // terminal renderer with a raw TypeError.
    const dir = await project({
      'minimal.json': JSON.stringify({
        kind: 'test',
        tool: { name: 'apiforge', version: '0.1.0' },
        title: 't',
        generatedAt: new Date().toISOString(),
        suites: [],
        totals: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, durationMs: 0 },
        passed: false,
      }),
    });
    const result = await runCli(['report', 'minimal.json', '-f', 'terminal'], { cwd: dir });
    expect(result.stderr, result.stderr).not.toContain('Cannot read properties');
    expect(result.stdout + result.stderr).toContain('Summary');
  });

  it('re-renders a saved JSON report', async () => {
    const dir = await project({
      'green.suite.yaml': `name: R\nbaseUrl: ${server.url}\ntests:\n  - name: ok\n    path: /json\n    expect: { status: 200 }\n`,
    });
    const test = await runCli(['test', 'green.suite.yaml', '--reporter', 'json', '--quiet'], {
      cwd: dir,
    });
    expect(test.code).toBe(0);
    const files = await readdir(join(dir, 'reports'));
    const jsonFile = files.find((file) => file.endsWith('.json') && file !== 'latest.json');
    expect(jsonFile).toBeDefined();

    const result = await runCli(
      ['report', join('reports', jsonFile ?? 'latest.json'), '-f', 'html,terminal'],
      { cwd: dir },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Summary');
    const rendered = await readdir(join(dir, 'reports'));
    expect(rendered.some((file) => file.includes('rerender') && file.endsWith('.html'))).toBe(true);
  });

  it('rejects files that are not reports', async () => {
    const dir = await project({ 'not-a-report.json': '{"hello":"world"}' });
    const result = await runCli(['report', 'not-a-report.json'], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Not an APIFORGE report');
  });
});

describe('env', () => {
  it('lists and shows environments with masked secrets', async () => {
    const dir = await project({
      'apiforge.yaml': 'name: x\n',
      'environments/prod.yaml':
        'baseUrl: https://prod.example.com\nvariables:\n  region: eu\nsecrets:\n  apiToken: super-secret-value\n',
    });
    const list = await runCli(['env', 'list', '--json'], { cwd: dir });
    expect(list.code).toBe(0);
    const listPayload = JSON.parse(list.stdout) as {
      environments: Array<{ name: string; secrets: string[] }>;
    };
    expect(listPayload.environments[0]?.name).toBe('prod');
    expect(listPayload.environments[0]?.secrets).toEqual(['apiToken']);

    const show = await runCli(['env', 'show', 'prod'], { cwd: dir });
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('apiToken');
    expect(show.stdout).not.toContain('super-secret-value');
    expect(show.stdout).toContain('…');

    const plain = await runCli(['env'], { cwd: dir });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('prod');
  });

  it('exits 3 for unknown environments', async () => {
    const dir = await project({ 'apiforge.yaml': 'name: x\n' });
    const result = await runCli(['env', 'show', 'nope'], { cwd: dir });
    expect(result.code).toBe(3);
  });

  it('creates an environment file that passes validation', async () => {
    const dir = await project({ 'apiforge.yaml': 'name: x\n' });
    const result = await runCli(['env', 'new', 'staging'], { cwd: dir });
    expect(result.code).toBe(0);
    const file = join(dir, 'environments', 'staging.yaml');
    expect(existsSync(file)).toBe(true);

    const validate = await runCli(['env', 'validate', file], { cwd: dir });
    expect(validate.code).toBe(0);
    const list = await runCli(['env', 'list', '--json'], { cwd: dir });
    expect(list.stdout).toContain('"staging"');
  });

  it('refuses to overwrite an existing environment unless --force is passed', async () => {
    const dir = await project({
      'apiforge.yaml': 'name: x\n',
      'environments/staging.yaml': 'baseUrl: https://custom.example.com\n',
    });
    const file = join(dir, 'environments', 'staging.yaml');

    const refused = await runCli(['env', 'new', 'staging'], { cwd: dir });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('--force');
    expect(await readFile(file, 'utf8')).toBe('baseUrl: https://custom.example.com\n');

    const forced = await runCli(['env', 'new', 'staging', '--force'], { cwd: dir });
    expect(forced.code).toBe(0);
    expect(await readFile(file, 'utf8')).toContain('https://staging.example.com');
  });

  it('rejects invalid environment names with exit code 2', async () => {
    const dir = await project({ 'apiforge.yaml': 'name: x\n' });
    for (const name of ['../evil', '..', 'a/b', 'a\\b']) {
      const result = await runCli(['env', 'new', name], { cwd: dir });
      expect(result.code, name).toBe(2);
      expect(result.stderr).toContain('Invalid environment name');
    }
    expect(existsSync(join(dir, 'environments'))).toBe(false);
    expect(existsSync(join(dir, '..', 'evil.yaml'))).toBe(false);
  });
});

describe('validate', () => {
  it('reports invalid YAML with the parse error', async () => {
    const dir = await project({ 'broken.suite.yaml': 'name: [unclosed\n' });
    const result = await runCli(['validate'], { cwd: dir });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('✖');
    expect(result.stdout).toContain('Validation failed');
  });
});

describe('global behaviour', () => {
  it('rejects unknown commands with exit code 2', async () => {
    const result = await runCli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
  });

  it('suggests close command names', async () => {
    const result = await runCli(['tes']);
    expect(result.stderr.toLowerCase()).toContain('test');
  });

  it('respects NO_COLOR', async () => {
    const result = await runCli(['--help'], { env: { NO_COLOR: '1' } });
    expect(result.stdout).not.toMatch(/\u001B\[/);
  });

  it('emits colour when FORCE_COLOR is set', async () => {
    const result = await runCli(['version'], { env: { NO_COLOR: undefined, FORCE_COLOR: '1' } });
    expect(result.stdout).toMatch(/\u001B\[/);
  });

  it('reports unknown options as usage errors, not Commander crashes', async () => {
    const result = await runCli(['test', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown option "--bogus"');
    // Commander's raw `error:` echo and full help dump must not leak through.
    expect(result.stderr).not.toContain('error: unknown option');
    expect(result.stderr).not.toContain('Usage: apiforge test');
  });

  it('reports missing required arguments as usage errors', async () => {
    const result = await runCli(['run']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Missing required argument');
  });

  it('exits 4 when every test fails for a network reason', async () => {
    // Regression: a suite pointing at an unreachable host exited 1, which CI
    // cannot distinguish from a real assertion failure.
    const dir = await project({
      'dead.suite.yaml': `name: Dead\nbaseUrl: http://127.0.0.1:1\ntests:\n  - name: unreachable\n    path: /x\n    timeoutMs: 300\n`,
    });
    const result = await runCli(['test', 'dead.suite.yaml'], { cwd: dir });
    expect(result.code).toBe(4);
  });

  it('exits 1 when assertions fail against a reachable server', async () => {
    const dir = await project({
      'wrong.suite.yaml': `name: Wrong\nbaseUrl: ${server.url}\ntests:\n  - name: wrong status\n    path: /json\n    expect: { status: 500 }\n`,
    });
    const result = await runCli(['test', 'wrong.suite.yaml'], { cwd: dir });
    expect(result.code).toBe(1);
  });

  it('accepts --no-color on every command', async () => {
    // Regression: meta commands rejected the flag the rest of the CLI accepts.
    for (const args of [
      ['exit-codes', '--no-color'],
      ['version', '--no-color'],
      ['completion', 'bash', '--no-color'],
      ['env', '--no-color'],
      ['validate', '--no-color'],
    ]) {
      const result = await runCli(args);
      expect(result.code, `${args.join(' ')} → ${result.stderr}`).toBeLessThan(2);
    }
  });

  it('--no-color disables colour even on nested subcommands', async () => {
    // Regression: Commander's negated default used to cancel an explicit
    // `--no-color` declared on a child command, emitting ANSI into pipes.
    const dir = await project({
      'apiforge.yaml': 'name: x\n',
      'environments/local.yaml': 'baseUrl: http://localhost:1\nvariables:\n  a: b\n',
    });
    const result = await runCli(['env', 'show', 'local', '--no-color'], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/\u001B\[/);
  });

  it('treats apiforge.yaml as project config, never as a suite', async () => {
    // Regression: directory scanning picked the project file itself up as a
    // suite, so `apiforge test` reported "Invalid apiforge.yaml".
    const dir = await project({
      'apiforge.yaml': 'name: x\n',
      'api.suite.yaml': `name: S\nbaseUrl: ${server.url}\ntests:\n  - name: ok\n    path: /json\n    expect: { status: 200 }\n`,
    });
    const result = await runCli(['test', '--json'], { cwd: dir });
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { kind: string; passed: boolean };
    expect(payload.kind).toBe('test');
    expect(payload.passed).toBe(true);
  });
});
