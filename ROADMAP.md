# Roadmap

This is a direction, not a promise. Items move in and out as the project learns
from real use. Anything here is open for discussion in an issue.

Legend: ✅ shipped · 🚧 in progress · ⬜ planned · 💭 under consideration

## 0.1 — Foundation ✅

- [x] HTTP engine with auth, bodies, redirects, timeouts and cancellation
- [x] Assertion engine (status, headers, body, JSONPath, JSON Schema, timing)
- [x] Suite format with variables, secrets, defaults, tags, skips
- [x] Request chaining via captures and `{{steps.*}}`
- [x] Data-driven tests from CSV and JSON
- [x] Bounded performance engine with latency percentiles and thresholds
- [x] Passive security review with severity, evidence and remediation
- [x] Contract regression against stored baselines
- [x] OpenAPI / Swagger import
- [x] Terminal, JSON, HTML and JUnit reports
- [x] 14 commands, documented exit codes, `--json` everywhere
- [x] Runnable examples project and end-to-end smoke test
- [x] CI, Dependabot and security scanning workflows

## 0.2 — Depth

- [x] ✅ **Watch mode** — `apiforge test --watch` re-running affected suites on
      file changes.
- [ ] ⬜ **Parallel suite execution** with a `--jobs` flag and deterministic
      per-file isolation.
- [ ] ⬜ **Response diff mode** — `apiforge test --diff` showing what changed in
      a response between two runs.
- [ ] ⬜ **Cookie jar** — per-suite session cookies so login flows don't need
      manual re-arming in every test.
- [ ] ⬜ **Multipart file uploads** with explicit content types per part.
- [ ] ⬜ **Retry policy per status code** rather than per attempt count.
- [ ] ⬜ **`apiforge env new`** scaffolding for new environments.

## 0.3 — Extensibility

- [ ] ⬜ **Plugins** — a documented interface for custom assertion operators,
      reporters and post-run hooks, loaded from `apiforge.config.ts`.
- [ ] ⬜ **JSONata / JMESPath expressions** as an alternative to the built-in
      operator set for complex assertions.
- [ ] ⬜ **Programmatic API** documented and versioned for editor extensions.
- [ ] ⬜ **Postman / Insomnia import** to lower the cost of migrating.

## 0.4 — Reporting and CI

- [ ] ⬜ **HTML dashboard across runs** — history, trend lines and flake
      detection stored in `.apiforge/history/`.
- [ ] ⬜ **GitHub Actions annotations** so failures appear inline on a diff.
- [ ] ⬜ **GitLab Code Quality** report format.
- [ ] ⬜ **SARIF output** for the security engine, so findings appear in code
      scanning.

## 1.0 — Stability

- [ ] ⬜ Freeze the suite format and CLI flags; commit to semantic versioning.
- [ ] ⬜ Publish a migration guide from every 0.x minor.
- [ ] ⬜ Performance work: reuse connections across suites, streaming bodies
      for large responses.
- [ ] ⬜ Load generation across worker threads so the tool is not the bottleneck.

## Explicitly not planned

Being explicit about this saves everyone time:

- **Active exploitation or fuzzing.** The security engine stays passive by
  design. Authorization and destructive-testing features will not be added.
- **Unbounded load testing.** Concurrency and request ceilings are a safety
  feature, not an inconvenience. If you need extreme throughput, run several
  bounded instances deliberately.
- **A GUI-first workflow.** YAML in version control is the product. A web
  dashboard may _report_ on runs, but the source of truth stays a file.
- **Telemetry.** APIFORGE sends nothing anywhere. There is no phone-home.

## How to influence this

Vote on an issue, or open one that describes the workflow you are missing.
Concrete problem statements ("here is my CI setup and why it fails today") move
things up the list faster than feature names.

---

<div align="right"><a href="#roadmap">↑ back to top</a></div>
