#!/usr/bin/env node
/**
 * Strip monorepo-internal devDependencies from the manifest npm publishes.
 *
 * WHY THIS EXISTS
 * `@apiforge/engine` is a workspace package referenced as `workspace:*`, a
 * protocol only pnpm understands. It is bundled into `dist/cli.js` at build time
 * (`noExternal` in tsup.config.ts), so it is never needed at runtime — but npm
 * does not understand the protocol and keeps the spec verbatim in the tarball.
 * There it is dead weight at best and a hard failure at worst:
 *
 *   npm  install   inside an unpacked tarball → EUNSUPPORTEDPROTOCOL "workspace:*"
 *   pnpm install   next to an unpacked tarball → ERR_PNPM_WORKSPACE_PKG_NOT_FOUND
 *
 * Consumers installing the package *as a dependency* are unaffected, because
 * devDependencies are never installed for a dependency. The failure only hits
 * people who unpack the published tarball and install it — which is exactly what
 * `npm stage download` + manual inspection does.
 *
 * WHY NOT JUST DELETE THE FIELD FROM package.json
 * It is a genuine build-time dependency. Removing it was tried: pnpm stops
 * linking `@apiforge/engine` into packages/cli and `tsup` fails with
 * "Could not resolve @apiforge/engine", so the build cannot find the engine.
 *
 * WHY prepack
 * `npm publish` and `npm stage publish` both run `prepack` before packing the
 * directory, so the rewritten manifest is what lands in the tarball. Nothing is
 * published from CI's throwaway checkout, so the rewrite is harmless there.
 *
 * LOCAL SAFETY — the backup is permanent until postpack removes it
 * Rewriting the working copy is unavoidable — npm packs the directory *after*
 * `prepack` returns, so an in-memory edit would never reach the tarball. Two
 * rules keep a failed pack from destroying the developer's manifest:
 *
 *   1. An existing backup is never overwritten. The backup is the *original*
 *      manifest; if a previous pack aborted after `prepack`, the file on disk is
 *      already stripped and is NOT a valid source for a new backup.
 *   2. Stripping is idempotent, so re-running it on an already-stripped manifest
 *      is harmless and reports that there was nothing to remove.
 *
 * Without rule 1 a failed pack leaked permanently: pack #1 wrote the backup and
 * aborted; pack #2 saw an already-stripped manifest, overwrote the only copy of
 * the original, and `postpack` then "restored" a stripped manifest — silently
 * deleting `workspace:*` from the committed file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));
const backupPath = `${manifestPath}.prepack-backup`;
const INTERNAL = /^@apiforge\//;

// Rule 1: keep the earliest backup. It is the only pristine copy.
//
// `wx` fails with EEXIST when the file is already there, which both expresses
// "create only if absent" and does it atomically. An existsSync-then-writeFileSync
// pair races: CodeQL flags it as js/file-system-race, and the race is real even
// here — two concurrent packs in the same checkout would both see "absent" and
// the second would overwrite the pristine copy with an already-stripped one,
// which is exactly the data loss this rule exists to prevent.
try {
  writeFileSync(backupPath, readFileSync(manifestPath, 'utf8'), { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  // A backup already exists — keep it.
}

const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
const removed = [];

for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const name of Object.keys(deps)) {
    if (INTERNAL.test(name) || String(deps[name]).includes('workspace:')) {
      delete deps[name];
      removed.push(`${field}.${name}`);
    }
  }
  if (Object.keys(deps).length === 0) delete pkg[field];
}

// Rule 2: idempotent. Re-running on a stripped manifest is a no-op.
if (removed.length > 0) {
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`strip-internal-deps: removed ${removed.join(', ')} from the published manifest`);
} else {
  console.log('strip-internal-deps: nothing to remove (manifest already stripped)');
}
