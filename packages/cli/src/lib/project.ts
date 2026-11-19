/**
 * Project bootstrap (`apiforge init`) and project/environment helpers shared by
 * the test commands.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ConfigError, loadProject, type LoadProjectOptions, type ProjectContext } from '@apiforge/engine';
import type { Ui } from '../ui.js';

export const STARTER_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'apiforge.yaml',
    content: `# APIFORGE project configuration
# Docs: https://github.com/apiforge/apiforge/blob/main/docs/configuration.md
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

export async function runInit(options: InitOptions): Promise<{ created: string[]; skipped: string[] }> {
  const target = resolve(options.directory ?? process.cwd());
  const created: string[] = [];
  const skipped: string[] = [];

  await mkdir(target, { recursive: true });

  for (const file of STARTER_FILES) {
    const destination = join(target, file.path);
    if (existsSync(destination) && options.force !== true) {
      skipped.push(file.path);
      continue;
    }
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
    created.push(file.path);
  }

  const gitignorePath = join(target, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, 'utf8');
    const additions = ['reports/', '.apiforge/', '.env', '.env.*'].filter((entry) => !content.includes(entry));
    if (additions.length > 0) {
      await writeFile(gitignorePath, `${content.trimEnd()}\n${additions.join('\n')}\n`, 'utf8');
      created.push('.gitignore (updated)');
    }
  } else {
    await writeFile(gitignorePath, 'reports/\n.apiforge/\n.env\n.env.*\nnode_modules/\n', 'utf8');
    created.push('.gitignore');
  }

  return { created, skipped };
}

/** Load the project rooted at `cwd`, with an explicit target list if given. */
export async function openProject(cwd: string, targets: string[] | undefined): Promise<ProjectContext> {
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
  if (info && !info.isDirectory()) throw new ConfigError(`Expected a directory but found a file: ${path}`);
  await mkdir(target, { recursive: true });
  return target;
}
