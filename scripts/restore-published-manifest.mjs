#!/usr/bin/env node
/**
 * Restore packages/cli/package.json after a pack/publish, so that a local
 * `npm pack` does not leave the working copy dirty with the stripped manifest
 * written by `strip-internal-deps.mjs`. Runs as `postpack`.
 *
 * The backup is written before every pack attempt and removed here. If it is
 * missing (postpack run without a matching prepack) this is a no-op.
 */
import { renameSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));
const backupPath = `${manifestPath}.prepack-backup`;

if (existsSync(backupPath)) {
  renameSync(backupPath, manifestPath);
  console.log('restore-published-manifest: working copy restored');
} else {
  console.log('restore-published-manifest: no backup found, nothing to restore');
}

// Defensive: never leave the backup file behind in a packaged tree.
rmSync(backupPath, { force: true });
