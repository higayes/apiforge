/**
 * Suite discovery for commands that need file lists before parsing
 * (`apiforge validate`). Parsing itself always happens in the engine.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SUITE_PATTERN = /\.(suite\.)?(ya?ml|json)$/i;

/**
 * Conventional data directories. Their contents are inputs to `dataFile`, not
 * suites, so `validate` must not try to parse them as suites.
 */
const DATA_DIRECTORIES = /^(data|datasets|fixtures|testdata)$/i;

export async function collectSuiteFilesForValidation(
  root: string,
  seen = new Set<string>(),
): Promise<string[]> {
  if (seen.has(root)) return [];
  seen.add(root);

  let entries: string[];
  try {
    entries = await readdir(root);
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
    const full = join(root, entry);
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      if (/^environments?$/i.test(entry) || /^env$/i.test(entry)) continue;
      if (DATA_DIRECTORIES.test(entry)) continue;
      files.push(...(await collectSuiteFilesForValidation(full, seen)));
    } else if (SUITE_PATTERN.test(entry)) {
      if (/\.env\.(ya?ml|json)$/i.test(entry)) continue;
      if (/^apiforge\.(ya?ml|json)$/i.test(entry)) continue;
      files.push(full);
    }
  }
  return files;
}
