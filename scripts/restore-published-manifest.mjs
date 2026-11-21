#!/usr/bin/env node
/**
 * Restore packages/cli/package.json after a pack/publish, so a local `npm pack`
 * does not leave the working copy holding the stripped manifest written by
 * `strip-internal-deps.mjs`. Runs as `postpack`.
 *
 * The backup is created once by `prepack` and removed here, so normal
 * pack → postpack cycles leave the tree exactly as they found it.
 *
 * TWO SAFETY CHECKS, both learned from a real data-loss bug:
 *
 *   - A backup must still declare the internal devDependencies. If it does not,
 *     it was itself taken from an already-stripped manifest and restoring it
 *     would silently delete `workspace:*` from the committed file. Refuse, and
 *     say so loudly, rather than restore a damaged copy.
 *   - If `postpack` finds no backup (a hand-run pack, or a pack that aborted
 *     before `prepack`), it is a no-op.
 */
import { readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));
const backupPath = `${manifestPath}.prepack-backup`;

const restore = (reason) => {
  if (existsSync(backupPath)) renameSync(backupPath, manifestPath);
  console.log(`restore-published-manifest: ${reason}`);
};

if (!existsSync(backupPath)) {
  restore('no backup found, nothing to restore');
  process.exit(0);
}

// A valid backup is the pristine manifest: it must still carry the internal
// devDependencies that `prepack` strips.
const isPristine = (file) => {
  try {
    const backup = JSON.parse(readFileSync(file, 'utf8'));
    const specs = Object.values(backup.devDependencies ?? {}).map(String);
    return specs.some((spec) => spec.includes('workspace:'));
  } catch {
    return false;
  }
};

const backupIsPristine = isPristine(backupPath);

if (!backupIsPristine) {
  rmSync(backupPath, { force: true });
  console.error(
    'restore-published-manifest: backup is missing the internal devDependencies, so it is ' +
      'not a pristine manifest. Leaving the working copy untouched — restore it with ' +
      '`git checkout -- packages/cli/package.json` if it looks stripped.',
  );
  process.exit(0);
}

restore('working copy restored');
