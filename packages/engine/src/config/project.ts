/**
 * Project discovery and environment loading.
 *
 * A project directory may contain `apiforge.yaml` / `apiforge.yml` /
 * `apiforge.json`, suites anywhere, and environments either under
 * `environments/` or inlined into a suite file.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigError } from '../errors.js';
import { expandEnvDeep } from '../util/env-interpolation.js';
import {
  type EnvironmentDefinition,
  type ProjectConfig,
  type SuiteDefinition,
  parseEnvironmentDocument,
  parseProjectDocument,
  parseSuiteDocument,
  parseDocument,
} from './schema.js';

export const PROJECT_FILE_NAMES = ['apiforge.yaml', 'apiforge.yml', 'apiforge.json'] as const;
export const SUITE_FILE_PATTERN = /\.(suite\.)?(ya?ml|json)$/i;

/** True when a file name is the project configuration, not a suite. */
function isProjectFile(name: string): boolean {
  return (PROJECT_FILE_NAMES as readonly string[]).includes(name);
}

export interface LoadedSuite {
  /** Absolute path of the suite file. */
  file: string;
  /** Path relative to the project root (or the file itself when no project). */
  relativeFile: string;
  suite: SuiteDefinition;
  /** Environment inlined into the suite file (`environment:` key), if any. */
  inlineEnvironment?: string;
}

export interface LoadedEnvironment {
  name: string;
  file: string;
  environment: EnvironmentDefinition;
}

export interface ProjectContext {
  root: string;
  config: ProjectConfig;
  configFile?: string;
  suites: LoadedSuite[];
  environments: Map<string, LoadedEnvironment>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(startDir: string): Promise<string | undefined> {
  let current = resolve(startDir);
  for (;;) {
    for (const name of PROJECT_FILE_NAMES) {
      if (await pathExists(join(current, name))) return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function readTextFile(path: string, context = 'file'): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') throw new ConfigError(`${context} not found: ${path}`, [], error);
    if (code === 'EACCES')
      throw new ConfigError(`Permission denied reading ${context}: ${path}`, [], error);
    if (code === 'EISDIR')
      throw new ConfigError(`${context} is a directory, expected a file: ${path}`, [], error);
    throw new ConfigError(
      `Could not read ${context}: ${path}`,
      [String((error as Error).message)],
      error,
    );
  }
}

async function loadProjectConfig(root: string): Promise<{ config: ProjectConfig; file?: string }> {
  for (const name of PROJECT_FILE_NAMES) {
    const candidate = join(root, name);
    if (await pathExists(candidate)) {
      const content = await readTextFile(candidate, 'project configuration');
      return { config: parseProjectDocument(parseDocument(content, name), name), file: candidate };
    }
  }
  return { config: {} };
}

/**
 * Recursively collect suite files, skipping node_modules, reports and hidden
 * directories. Symlinked loops are avoided by resolving real paths.
 */
async function collectSuiteFiles(
  dir: string,
  root: string,
  seen = new Set<string>(),
  dataFilePattern: RegExp | undefined = undefined,
): Promise<string[]> {
  const real = resolve(dir);
  if (seen.has(real)) return [];
  seen.add(real);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    if (
      entry.startsWith('.') ||
      entry === 'node_modules' ||
      entry === 'reports' ||
      entry === 'coverage'
    )
      continue;
    const full = join(dir, entry);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      files.push(...(await collectSuiteFiles(full, root, seen, dataFilePattern)));
    } else if (SUITE_FILE_PATTERN.test(entry)) {
      // The project file and environment files are configuration, not suites.
      if (isProjectFile(entry)) continue;
      // A file referenced by a suite's `dataFile` is test data, not a suite.
      if (dataFilePattern?.test(entry) === true) continue;
      if (/\benvironments?[\\/]/i.test(relative(root, full))) continue;
      if (/\.env\.(ya?ml|json)$/i.test(entry)) continue;
      files.push(full);
    }
  }
  return files;
}

function looksLikeSuite(document: unknown): document is Record<string, unknown> {
  return (
    document !== null &&
    typeof document === 'object' &&
    !Array.isArray(document) &&
    'tests' in (document as object)
  );
}

function looksLikeEnvironment(document: unknown): boolean {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return false;
  const record = document as Record<string, unknown>;
  return (
    !('tests' in record) && ('variables' in record || 'baseUrl' in record || 'secrets' in record)
  );
}

export interface LoadSuitesOptions {
  /**
   * Skip files that are clearly not suites (no `tests` key) instead of failing.
   * Used for directory discovery; explicitly requested files stay strict.
   */
  lenient?: boolean;
  /** Receives files skipped in lenient mode, for diagnostics. */
  onSkip?: (file: string, reason: string) => void;
  /** Treat any file without a `tests` key as data, even when named explicitly. */
  allowNonSuites?: boolean;
}

