/**
 * Packaging tests.
 *
 * These guard the *published artefact*, which the unit tests cannot see:
 *
 *  1. every bare import in the bundle is declared in `dependencies`
 *     (regression: `ajv`/`ajv-formats` were bundled-in but undeclared, so the
 *      published CLI crashed with ERR_MODULE_NOT_FOUND);
 *  2. no dependency is left as `workspace:` (regression: the engine was a
 *     runtime dependency, so `npm install` of the tarball failed outright);
 *  3. `npm pack` produces a tarball containing exactly the intended files;
 *  4. the packed tarball installs into a clean project and its binary runs.
 *
 * The install test is slow (it shells out to npm), so it is opt-in via
 * `APIFORGE_TEST_PACK=1`. CI runs it in the `package` job, where a registry
 * cache is warm.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

// npm ships as a shell script on POSIX and as npm.cmd on Windows; spawning the
// bare name fails with ENOENT there.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distFile = join(cliDir, 'dist', 'cli.js');

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'v8',
  'worker_threads',
  'zlib',
]);

async function packageJson(): Promise<{
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}> {
  return JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
}

/** Bare specifiers the bundle imports at runtime (not bundled, not built-in). */
async function bundleImports(): Promise<string[]> {
  const source = await readFile(distFile, 'utf8');
  const found = new Set<string>();
  // Only real module specifiers: `import … from "x"`, `export … from "x"` and
  // `await import("x")`. A loose search also matches user-facing strings such
  // as `target: '…'` inside the bundle.
  const patterns = [
    /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm,
    /^\s*export\s[^;]*?from\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const match of patterns.flatMap((pattern) => [...source.matchAll(pattern)])) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:')) continue;
    const bare = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] ?? specifier);
    if (NODE_BUILTINS.has(bare)) continue;
    found.add(bare);
  }
  return [...found].sort();
}

describe('packaging', () => {
  it('has a build artefact with a shebang', async () => {
    expect(existsSync(distFile), 'dist/cli.js exists — run `pnpm build`').toBe(true);
    const head = (await readFile(distFile, 'utf8')).slice(0, 40);
    expect(head.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('declares every runtime import as a dependency', async () => {
    const pkg = await packageJson();
    const imported = await bundleImports();
    // Guards against the bundle drifting away from package.json.
    expect(imported.length).toBeGreaterThan(0);
    const missing = imported.filter((specifier) => pkg.dependencies[specifier] === undefined);
    expect(missing, `undeclared runtime dependencies: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no workspace: protocol in published dependencies', async () => {
    // `npm pack` does not rewrite `workspace:` ranges; only `pnpm publish` does.
    // A workspace range here makes the tarball uninstallable for everyone else.
    const pkg = await packageJson();
    const offenders = Object.entries(pkg.dependencies).filter(([, range]) =>
      range.startsWith('workspace:'),
    );
    expect(offenders, `workspace: ranges in dependencies: ${JSON.stringify(offenders)}`).toEqual(
      [],
    );
  });

  it('runs when invoked through a bin name that is not cli.js', async () => {
    // Regression: the entry guard compared the *filename* to `cli.js`, so the
    // CLI did nothing (exit 0, no output) whenever it was launched through the
    // bin symlink — i.e. for every real install. The bundle is copied to a
    // different name, exactly like `node_modules/.bin/apiforge`.
    // Must live inside the package so the bundle's dependencies resolve.
    const dir = await mkdtemp(join(cliDir, '.invocation-'));
    try {
      const renamed = join(dir, 'apiforge');
      await copyFile(distFile, renamed);
      // exec rejects on a non-zero exit, which is itself the assertion that
      // the CLI ran instead of silently doing nothing.
      const { stdout } = await exec(process.execPath, [renamed, '--version'], { cwd: cliDir });
      expect(stdout.trim(), 'the CLI must still print its version').toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('points the bin entry at the built file', async () => {
    const pkg = await packageJson();
    expect(pkg.bin.apiforge).toBe('./dist/cli.js');
    expect(existsSync(join(cliDir, pkg.bin.apiforge as string))).toBe(true);
  });

  it('packs only the intended files', async () => {
    const pkg = await packageJson();
    const { stdout } = await exec(NPM, ['pack', '--dry-run', '--json'], {
      cwd: cliDir,
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
    const [entry] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }>; size: number }>;
    const paths = (entry?.files ?? []).map((file) => file.path);
    expect(paths).toContain('dist/cli.js');
    expect(paths).toContain('package.json');
    for (const path of paths) {
      const top = path.split('/')[0] as string;
      const allowed =
        pkg.files.some((entryPath) => path === entryPath || path.startsWith(`${entryPath}/`)) ||
        path === 'package.json' ||
        top === pkg.files.find((entryPath) => path.endsWith(entryPath));
      expect(allowed, `unexpected file in the tarball: ${path}`).toBe(true);
    }
    // Source and tests must never ship.
    expect(paths.some((path) => path.startsWith('src/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('tests/'))).toBe(false);
  });

  it.runIf(process.env.APIFORGE_TEST_PACK === '1')(
    'installs from the tarball and runs',
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'apiforge-pack-'));
      try {
        const { stdout } = await exec(NPM, ['pack', '--json', '--pack-destination', workDir], {
          cwd: cliDir,
          env: { ...process.env, npm_config_loglevel: 'error' },
        });
        const [entry] = JSON.parse(stdout) as Array<{ filename: string }>;
        const tarball = join(workDir, entry?.filename as string);

        const consumer = join(workDir, 'consumer');
        await exec(NPM, ['init', '-y'], { cwd: workDir });
        await exec(NPM, ['install', tarball, '--no-audit', '--no-fund'], {
          cwd: workDir,
          env: { ...process.env, npm_config_loglevel: 'error' },
        });

        // Follow the real package name: the binary is always `apiforge`, but the
        // install directory is the package name, which may be scoped.
        const pkgName = (await packageJson()).name as string;
        const bin = join(workDir, 'node_modules', ...pkgName.split('/'), 'dist', 'cli.js');
        const version = await exec(process.execPath, [bin, '--version'], { cwd: workDir });
        expect(version.stdout.trim()).toBe((await packageJson()).version);

        // The binary must be able to scaffold and validate its own project.
        await exec(process.execPath, [bin, 'init', consumer], { cwd: workDir });
        const validate = await exec(process.execPath, [bin, 'validate'], { cwd: consumer });
        expect(validate.stdout).toContain('All files are valid');
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
