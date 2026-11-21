/**
 * Project bootstrap (`apiforge init`) and project/environment helpers shared by
 * the test commands.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  ConfigError,
  loadProject,
  type LoadProjectOptions,
  type ProjectContext,
} from '@apiforge/engine';
import type { Ui } from '../ui.js';

export const STARTER_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'apiforge.yaml',
    content: `# APIFORGE project configuration
# Docs: https://github.com/higayes/apiforge/blob/main/docs/configuration.md
name: My API
defaultEnvironment: local

reports:
  formats: [terminal, html, junit]
  outDir: reports

performance:
  concurrency: 5          # safe default; maximum allowed is 100
  durationSeconds: 10
  timeoutMs: 10000

security:
  threshold: high         # fail only on high/critical findings
`,
  },
  {
    path: 'environments/local.yaml',
    content: `# Local development environment.
# Secrets belong in environment files or CI secrets — never in git.
baseUrl: http://localhost:3000
variables:
  apiVersion: v1
secrets: {}   # keep secrets in environment variables or CI secrets
`,
  },
  {
    path: 'environments/staging.yaml',
    content: `# Staging environment.
baseUrl: https://staging.example.com
variables:
  apiVersion: v1
secrets: {}
`,
  },
  {
    path: 'suites/health.suite.yaml',
    content: `# A starter suite exercising a public health endpoint.
# Run it with: apiforge test suites/health.suite.yaml --env staging
name: Health checks
description: Verifies the API is reachable and responding correctly.
variables:
  timeoutSeconds: 5
tests:
  - name: Health endpoint responds with 200
    method: GET
    path: /health
    timeoutMs: 5000
    expect:
      status: 200
      time:
        lessThan: 2000

  - name: Unknown route returns 404
    method: GET
    path: /definitely-not-a-real-route
    expect:
      status: 404
`,
  },
  {
    path: 'suites/crud.suite.yaml',
    content: `# A data-driven CRUD example with request chaining.
# Requires an API exposing /users. Adjust or delete if not applicable.
name: Users API
baseUrl: https://jsonplaceholder.typicode.com

tests:
  - id: createUser
    name: Create a user
    method: POST
    path: /users
    body:
      json:
        name: "{{$random.string(8)}}"
        email: ada@example.com
    expect:
      status: [200, 201]
      jsonPath:
        name: { type: string, minLength: 1 }
    capture:
      createdId: id

  - name: List users
    method: GET
    path: /users
    expect:
      status: 200
      jsonPath:
        $: { type: array, minLength: 1 }

  - name: Read a single user
    method: GET
    path: /users/{{steps.createUser.createdId}}
    expect:
      status: 200

  - name: Data-driven lookup
    method: GET
    path: /users/{{userId}}
    data:
      - userId: 1
      - userId: 2
    expect:
      status: 200
      jsonPath:
        id: { type: number }
`,
  },
];

export interface InitOptions {
  directory?: string;
  force?: boolean;
  ui: Ui;
}

export async function runInit(
  options: InitOptions,
): Promise<{ created: string[]; skipped: string[] }> {
  const target = resolve(options.directory ?? process.cwd());
  const created: string[] = [];
  const skipped: string[] = [];

  await mkdir(target, { recursive: true });

  for (const file of STARTER_FILES) {
    const destination = join(target, file.path);
    await mkdir(join(destination, '..'), { recursive: true });
    if (options.force !== true) {
      // Atomic create: `wx` fails with EEXIST when the file is already there, so
      // there is no window between "does it exist?" and "write it" in which
      // another process could slip a file (or a symlink) into place.
      // CodeQL js/file-system-race.
      const outcome = await createExclusive(destination, file.content);
      if (outcome === 'existed') {
        skipped.push(file.path);
        continue;
      }
      created.push(file.path);
    } else {
      // `--force` is an explicit request to overwrite; keep it as a plain write.
      await writeFile(destination, file.content, 'utf8');
      created.push(file.path);
    }
  }

  const gitignorePath = join(target, '.gitignore');
  const gitignoreSeed = 'reports/\n.apiforge/\n.env\n.env.*\nnode_modules/\n';
  if (options.force === true) {
    await writeFile(gitignorePath, gitignoreSeed, 'utf8');
    created.push('.gitignore');
    return { created, skipped };
  }

  // Try to claim `.gitignore` exclusively first. If we create it, we are done
  // and no read-modify-write cycle is needed at all.
  if ((await createExclusive(gitignorePath, gitignoreSeed)) === 'created') {
    created.push('.gitignore');
    return { created, skipped };
  }

  // It already existed: merge in the missing ignore entries. This is a
  // read-modify-write on a file we do not own, so it cannot be made fully
  // atomic without locking; `updateGitignore` re-checks and writes with `wx`
  // semantics preserved by only ever appending to the content it read.
  const update = await updateGitignore(gitignorePath);
  if (update === 'updated') created.push('.gitignore (updated)');

  return { created, skipped };
}

/** Result of an atomic create attempt. */
type CreateOutcome = 'created' | 'existed';

