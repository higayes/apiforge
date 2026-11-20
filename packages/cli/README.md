<div align="center">

# APIFORGE

**Test smarter. Ship with confidence.**

An open-source API testing, validation, performance and security platform — one
CLI for the checks that usually need four tools.

[Quick start](#quick-start) · [Commands](#command-reference) · [Suite format](#suite-format) · [CI](#continuous-integration) · [Contributing](https://github.com/higayes/apiforge/blob/main/CONTRIBUTING.md)

</div>

---

> **Status: pre-1.0.** Everything documented here is implemented and covered by
> automated tests (see [Project status](#project-status)). The CLI surface may
> still change before 1.0; breaking changes will be listed in the
> [CHANGELOG](https://github.com/higayes/apiforge/blob/main/CHANGELOG.md).

## Why APIFORGE

Most teams test APIs with a pile of shell scripts, a GUI tool nobody can review
in a pull request, and a load-testing tool that is a separate universe. APIFORGE
puts the whole loop in one declarative file format that lives in your repository
and runs identically on a laptop, in Docker, and in CI:

```bash
apiforge test           # functional + schema + contract assertions
apiforge performance    # bounded load test with latency thresholds
apiforge security       # passive posture review with evidence
apiforge report         # terminal / JSON / HTML / JUnit
```

- **Reviewable**: suites are YAML or JSON, so changes show up in diffs.
- **Fast**: the whole engine is one Node process; a 100-request load test takes
  milliseconds to start.
- **Safe**: load tests are bounded by construction, and the security engine only
  reads what the API already sends back.
- **Portable**: a single self-contained CLI bundle; no server, no database, no
  account.

## Quick start

Requires **Node.js 22.19+**.

```bash
# run without installing
npx @higayes/apiforge-cli@latest init

# or install globally
npm install -g @higayes/apiforge-cli
apiforge init

# or run from a checkout of this repository
pnpm install && pnpm build && pnpm examples
```

`apiforge init` creates a project you can run immediately:

```
apiforge.yaml            project configuration
environments/local.yaml  base URL, variables, secrets
environments/staging.yaml
suites/health.suite.yaml
suites/crud.suite.yaml
```

Then:

```bash
apiforge test                           # every suite in the project
apiforge test suites/health.suite.yaml  # one suite
apiforge run https://api.example.com/health
```

## What it does

| Capability          | Command                | Notes                                                                                                   |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Functional tests    | `apiforge test`        | status, headers, body, JSONPath, JSON Schema, response-time budgets, data-driven rows, request chaining |
| Ad-hoc requests     | `apiforge run`         | one request, print the response, optional `--expect-status`                                             |
| Performance         | `apiforge performance` | concurrency, duration or request cap, p50/p90/p95/p99, RPS, error/timeout stats, thresholds             |
| Security review     | `apiforge security`    | headers, CORS, cookies, TLS, info disclosure, sensitive data, auth config, unsafe methods               |
| Contract regression | `apiforge contract`    | snapshot a response shape; fail when a field or type disappears                                         |
| OpenAPI import      | `apiforge import`      | turn an OpenAPI 3.x / Swagger 2.0 document into a runnable suite                                        |
| Reports             | `apiforge report`      | re-render a saved JSON report as terminal, HTML or JUnit                                                |
| Validation          | `apiforge validate`    | parse + schema-check every suite and environment, no network                                            |
| Environments        | `apiforge env`         | list, show (secrets masked) and validate environments                                                   |

Every command supports `--json` for machine-readable output and `--no-color`
for logs.

## Command reference

### `apiforge test [paths...]`

```bash
apiforge test                                   # discover suites from the project
apiforge test suites/api.suite.yaml             # one file
apiforge test suites/ --env staging             # a directory against an environment
apiforge test --filter users --tag smoke        # narrow by name/id or tag
apiforge test --bail                            # stop at the first failure
apiforge test --reporter json,html,junit        # write reports/
apiforge test --json | jq '.totals'             # machine-readable, stdout is pure JSON
```

| Flag                    | Meaning                                           |
| ----------------------- | ------------------------------------------------- |
| `-e, --env <name>`      | environment from `environments/<name>.yaml`       |
| `--var <key=value>`     | override a suite variable (repeatable)            |
| `--secret <NAME=value>` | provide a secret (repeatable, masked in reports)  |
| `--header <name=value>` | add a header to every request                     |
| `--filter <text>`       | only run tests whose name or id contains the text |
| `--tag <tag>`           | only run tests with this tag                      |
| `--timeout <ms>`        | override the timeout for every request            |
| `--reporter <list>`     | `terminal,json,html,junit`                        |
| `-o, --out <dir>`       | report directory (default `reports/`)             |
| `--bail`                | stop after the first failing test                 |
| `--insecure`            | skip TLS verification (development only)          |

### `apiforge run [options] <url>`

```bash
apiforge run https://api.example.com/health
apiforge run https://api.example.com/users -X POST -d '{"name":"Ada"}' --expect-status 201
apiforge run https://api.example.com/login --form user=ada --form pass=secret
apiforge run https://api.example.com/secure -H 'Authorization: Bearer …'
```

### `apiforge performance`

```bash
apiforge performance https://api.example.com/health -n 200 -c 10
apiforge performance --config perf.yaml
apiforge performance https://api.example.com -d 10 -c 5 --expect-p95 250
```

Safe defaults: concurrency 5, a request cap is always enforced, and inputs are
range-checked (`-c` max 100, `-n` max 100 000). APIFORGE refuses to run if
neither a duration nor a request count is supplied.

| Flag                    | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| `-c, --concurrency <n>` | virtual users, 1–100 (default 5)               |
| `-d, --duration <s>`    | run for N seconds                              |
| `-n, --requests <n>`    | stop after N requests                          |
| `--think-time <ms>`     | pause per virtual user between requests        |
| `--warmup <n>`          | discard N warm-up requests from the statistics |
| `--expect-p95 <ms>`     | fail if p95 latency exceeds this               |
| `--expect-min-rps <n>`  | fail if throughput drops below this            |
| `--config <file>`       | load a performance specification               |

Statistics reported: min, mean, P50, P90, P95, P99, max, standard deviation,
requests/second, throughput, error rate, timeout count and the status-code
distribution.

### `apiforge security`

```bash
apiforge security --url https://api.example.com
apiforge security --config security.yaml --threshold medium
apiforge security --url https://api.example.com --check headers,cors,tls
```

Checks: `headers`, `cors`, `cookies`, `disclosure`, `auth`, `methods`, `tls`.

Each finding carries a **severity**, the **evidence** that produced it (secrets
masked), an **explanation** of the risk, and a **remediation** step. The command
exits `1` when a finding at or above `--threshold` (default `high`) is present.

> **Authorized testing only.** This is a passive review of responses the server
> already returns. It does not attempt exploitation, injection, fuzzing or
> destructive requests. Only scan systems you are permitted to test.

### `apiforge contract`

```bash
apiforge contract https://api.example.com/users              # create or compare
apiforge contract https://api.example.com/users --update     # accept the new shape
apiforge contract --config contract.yaml                     # from a spec
```

Baselines live in `.apiforge/contracts/<name>.json` and should be committed.
A field that disappears or changes type is reported as a breaking change and the
command exits `1`.

### `apiforge import <openapi>`

```bash
apiforge import openapi.yaml                        # writes openapi.suite.yaml
apiforge import openapi.yaml --schemas -o suites/   # with response schema assertions
apiforge import openapi.yaml --tag pets --path '^/pets'
```

### `apiforge report <file>`

```bash
apiforge report reports/latest.json -f html
apiforge report reports/latest.json -f junit -o build/test-results
```

### `apiforge validate [paths...]`

Parses and schema-checks everything without any network traffic — ideal as a
pre-commit hook or editor task. Files that are not suites (data files, OpenAPI
documents, specifications) are skipped rather than reported as errors.

### `apiforge env [list|show|validate]`

```bash
apiforge env                      # list environments
apiforge env show staging         # details, secrets masked
apiforge env validate             # verify every environment file parses
```

## Suite format

A suite is one YAML or JSON object. The complete reference is in
[`docs/suite-format.md`](https://github.com/higayes/apiforge/blob/main/docs/suite-format.md); project and environment files
are covered in [`docs/configuration.md`](https://github.com/higayes/apiforge/blob/main/docs/configuration.md). This is the tour.

```yaml
name: Users API
description: CRUD coverage for /users
baseUrl: https://api.example.com

variables:
  version: v1
secrets:
  token: ${API_TOKEN} # resolved from the process environment

defaults:
  timeoutMs: 5000
  retries: 1

tests:
  - name: Create a user
    id: createUser
    method: POST
    path: /{{version}}/users
    auth:
      type: bearer
      token: '{{secrets.token}}'
    body:
      json:
        name: Ada
        email: ada@example.com
    expect:
      status: 201
      headers:
        content-type: { contains: application/json }
      jsonPath:
        id: { type: number }
        name: { equals: Ada }
      time:
        lessThan: 1500
    capture:
      userId: id # available as {{steps.createUser.userId}}
```

### Assertions

| Target        | Example                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| Status        | `status: 200` · `status: [200, 201]` · `status: { min: 200, max: 299 }` |
| Headers       | `headers: { content-type: { contains: json } }`                         |
| JSON values   | `jsonPath: { user.id: { type: number, gte: 1 } }`                       |
| JSON Schema   | `body: { schema: { type: object, required: [id] } }`                    |
| Text          | `body: { contains: 'created' }`                                         |
| Response time | `time: { lessThan: 1000 }`                                              |

Value operators: `equals`, `notEquals`, `exists`, `type`, `matches`, `min`,
`max`, `gt`, `gte`, `lt`, `lte`, `length`, `minLength`, `maxLength`, `in`,
`notIn`, `contains`, `notContains`, `every`, `some`, `schema`. A bare scalar is
shorthand for `equals`, and a plain object with no known operator is a deep
equality check that ignores key order.

Numeric operands accept `{{placeholders}}`, which is what makes data-driven rows
work: `length: '{{expected}}'` compares as a number when the row provides one.

### Templating

| Expression                    | Resolves to                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `{{variable}}`                | a suite/environment variable                                                |
| `{{secrets.token}}`           | a secret (masked in every report)                                           |
| `{{steps.createUser.userId}}` | a value captured by an earlier test                                         |
| `{{$env.NAME}}`               | a process environment variable                                              |
| `{{$random.uuid}}`            | `$random.uuid`, `$random.int(1,10)`, `$random.string(8)`, `$random.hex(16)` |
| `{{$now.iso}}`                | `$now.iso`, `$now.unix`, `$now.ms`                                          |

A string containing exactly one placeholder keeps the resolved type, so a
captured number stays a number.

### Data-driven tests

```yaml
- name: Look up a user
  path: /users/{{userId}}
  dataFile: ../data/users.csv # or a JSON array of objects
  expect:
    status: 200
    jsonPath:
      id: { equals: '{{userId}}' }
```

Each row becomes its own test case in the report, labelled `[data row N]`.
CSV cells are coerced only when lossless: `42` becomes a number, `007` stays
text, `true`/`false`/`null` become their JSON values.

### Environments

```yaml
# environments/staging.yaml
baseUrl: ${STAGING_URL:-https://staging.example.com}
timeoutMs: 10000
variables:
  version: v2
secrets:
  token: ${STAGING_TOKEN:?a token is required}
```

`${VAR}` is interpolated when the file loads. Forms: `${VAR}` (required),
`${VAR:-default}`, `${VAR-default}`, `${VAR:?message}`. A required variable that
is unset fails with an actionable error naming the file and the variable — never
a silently empty string.

## Continuous integration

Exit codes are part of the CLI contract:

| Code  | Meaning                                                               |
| ----- | --------------------------------------------------------------------- |
| `0`   | all checks passed                                                     |
| `1`   | tests, thresholds, performance, security or contract checks failed    |
| `2`   | invalid command-line usage                                            |
| `3`   | configuration, suite, environment or input-file error                 |
| `4`   | network failure — the target could not be reached (DNS, refused, TLS) |
| `130` | interrupted (Ctrl+C)                                                  |

A **timeout** exits `1`, not `4`: the server answered, just too slowly. Exit `4`
means nothing could be reached at all, which is usually retryable in CI.

```yaml
# .github/workflows/api.yml
name: API checks
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g @higayes/apiforge-cli
      - run: apiforge validate
      - run: apiforge test --reporter json,html,junit --env ci
        env:
          API_TOKEN: ${{ secrets.API_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: apiforge-reports
          path: reports/
```

JUnit output is written to `reports/*.xml` and is picked up by most CI test
reporters without configuration.

## Reports

| Format     | Use                                                                    |
| ---------- | ---------------------------------------------------------------------- |
| `terminal` | human summary with failures grouped by suite                           |
| `json`     | machine-readable, identical to `--json` on stdout                      |
| `html`     | single self-contained file: responsive, accessible, no external assets |
| `junit`    | `reports/*.xml` for CI test reporters                                  |

`reports/latest.<ext>` always points at the most recent run and can be
re-rendered with `apiforge report`.

## Project status

Honest accounting of what is built and verified:

| Area                      | State               | Verification                                                               |
| ------------------------- | ------------------- | -------------------------------------------------------------------------- |
| HTTP engine               | complete            | integration tests against a local server                                   |
| Assertions                | complete            | unit + integration tests                                                   |
| Performance engine        | complete            | real measurements against a local server                                   |
| Security engine           | complete            | 33 dedicated tests incl. secret-masking                                    |
| Contract engine           | complete            | snapshot/compare tests incl. breaking changes                              |
| OpenAPI import            | complete            | importer tests + generated suite runs                                      |
| Reports (4 formats)       | complete            | reporter tests + smoke test                                                |
| CLI (14 commands)         | complete            | 46 end-to-end tests spawning the built binary                              |
| Examples                  | complete            | `pnpm examples` runs all of them                                           |
| Plugins                   | **not implemented** | see [ROADMAP.md](https://github.com/higayes/apiforge/blob/main/ROADMAP.md) |
| Pre/post-response scripts | **not implemented** | see [ROADMAP.md](https://github.com/higayes/apiforge/blob/main/ROADMAP.md) |

Test counts and coverage are printed by `pnpm test` and `pnpm test:coverage`.

## Development

```bash
pnpm install
pnpm build          # engine (tsc) + CLI (tsup) → packages/cli/dist/cli.js
pnpm smoke          # 53 checks against the built CLI
pnpm test           # 321 tests
pnpm test:coverage  # engine coverage gate: 80% stmts / 82% lines
pnpm verify         # format, lint, typecheck, build, test, end-to-end smoke
pnpm examples       # run every feature against the bundled demo API
```

See [CONTRIBUTING.md](https://github.com/higayes/apiforge/blob/main/CONTRIBUTING.md) for the architecture overview and the
review checklist.

## Security

Please read [SECURITY.md](https://github.com/higayes/apiforge/blob/main/SECURITY.md) before reporting a vulnerability.
APIFORGE is a testing tool: **never point it at systems you do not own or have
written permission to test**, and never commit secrets — use environment
variables or your CI secret store.

## License

[MIT](LICENSE) © APIFORGE Maintainers

<div align="right"><a href="#apiforge">↑ back to top</a></div>
