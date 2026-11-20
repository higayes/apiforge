# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor releases may contain breaking changes; they
are always listed under **Changed**.

## [Unreleased]

### Fixed

- **The installed CLI did nothing.** The bundle only started when its own
  filename was `cli.js`, but npm and pnpm expose the binary as a symlink
  (`node_modules/.bin/apiforge`), so `apiforge --version` exited 0 with no
  output for every real install. The guard now compares realpaths, and a
  regression test invokes the bundle under a different name.
- `pnpm verify` ran the tests before the build even though the CLI tests execute
  the built bundle, so a fresh clone failed all 54 CLI tests. The build now runs
  first, and `pnpm test`, `pnpm smoke` and `pnpm examples` build first too.
- The CLI test helper reports a missing bundle with an actionable message instead
  of an opaque non-zero exit code.
- The coverage gate used a POSIX-only inline environment variable, which broke on
  Windows; the thresholds are now unconditional and only bind under
  `pnpm test:coverage`.
- A timeout now exits `1` rather than `4`. Exit `4` is reserved for targets that
  cannot be reached at all.
- `exit-codes` and `completion` accept `--no-color` like every other command.

### Changed

- Coverage no longer counts the CLI sources, which v8 cannot observe because the
  tests run the bundle in a child process. The reported number is the measured
  engine coverage: 80% statements, 82% lines, with enforced thresholds.
- `clean` scripts and the coverage script work natively on Windows.
- Toolchain: tsup 9 (clears the `esbuild` advisory — `pnpm audit` is clean) and
  undici 8, which raises the minimum Node.js version to **22.19.0**.
- CI actions moved to their current major versions: `actions/checkout` 7,
  `pnpm/action-setup` 6, `gitleaks/gitleaks-action` 3,
  `softprops/action-gh-release` 3 and `github/codeql-action` 4.

### Security

- Release workflow split into two jobs so the job that runs project build
  scripts never holds a `contents: write` token. Workflow default is read-only;
  `id-token: write` is granted only to the npm publish job, which now publishes
  with `--provenance`.
- The `security-events: write` permission is granted to the CodeQL job only; the
  dependency-audit job had it without using it.
- Repository hardening: `main` requires the five CI jobs and forbids force-pushes
  and deletion, secret scanning and push protection are on, and Dependabot
  security updates are enabled.

### Documentation

- `docs/first-contribution.md` — a walkthrough from a clean clone to an open pull
  request.
- Install instructions use the real package name. `npx apiforge` resolved to an
  unrelated package published in 2013 by a different owner; every `npx` and
  `npm install -g` line, including the one in the GitHub release body, now names
  `@apiforge-tools/apiforge-cli`.

## [0.1.0] — 2026-11-19

The first release: a complete, tested CLI covering functional testing,
performance testing, security review, contract regression and reporting.

### Added

**CLI**

- `apiforge init` — scaffolds `apiforge.yaml`, two environments, two example
  suites and a `.gitignore`; `--force` overwrites, and existing files are never
  clobbered silently.
- `apiforge test` — runs suites with `--env`, `--var`, `--secret`, `--header`,
  `--filter`, `--tag`, `--timeout`, `--bail`, `--reporter`, `--json`.
- `apiforge run` — one ad-hoc request with `-X`, `-H`, `--query`, `-d`,
  `--body-file`, `--form`, `--json-body`, `--expect-status`.
- `apiforge performance` (`perf`) — bounded load test with concurrency,
  duration, request cap, think time, warm-up and latency/error/RPS thresholds.
- `apiforge security` — passive posture review across headers, CORS, cookies,
  TLS, information disclosure, auth configuration and advertised methods, with
  per-finding severity, evidence, explanation and remediation.
- `apiforge contract` — response-shape snapshots with breaking-change detection.
- `apiforge import` — OpenAPI 3.x / Swagger 2.0 → runnable suite, optionally
  with response schema assertions.
- `apiforge report` — re-render a saved JSON report as terminal, HTML, JUnit or
  JSON.
- `apiforge validate` — parse and schema-check suites and environments without
  network traffic.
- `apiforge env` — list, show (secrets masked) and validate environments.
- `apiforge version`, `apiforge exit-codes`, `apiforge completion` (bash, zsh,
  fish).
- Documented exit codes: `0` success, `1` checks failed, `2` usage, `3` config,
  `4` network, `130` interrupted.
- `--json` on every command with pure-JSON stdout (human output moves to
  stderr), and `--no-color` / `NO_COLOR` support throughout.

**Engine**

- HTTP client on Undici: all methods, headers, query, cookies, bearer/basic/
  API-key auth, JSON/text/form/urlencoded/file bodies, redirects, timeouts,
  retries, gzip/brotli decompression, cancellation and typed network errors.
- Assertions: status, status text, headers, body text, JSONPath, JSON Schema
  (Ajv), nested operators, response-time budgets, and deep equality that ignores
  object key order.
- Suite features: variables, secrets, defaults, tags, filters, skips,
  per-test timeouts and retries, captures and multi-step chaining, data-driven
  rows from CSV or JSON with lossless scalar coercion.
- Templating: `{{var}}`, `{{secrets.x}}`, `{{steps.id.path}}`, `{{$env.NAME}}`,
  `{{$random.*}}`, `{{$now.*}}`, with type preservation for single placeholders.
- `${VAR}` interpolation for environment files, including `:-`, `-`, `:?` and
  the `$${…}` escape.
- Performance: bounded concurrency, min/max/mean/p50/p90/p95/p99, standard
  deviation, RPS, throughput, error and timeout counts, status distribution,
  thresholds and graceful cancellation.
- Security: nine check families with a severity model, secret masking of all
  evidence, and a weighted score.
- Contract: structural shape inference and diff, stable baselines, breaking
  change detection.
- OpenAPI import: parameters, request bodies, success-status selection,
  `$ref` resolution, deprecation skipping and warnings for placeholders.
- Reports: terminal (colour-aware, TTY-detecting), JSON, self-contained
  responsive accessible HTML, and JUnit XML; atomic writes and `latest.*`.

**Project**

- Runnable `examples/demo-api` project covering every engine, plus
  `scripts/demo-server.mjs`, `scripts/run-examples.mjs` and
  `scripts/smoke-test.mjs` (53 checks against the built CLI).
- Automated test suite: unit, integration against a local mock server, and CLI
  end-to-end tests that spawn the built binary.
- CI workflow running `pnpm verify`, Dependabot for dependencies and Actions,
  and a security scanning workflow.

### Known limitations

- Plugins are not implemented (see `ROADMAP.md`).
- Pre-request and post-response _scripts_ are not implemented; the declarative
  alternative (templating, captures, chaining) covers the common cases.
- Load generation runs in a single Node process, so very high request rates are
  bounded by that process rather than by the target.
- The security engine does not test authenticated-only endpoints unless you
  supply credentials; it never attempts exploitation.

[Unreleased]: https://github.com/higayes/apiforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/higayes/apiforge/releases/tag/v0.1.0