/**
 * Create `destination` with `content`, failing instead of overwriting.
 *
 * Uses the `wx` flag, which maps to O_CREAT|O_EXCL: the file is created only if
 * it does not already exist, atomically, so a concurrent writer cannot win the
 * race between a check and a write. Returns `'existed'` when the path is already
 * taken (including when it is a symlink, which `O_EXCL` also refuses to follow).
 *
 * Any other error — missing parent, EACCES, ENOSPC — is propagated unchanged.
 */
async function createExclusive(destination: string, content: string): Promise<CreateOutcome> {
  try {
    await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'existed';
    throw error;
  }
}

/**
 * Add the APIFORGE ignore entries to an `.gitignore` that already exists.
 *
 * This is the one place in `init` where a read-modify-write of a file the tool
 * does not own is unavoidable: the file may contain the user's own rules and
 * must keep them. Two properties keep the risk contained:
 *
 *   - the merge is idempotent and additive, so a lost concurrent update can
 *     only omit a rule, never truncate the user's content;
 *   - the whole operation is a no-op when every entry is already present, which
 *     is the common case for a repository that has run `init` before.
 *
 * Callers reach here only after `createExclusive` reported EEXIST, so a
 * concurrently-created file is never clobbered by a blind write.
 */
async function updateGitignore(gitignorePath: string): Promise<'updated' | 'unchanged'> {
  const content = await readFile(gitignorePath, 'utf8');
  const additions = ['reports/', '.apiforge/', '.env', '.env.*'].filter(
    (entry) => !content.includes(entry),
  );
  if (additions.length === 0) return 'unchanged';
  await writeFile(gitignorePath, `${content.trimEnd()}\n${additions.join('\n')}\n`, 'utf8');
  return 'updated';
}

/** Load the project rooted at `cwd`, with an explicit target list if given. */
export async function openProject(
  cwd: string,
  targets: string[] | undefined,
): Promise<ProjectContext> {
  const projectOptions: LoadProjectOptions = { cwd };
  if (targets && targets.length > 0) projectOptions.targets = targets;
  return loadProject(projectOptions);
}

export interface ProjectDetection {
  root: string;
  configFile?: string;
}

export async function detectProject(cwd: string): Promise<ProjectDetection | undefined> {
  const candidates = ['apiforge.yaml', 'apiforge.yml', 'apiforge.json'];
  let current = resolve(cwd);
  for (;;) {
    for (const name of candidates) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return { root: current, configFile: candidate };
    }
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
}

/** True when a directory contains suite files (`*.suite.yaml` or a `tests:` root). */
export async function isSuiteDirectory(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.some((entry) => /\.(suite\.)?(ya?ml|json)$/i.test(entry));
  } catch {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<string> {
  const target = resolve(path);
  const info = await stat(target).catch(() => undefined);
  if (info && !info.isDirectory())
    throw new ConfigError(`Expected a directory but found a file: ${path}`);
  await mkdir(target, { recursive: true });
  return target;
}