export async function loadSuitesFromFiles(
  files: string[],
  root: string,
  options: LoadSuitesOptions = {},
): Promise<LoadedSuite[]> {
  const loaded: LoadedSuite[] = [];
  for (const file of files) {
    const relativeFile = relative(root, file) || file;
    const content = await readTextFile(file, 'suite file');
    const document = parseDocument(content, relativeFile);
    if (
      (options.lenient === true || options.allowNonSuites === true) &&
      !looksLikeSuite(document)
    ) {
      options.onSkip?.(relativeFile, 'no `tests` key');
      continue;
    }
    const suite = parseSuiteDocument(document, relativeFile);
    loaded.push({ file, relativeFile, suite });
  }
  return loaded;
}

export async function loadEnvironments(
  root: string,
  config: ProjectConfig,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<Map<string, LoadedEnvironment>> {
  const environments = new Map<string, LoadedEnvironment>();
  const configured = config.environmentsDir;
  const candidates = configured
    ? [resolve(root, configured)]
    : [join(root, 'environments'), join(root, 'env')];

  for (const dir of candidates) {
    if (!(await pathExists(dir))) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!/\.(ya?ml|json)$/i.test(entry)) continue;
      const file = join(dir, entry);
      const name = entry.replace(/\.(ya?ml|json)$/i, '');
      const content = await readTextFile(file, 'environment file');
      const document = parseDocument(content, relative(root, file));
      if (!looksLikeEnvironment(document)) {
        throw new ConfigError(
          `Environment file ${relative(root, file)} does not look like an environment`,
          [
            'Expected keys such as `baseUrl`, `variables` and/or `secrets` (a `tests` list means it is a suite file).',
          ],
        );
      }
      const environment = parseEnvironmentDocument(
        expandEnvDeep(document, { env: options.env }),
        relative(root, file),
      );
      environments.set(name, { name, file, environment });
    }
  }
  return environments;
}

export interface LoadProjectOptions {
  /** Directory to search from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra suite files or directories supplied on the command line. */
  targets?: string[];
  /** Load every suite in the project (default when no targets are given). */
  all?: boolean;
}

export async function loadProject(options: LoadProjectOptions = {}): Promise<ProjectContext> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = (await findProjectRoot(cwd)) ?? cwd;
  const { config, file: configFile } = await loadProjectConfig(root);

  let files: string[] = [];
  const targets = options.targets ?? [];
  if (targets.length > 0) {
    for (const target of targets) {
      const abs = isAbsolute(target) ? target : resolve(cwd, target);
      if (!(await pathExists(abs))) throw new ConfigError(`Suite target not found: ${target}`);
      const info = await stat(abs);
      if (info.isDirectory()) {
        const found = await collectSuiteFiles(abs, root);
        if (found.length === 0)
          throw new ConfigError(`No suite files found in directory: ${target}`);
        files.push(...found);
      } else {
        files.push(abs);
      }
    }
  } else if (config.suites && config.suites.length > 0) {
    for (const entry of config.suites) {
      const abs = resolve(root, entry);
      if (!(await pathExists(abs)))
        throw new ConfigError(
          `Suite listed in ${configFile ?? 'project config'} not found: ${entry}`,
        );
      const info = await stat(abs);
      if (info.isDirectory()) files.push(...(await collectSuiteFiles(abs, root)));
      else files.push(abs);
    }
  } else {
    files = await collectSuiteFiles(root, root);
  }

  // De-duplicate while preserving order.
  files = [...new Set(files)];

  // When files were *discovered* by scanning (rather than named explicitly),
  // skip anything that is not a suite document. Project directories hold more
  // than suites — data files for `dataFile`, OpenAPI documents, fixtures — and
  // failing the whole run because `data/users.json` is an array would be
  // hostile. Explicitly named files are always validated strictly.
  const suites = await loadSuitesFromFiles(files, root, {
    lenient: options.targets === undefined && !config.suites?.length,
  });
  const environments = await loadEnvironments(root, config);
  return { root, config, ...(configFile ? { configFile } : {}), suites, environments };
}

/** Load a single suite file without requiring a project. */
export async function loadSuiteFile(file: string): Promise<LoadedSuite> {
  const abs = resolve(file);
  const content = await readTextFile(abs, 'suite file');
  const document = parseDocument(content, abs);
  if (!looksLikeSuite(document)) {
    throw new ConfigError(`${file} does not look like a suite file`, [
      'A suite must be an object containing at least a `tests` array.',
    ]);
  }
  const suite = parseSuiteDocument(document, file);
  return { file: abs, relativeFile: file, suite };
}

export { looksLikeSuite, looksLikeEnvironment };
