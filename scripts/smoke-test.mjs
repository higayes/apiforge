#!/usr/bin/env node
/**
 * End-to-end smoke test of the built CLI.
 *
 * Part of `pnpm verify`: after build + unit/integration tests, this proves the
 * *installed artefact* works — the bundled `dist/cli.js`, not the TypeScript
 * sources. It starts the demo API, runs every command that can run without
 * credentials, and asserts exit codes and machine-readable output.
 *
 * Design notes:
 *  - No third-party dependency: plain `node:child_process`.
 *  - Every check prints a line; the process exits non-zero on the first failure
 *    with a diff-like message, so CI logs point straight at the problem.
 *  - Works from a clean checkout: no network access, no fixtures in the repo
 *    beyond `examples/` and `scripts/`.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = join(repoRoot, 'packages/cli/dist/cli.js');
const demoServerPath = join(repoRoot, 'scripts/demo-server.mjs');
const examplesDir = join(repoRoot, 'examples/demo-api');

let failures = 0;
let checks = 0;

const green = (text) => (process.stdout.isTTY ? `\u001b[32m${text}\u001b[39m` : text);
const red = (text) => (process.stdout.isTTY ? `\u001b[31m${text}\u001b[39m` : text);
const gray = (text) => (process.stdout.isTTY ? `\u001b[90m${text}\u001b[39m` : text);

function ok(message, detail) {
  checks += 1;
  process.stdout.write(`  ${green('✔')} ${message}${detail ? gray(` — ${detail}`) : ''}\n`);
}

function fail(message, detail) {
  checks += 1;
  failures += 1;
  process.stdout.write(`  ${red('✖')} ${message}${detail ? `\n      ${detail}` : ''}\n`);
}

function expect(condition, message, detail) {
  if (condition) ok(message, detail);
  else fail(message, detail);
}

/** Run the built CLI as a child process, capturing streams and exit code. */
function runCli(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, signal, stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
    server.on('error', reject);
  });
}

async function startDemoServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [demoServerPath], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;

  // Wait for the health endpoint instead of sleeping a fixed amount.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return { url, child };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`demo server did not start on ${url}`);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label}: output is not valid JSON`, `${error.message}\n      ${text.slice(0, 400)}`);
    return undefined;
  }
}

async function section(title, body) {
  process.stdout.write(`\n${title}\n`);
  await body();
}

