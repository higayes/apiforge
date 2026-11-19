# Architecture

APIFORGE is a two-package pnpm monorepo. Everything testable lives in the
engine; the CLI is a thin shell over it. The split exists so a future web
dashboard, editor extension or CI plugin can reuse the engine without shelling
out to the binary.

```
packages/engine   @apiforge/engine   pure TypeScript library, no I/O policy
packages/cli      apiforge           Commander front end, bundled with the engine
examples/         demo-api           runnable project used by pnpm examples
scripts/          demo-server.mjs    dependency-free demo API
                  smoke-test.mjs     end-to-end checks against the built CLI
                  run-examples.mjs   full example run
```

The CLI bundles the engine with `noExternal` in `tsup.config.ts`, so a global
install is one self-contained `dist/cli.js`. The published package depends only
on its runtime libraries (commander, undici, yaml, zod).

## Engine layout

| Path                        | Responsibility                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ |
| `config/schema.ts`          | Zod schemas for suites, environments, project, specs; parse helpers            |
| `config/project.ts`         | project discovery, suite loading, environment loading                          |
| `http/client.ts`            | one Undici request: auth, bodies, redirects, timeouts, cancellation, redaction |
| `assertions/expect.ts`      | turns an `expect` block into `AssertionResult[]`                               |
| `assertions/value-check.ts` | the value operator engine and structural equality                              |
| `assertions/json-schema.ts` | Ajv wrapper with friendly error messages                                       |
| `test/runner.ts`            | suite execution: ordering, retries, data rows, captures, bail                  |
| `test/report.ts`            | aggregates suite runs into a `TestReport`                                      |
| `test/thresholds.ts`        | evaluates post-run thresholds                                                  |
| `performance/runner.ts`     | bounded load generation and statistics                                         |
| `security/checks.ts`        | passive checks, severity model, evidence masking                               |
| `contract/shape.ts`         | response-shape inference and structural diff                                   |
| `contract/runner.ts`        | baseline read/write and compatibility verdict                                  |
| `openapi/importer.ts`       | OpenAPI 3.x / Swagger 2.0 → suite                                              |
| `report/*.ts`               | terminal, JSON, JUnit XML and HTML renderers                                   |
| `util/*.ts`                 | templating, paths, stats, redaction, diffing, logging                          |

### Design rules

1. **The engine never calls `process.exit`.** It throws typed errors
   (`UsageError`, `ConfigError`, `ValidationError`, `RequestError`,
   `ReportError`); the CLI maps them to exit codes.
2. **Reports are data.** Renderers consume `types.ts` only, so a new format is a
   pure function.
3. **Secrets never leave the process.** URLs are redacted before they reach a
   report, response previews are scrubbed, and security evidence passes through
   `maskSecretsInText`.
4. **Load is bounded.** Concurrency, duration and request counts are validated
   against hard ceilings before any request is sent.
5. **Invalid input fails loudly, at the right granularity.** A bad suite file
   fails the run with a field path; an unreadable data file fails only its test.

## Testing strategy

| Layer          | Where                            | What it proves                                                                           |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Unit           | `packages/engine/tests/**`       | templating, stats, diffing, redaction, schemas                                           |
| Integration    | `packages/engine/tests/**`       | real HTTP against `helpers/mock-server.ts` (gzip, redirects, slow, auth, cookies, flaky) |
| CLI end-to-end | `packages/cli/tests/cli.test.ts` | spawns the **built** `dist/cli.js`, asserts exit codes and machine-readable output       |
| Smoke          | `scripts/smoke-test.mjs`         | 53 checks of the packaged artefact, run by `pnpm verify`                                 |

`pnpm verify` is the gate that CI runs: format → lint → typecheck → test →
build → smoke.

## Adding a command

1. Create `packages/cli/src/commands/<name>.ts` exporting
   `register<Name>Command(program: Command)`.
2. Put logic in the engine if it is testable without a terminal.
3. Use `createUiFromCommand(options)` — it handles `--json`, `--no-color`,
   `--quiet` and `--verbose` consistently.
4. Emit output with `emitReport` so reports and `--json` stay in sync.
5. Map failures by throwing typed errors; never set an exit code by hand except
   `EXIT_CHECKS_FAILED` for "ran fine, checks failed".
6. Add cases to `packages/cli/tests/cli.test.ts` and a line to the smoke test.

## Adding a report format

1. Add a renderer in `packages/engine/src/report/<name>.ts` that takes the
   report type and returns a string.
2. Register it in `report/writer.ts` and add it to the `ReportFormat` union.
3. Extend `parseFormats` in the CLI (it validates the names).
4. Test with a fixture report; assert on structure, not on exact whitespace.
