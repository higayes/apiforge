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
 * LOCAL SAFETY
 * Rewriting the working copy is unavoidable — npm packs the directory *after*
 * `prepack` returns, so an in-memory edit would never reach the tarball. To keep
 * a local `npm pack` from leaving the repo dirty, the original manifest is
 * restored as soon as the tarball has been written, via a chained
 * `postpack` (see package.json).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));
const backupPath = `${manifestPath}.prepack-backup`;
const INTERNAL = /^@apiforge\//;

const original = readFileSync(manifestPath, 'utf8');
const pkg = JSON.parse(original);
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

// Always leave a backup so `postpack` can restore the developer's working copy,
// even when there was nothing to strip.
writeFileSync(backupPath, original);

if (removed.length > 0) {
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`strip-internal-deps: removed ${removed.join(', ')} from the published manifest`);
} else {
  console.log('strip-internal-deps: nothing to remove');
}