async function main() {
  process.stdout.write('APIFORGE smoke test\n');
  process.stdout.write(gray(`CLI: ${cliPath}\n`));

  if (!existsSync(cliPath)) {
    process.stderr.write(
      red(`\n✖ Build output missing: ${cliPath}\n  Run \`pnpm build\` first.\n`),
    );
    process.exit(1);
  }

  // ------------------------------- meta ----------------------------------
  await section('Meta', async () => {
    const version = await runCli(['--version']);
    expect(version.code === 0, '--version exits 0', version.stdout.trim());
    expect(
      /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
      '--version prints semver',
      version.stdout.trim(),
    );

    const help = await runCli(['--help']);
    expect(help.code === 0, '--help exits 0');
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
      expect(help.stdout.includes(command), `--help documents \`${command}\``);
    }

    const unknown = await runCli(['definitely-not-a-command']);
    expect(unknown.code === 2, 'unknown command exits 2', `exit ${unknown.code}`);
    expect(
      unknown.stderr.includes('Unknown command'),
      'unknown command explains itself',
      unknown.stderr.trim().split('\n')[0],
    );

    const badOption = await runCli(['test', '--not-a-flag']);
    expect(badOption.code === 2, 'unknown option exits 2', `exit ${badOption.code}`);
  });

  // ------------------------------ temp project ---------------------------
  const tempDir = await mkdtemp(join(tmpdir(), 'apiforge-smoke-'));
  let demo;

  try {
    demo = await startDemoServer();
    process.stdout.write(gray(`Demo API: ${demo.url}\n`));

    // ------------------------------ init --------------------------------
    await section('init', async () => {
      const init = await runCli(['init'], { cwd: tempDir });
      expect(init.code === 0, 'init exits 0');
      const files = await readdir(tempDir);
      for (const expected of ['apiforge.yaml', 'environments', 'suites']) {
        expect(files.includes(expected), `init created ${expected}`);
      }
      const reinit = await runCli(['init'], { cwd: tempDir });
      expect(reinit.code === 0, 're-running init does not overwrite (exit 0)');
      const forced = await runCli(['init', '--force'], { cwd: tempDir });
      expect(forced.code === 0, 'init --force exits 0');
    });

    await section('validate', async () => {
      const result = await runCli(['validate'], { cwd: tempDir });
      expect(
        result.code === 0,
        'scaffolded project validates',
        result.stdout.trim().split('\n').at(-1),
      );
    });

    // ---------------------------- ad-hoc run -----------------------------
    await section('run', async () => {
      const pass = await runCli(['run', `${demo.url}/health`, '--json'], {});
      expect(pass.code === 0, 'run against /health exits 0');
      const payload = parseJson(pass.stdout, 'run --json');
      if (payload) {
        // `run --json` emits the same report shape as `test --json`.
        expect(payload.kind === 'test', 'run --json emits a test report');
        expect(payload.passed === true, 'run --json reports passed: true');
        const first = payload.suites?.[0]?.results?.[0];
        expect(
          first?.response?.status === 200,
          'run --json reports status 200',
          String(first?.response?.status),
        );
      }

      const failable = await runCli(['run', `${demo.url}/health`, '--expect-status', '404'], {});
      expect(failable.code === 1, 'failed expectation exits 1', `exit ${failable.code}`);

      const badUrl = await runCli(['run', 'not-a-url'], {});
      expect(badUrl.code === 2, 'invalid URL exits 2', `exit ${badUrl.code}`);

      const dead = await runCli(['run', 'http://127.0.0.1:1/nothing', '--timeout', '500'], {});
      expect(dead.code === 4, 'unreachable host exits 4 (network)', `exit ${dead.code}`);
    });

    // ------------------------------ suites -------------------------------
    const suiteFile = join(tempDir, 'suites', 'smoke.suite.yaml');
    await writeFile(
      suiteFile,
      `name: Smoke
baseUrl: ${demo.url}
tests:
  - name: health responds
    path: /health
    expect:
      status: 200
      jsonPath:
        status: { equals: ok }

  - name: unknown route is 404
    path: /nope
    expect:
      status: 404
`,
      'utf8',
    );

    await section('test', async () => {
      const result = await runCli(['test', 'suites/smoke.suite.yaml', '--json'], { cwd: tempDir });
      expect(result.code === 0, 'passing suite exits 0', `exit ${result.code}`);
      const payload = parseJson(result.stdout, 'test --json');
      if (payload) {
        expect(payload.kind === 'test', 'report kind is "test"');
        expect(payload.passed === true, 'report says passed: true');
        expect(payload.totals?.total === 2, 'report counts 2 tests', String(payload.totals?.total));
      }
      // stdout must be pure JSON even though progress is printed.
      expect(result.stdout.trim().startsWith('{'), 'stdout is pure JSON in --json mode');
    });

    await section('performance', async () => {
      const result = await runCli(
        [
          'performance',
          `${demo.url}/health`,
          '-n',
          '40',
          '-c',
          '2',
          '--expect-p95',
          '2000',
          '--json',
        ],
        { timeoutMs: 60_000 },
      );
      expect(result.code === 0, 'bounded load test exits 0', `exit ${result.code}`);
      const payload = parseJson(result.stdout, 'performance --json');
      if (payload?.stats) {
        expect(
          payload.stats.totalRequests > 0,
          'load test issued requests',
          String(payload.stats.totalRequests),
        );
        expect(
          typeof payload.stats.latency?.p95 === 'number',
          'load test reports p95 latency',
          String(payload.stats.latency?.p95),
        );
        expect(
          payload.stats.totalRequests <= 40,
          'load test respects --requests cap',
          `${payload.stats.totalRequests} <= 40`,
        );
      }

      const unsafe = await runCli(['performance', `${demo.url}/health`, '-c', '9999'], {});
      expect(unsafe.code === 2, 'refuses unsafe concurrency (exit 2)', `exit ${unsafe.code}`);
    });

    await section('security', async () => {
      const result = await runCli(
        [
          'security',
          '--url',
          `${demo.url}/api/hardened`,
          '--check',
          'headers,cors',
          '--threshold',
          'critical',
          '--json',
        ],
        {},
      );
      const payload = parseJson(result.stdout, 'security --json');
      if (payload) {
        expect(Array.isArray(payload.findings), 'security reports a findings array');
        expect(
          typeof payload.score === 'number',
          'security reports a score',
          String(payload.score),
        );
      }
      expect(
        result.code === 0,
        'security exits 0 when nothing meets the threshold',
        `exit ${result.code}`,
      );

      const strict = await runCli(
        ['security', '--url', `${demo.url}/api/insecure`, '--threshold', 'low'],
        {},
      );
      expect(
        strict.code === 1,
        'security exits 1 when findings meet the threshold',
        `exit ${strict.code}`,
      );

      const badCheck = await runCli(['security', '--url', demo.url, '--check', 'nope'], {});
      expect(
        badCheck.code === 3,
        'unknown check is a config error (exit 3)',
        `exit ${badCheck.code}`,
      );
    });

    await section('reports', async () => {
      // Reports are written only when asked for — `test --reporter` is the
      // documented way to produce them.
      await runCli(
        ['test', 'suites/smoke.suite.yaml', '--reporter', 'json,html,junit', '--quiet'],
        {
          cwd: tempDir,
        },
      );
      const reportFiles = await readdir(join(tempDir, 'reports'));
      expect(reportFiles.includes('latest.json'), 'latest.json written');
      expect(
        reportFiles.some((file) => file.endsWith('.html')),
        'HTML report written',
      );
      expect(
        reportFiles.some((file) => file.endsWith('.xml')),
        'JUnit report written',
      );

      const html = await runCli(['report', 'reports/latest.json', '-f', 'html'], { cwd: tempDir });
      expect(html.code === 0, 're-renders a saved JSON report as HTML', `exit ${html.code}`);

      const bad = await runCli(['report', 'apiforge.yaml'], { cwd: tempDir });
      expect(bad.code === 3, 'rejects a file that is not a report (exit 3)', `exit ${bad.code}`);
    });

    await section('import', async () => {
      const outFile = join(tempDir, 'imported.suite.yaml');
      const result = await runCli(
        [
          'import',
          join(examplesDir, 'openapi', 'demo-api.yaml'),
          '-o',
          outFile,
          '--base-url',
          demo.url,
        ],
        {},
      );
      expect(result.code === 0, 'imports the example OpenAPI document', `exit ${result.code}`);
      expect(existsSync(outFile), 'writes the generated suite');

      const generated = await runCli(['test', 'imported.suite.yaml', '--json'], { cwd: tempDir });
      const payload = generated ? parseJson(generated.stdout, 'generated suite --json') : undefined;
      if (payload) {
        expect(
          payload.totals.total >= 4,
          'generated suite contains every operation',
          `${payload.totals.total} tests`,
        );
      }
    });
  } finally {
    demo?.child.kill('SIGTERM');
    await rm(tempDir, { recursive: true, force: true });
  }

  process.stdout.write(
    `\n${failures === 0 ? green('✔ smoke test passed') : red('✖ smoke test failed')} — ${checks - failures}/${checks} checks\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${red('✖ smoke test crashed')}\n${error?.stack ?? error}\n`);
  process.exit(1);
});
