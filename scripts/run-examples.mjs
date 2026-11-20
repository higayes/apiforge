#!/usr/bin/env node
/**
 * Run the whole `examples/demo-api` project end to end.
 *
 *   npm run examples
 *
 * Starts the demo API on a free port, rewrites the example environment to point
 * at it, then runs test → performance → security → contract → import and prints
 * a summary. Nothing leaves the machine and no credentials are needed.
 *
 * The example files themselves are never modified: a temporary copy of the
 * project is created so the repository stays clean and reruns are independent.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = join(repoRoot, 'packages/cli/dist/cli.js');
const demoServerPath = join(repoRoot, 'scripts/demo-server.mjs');

// The port the example project documents. Every spec that hardcodes it is
// rewritten to the port this run actually listens on.
const DOCUMENTED_URL = 'http://127.0.0.1:4010';
const TEXT_FILE = /\.(?:ya?ml|json|md|ts|js|mjs)$/;

async function collectFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectFiles(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
const examplesDir = join(repoRoot, 'examples/demo-api');

const green = (t) => (process.stdout.isTTY ? `\u001b[32m${t}\u001b[39m` : t);
const red = (t) => (process.stdout.isTTY ? `\u001b[31m${t}\u001b[39m` : t);
const bold = (t) => (process.stdout.isTTY ? `\u001b[1m${t}\u001b[22m` : t);
const gray = (t) => (process.stdout.isTTY ? `\u001b[90m${t}\u001b[39m` : t);

function freePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => res(port));
    });
    server.on('error', rej);
  });
}

async function startDemoServer(port) {
  const child = spawn(process.execPath, [demoServerPath], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return { url, child };
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`demo server failed to start on ${url}`);
}

function run(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok ? green('✔') : red('✖');
  process.stdout.write(`  ${icon} ${name}${detail ? gray(` — ${detail}`) : ''}\n`);
}

async function main() {
  if (!(await readFile(cliPath, 'utf8').catch(() => undefined))) {
    process.stderr.write(red('✖ packages/cli/dist/cli.js is missing — run `pnpm build` first.\n'));
    process.exit(1);
  }

  const port = await freePort();
  const demo = await startDemoServer(port);
  const workDir = await mkdtemp(join(tmpdir(), 'apiforge-examples-'));

  try {
    // Copy the example project so the repo is never mutated by a demo run.
    await cp(examplesDir, join(workDir, 'project'), { recursive: true });
    const projectDir = join(workDir, 'project');

    // Point every specification at the port we actually got.
    // Walk the whole project rather than a hand-maintained file list: suites that
    // hardcode the documented port (imported/*.yaml, openapi/*.yaml, ...) would
    // otherwise keep pointing at a port this run does not own and fail.
    for (const path of await collectFiles(projectDir)) {
      if (!TEXT_FILE.test(path)) continue;
      const content = await readFile(path, 'utf8').catch(() => undefined);
      if (content === undefined || !content.includes(DOCUMENTED_URL)) continue;
      await writeFile(path, content.replaceAll(DOCUMENTED_URL, demo.url), 'utf8');
    }

    process.stdout.write(`\n${bold('APIFORGE examples')}\n`);
    process.stdout.write(gray(`Demo API: ${demo.url}\nTemporary project: ${projectDir}\n\n`));

    process.stdout.write(`${bold('1. Test suites')}\n`);
    const test = await run(['test', '--reporter', 'json,html,junit'], { cwd: projectDir });
    const testLine = test.stdout.split('\n').find((line) => line.includes('total ·')) ?? '';
    record('apiforge test', test.code === 0, testLine.trim() || `exit ${test.code}`);
    if (test.code !== 0) process.stdout.write(gray(test.stdout.split('\n').slice(-25).join('\n')));

    process.stdout.write(`\n${bold('2. Performance')}\n`);
    const perf = await run(['performance', '--config', 'perf.yaml', '--json'], { cwd: projectDir });
    let perfDetail;
    if (perf.code === 0 || perf.code === 1) {
      try {
        const report = JSON.parse(perf.stdout);
        perfDetail = `${report.stats.totalRequests} requests · p95 ${report.stats.latency.p95.toFixed(1)}ms · ${report.stats.requestsPerSecond.toFixed(1)} rps`;
      } catch {
        perfDetail = 'report parsed';
      }
    }
    record('apiforge performance', perf.code === 0, perfDetail ?? `exit ${perf.code}`);

    process.stdout.write(`\n${bold('3. Security')}\n`);
    const sec = await run(['security', '--config', 'security.yaml', '--json'], { cwd: projectDir });
    let secDetail;
    try {
      const report = JSON.parse(sec.stdout);
      const bySeverity = report.counts?.bySeverity ?? {};
      secDetail = `score ${report.score}/100 · ${bySeverity.critical ?? 0} critical · ${bySeverity.high ?? 0} high · ${bySeverity.medium ?? 0} medium`;
    } catch {
      secDetail = `exit ${sec.code}`;
    }
    record('apiforge security', sec.code === 0, secDetail);

    process.stdout.write(`\n${bold('4. Contract')}\n`);
    const contractCreate = await run(['contract', '--config', 'contract.yaml'], {
      cwd: projectDir,
    });
    record(
      'apiforge contract (baseline)',
      contractCreate.code === 0,
      contractCreate.stdout.includes('Snapshot created')
        ? 'baseline captured'
        : `exit ${contractCreate.code}`,
    );
    const contractCompare = await run(['contract', '--config', 'contract.yaml'], {
      cwd: projectDir,
    });
    record(
      'apiforge contract (compare)',
      contractCompare.code === 0,
      contractCompare.stdout.includes('compatible') ? 'compatible' : `exit ${contractCompare.code}`,
    );

    process.stdout.write(`\n${bold('5. OpenAPI import')}\n`);
    const imported = await run(
      ['import', 'openapi/demo-api.yaml', '-o', 'imported/from-openapi.suite.yaml', '--schemas'],
      { cwd: projectDir },
    );
    record(
      'apiforge import',
      imported.code === 0,
      imported.stdout.match(/Imported \d+ operation\(s\)/)?.[0] ?? '',
    );
    if (imported.code === 0) {
      const generated = await run(['test', 'imported', '--quiet'], { cwd: projectDir });
      record(
        'generated suite runs',
        generated.code === 0,
        generated.stdout
          .split('\n')
          .find((line) => line.includes('total ·'))
          ?.trim() ?? '',
      );
    }

    process.stdout.write(`\n${bold('6. Reports')}\n`);
    // performance/security/contract each overwrite reports/latest.json with their
    // own kind, so re-run the suite to leave a test report for `report` to read.
    await run(['test', '--reporter', 'json'], { cwd: projectDir });
    const report = await run(['report', 'reports/latest.json', '-f', 'html,terminal'], {
      cwd: projectDir,
    });
    record('apiforge report', report.code === 0, 're-rendered reports/latest.json');

    const passed = results.filter((entry) => entry.ok).length;
    const allPassed = passed === results.length;
    process.stdout.write(
      `\n${allPassed ? green('✔ all example runs succeeded') : red('✖ some example runs failed')} — ${passed}/${results.length}\n`,
    );
    if (allPassed) {
      process.stdout.write(gray(`Reports: ${join(projectDir, 'reports')}\n`));
    }
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    demo.child.kill('SIGTERM');
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${red('✖ examples run crashed')}\n${error?.stack ?? error}\n`);
  process.exit(1);
});
