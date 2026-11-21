/**
 * Regression tests for CodeQL js/file-system-race in `apiforge init`.
 *
 * The previous implementation decided whether to write a starter file with
 * `existsSync(destination)` and wrote it later with a plain `writeFile`. Between
 * the two calls another process could create or swap the path, so an existing
 * file could be replaced even though the CLI had promised to skip it.
 *
 * `runInit` now creates each starter file with the `wx` flag (O_CREAT|O_EXCL),
 * which decides and writes in a single atomic syscall. These tests pin that
 * behaviour: the common paths, the concurrency case, and the error paths.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { runInit } from '../src/lib/project.js';
import type { Ui } from '../src/ui.js';

const dirs: string[] = [];

/** A UI stub — `runInit` only needs the object to exist. */
const ui = {} as unknown as Ui;

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'apiforge-init-'));
  dirs.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(dirs.map((path) => rm(path, { recursive: true, force: true })));
});

const STARTER = 'apiforge.yaml';

describe('runInit — atomic creation', () => {
  it('creates the starter files when nothing exists', async () => {
    const target = await dir();
    const result = await runInit({ directory: target, ui });

    expect(result.created).toContain(STARTER);
    expect(result.created).toContain('.gitignore');
    expect(result.skipped).toEqual([]);
    const manifest = await readFile(join(target, STARTER), 'utf8');
    expect(manifest).toContain('APIFORGE project configuration');
  });

  it('skips an existing file and leaves its contents untouched', async () => {
    const target = await dir();
    const original = 'name: Custom\n';
    await writeFile(join(target, STARTER), original, 'utf8');

    const result = await runInit({ directory: target, ui });

    expect(result.skipped).toContain(STARTER);
    expect(result.created).not.toContain(STARTER);
    // The critical assertion: user data was not lost.
    expect(await readFile(join(target, STARTER), 'utf8')).toBe(original);
  });

  it('overwrites only when --force is passed', async () => {
    const target = await dir();
    await writeFile(join(target, STARTER), 'name: Custom\n', 'utf8');

    const result = await runInit({ directory: target, ui, force: true });

    expect(result.created).toContain(STARTER);
    expect(await readFile(join(target, STARTER), 'utf8')).toContain(
      'APIFORGE project configuration',
    );
  });

  it('creates the destination directory when it does not exist', async () => {
    const parent = await dir();
    const target = join(parent, 'nested', 'deeper');

    const result = await runInit({ directory: target, ui });

    expect(result.created).toContain(STARTER);
    expect(await readFile(join(target, STARTER), 'utf8')).toContain('APIFORGE');
  });

  it('merges missing entries into an existing .gitignore', async () => {
    const target = await dir();
    await writeFile(join(target, '.gitignore'), 'node_modules/\n', 'utf8');

    const result = await runInit({ directory: target, ui });

    expect(result.created).toContain('.gitignore (updated)');
    const content = await readFile(join(target, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('reports/');
    expect(content).toContain('.env');
  });

  it('does not report a change when .gitignore is already complete', async () => {
    const target = await dir();
    const complete = 'reports/\n.apiforge/\n.env\n.env.*\nnode_modules/\n';
    await writeFile(join(target, '.gitignore'), complete, 'utf8');

    const result = await runInit({ directory: target, ui });

    expect(result.created).not.toContain('.gitignore (updated)');
    expect(result.created).not.toContain('.gitignore');
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe(complete);
  });
});

describe('runInit — concurrency', () => {
  it('two simultaneous runs never both claim the same file', async () => {
    const target = await dir();

    const [first, second] = await Promise.all([
      runInit({ directory: target, ui }),
      runInit({ directory: target, ui }),
    ]);

    const claimed = [...first.created, ...second.created].filter((entry) => entry === STARTER);
    expect(claimed).toHaveLength(1);

    const skipped = [...first.skipped, ...second.skipped].filter((entry) => entry === STARTER);
    expect(skipped).toHaveLength(1);
  });

  it('never replaces a file created concurrently by another writer', async () => {
    const target = await dir();
    // Simulate a competing writer that wins the race: seed a file whose
    // contents must survive the init run.
    const winner = 'name: Won the race\n';
    await writeFile(join(target, STARTER), winner, 'utf8');

    const [first, second] = await Promise.all([
      runInit({ directory: target, ui }),
      runInit({ directory: target, ui }),
    ]);

    expect([...first.created, ...second.created]).not.toContain(STARTER);
    expect(await readFile(join(target, STARTER), 'utf8')).toBe(winner);
  });

  it('does not follow a symlink planted at the destination', async () => {
    const target = await dir();
    const outside = await dir();
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'do not touch\n', 'utf8');
    // O_EXCL refuses to follow the link, so the write must not land here.
    await symlink(victim, join(target, STARTER));

    const result = await runInit({ directory: target, ui });

    expect(result.skipped).toContain(STARTER);
    expect(await readFile(victim, 'utf8')).toBe('do not touch\n');
  });
});

describe('runInit — error paths', () => {
  it('propagates an error when the destination cannot be written', async () => {
    const target = await dir();
    await mkdir(join(target, 'suites'), { recursive: true });
    // Read-only project root: creating the starter files must fail loudly.
    await chmod(target, 0o500);
    try {
      await expect(runInit({ directory: target, ui })).rejects.toThrow();
    } finally {
      await chmod(target, 0o700);
    }
  });

  it('propagates unexpected filesystem errors instead of swallowing them', async () => {
    // A path whose parent is a regular file cannot be created at all.
    const target = await dir();
    const blocker = join(target, 'blocker');
    await writeFile(blocker, 'x', 'utf8');

    await expect(runInit({ directory: join(blocker, 'child'), ui })).rejects.toThrow();
  });
});
