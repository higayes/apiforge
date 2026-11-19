import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // The CLI is exercised end-to-end by spawning the built binary, which v8
      // coverage cannot see. Counting it would report a misleading 0% and drag
      // the project total down; its behaviour is covered by cli.test.ts instead.
      exclude: ['packages/cli/src/cli.ts', 'packages/cli/src/**'],
      reporter: ['text-summary', 'lcov'],
      // Floors sit just under today's real numbers so a regression fails CI
      // without blocking unrelated work on noise.
      thresholds: process.env.APIFORGE_COVERAGE_GATE
        ? { statements: 75, branches: 64, functions: 74, lines: 77 }
        : undefined,
    },
  },
});
