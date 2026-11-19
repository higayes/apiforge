import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  // The engine is a workspace package: bundling it keeps the published CLI
  // self-contained (only its runtime dependencies remain external), avoiding
  // version-skew problems between CLI and engine at install time.
  noExternal: ['@apiforge/engine'],
  external: ['undici', 'zod', 'yaml', 'ajv', 'ajv-formats', 'commander'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __APIFORGE_VERSION__: JSON.stringify(pkg.version) },
  dts: false,
  shims: false,
});
