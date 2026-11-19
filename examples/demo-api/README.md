# APIFORGE example project

A complete, runnable APIFORGE project that exercises every engine:

| Suite                              | What it demonstrates                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `suites/01-smoke.suite.yaml`       | Status/header/body assertions, response-time budgets          |
| `suites/02-crud.suite.yaml`        | Request chaining (`capture` → `{{steps.…}}`), writes, cleanup |
| `suites/03-data-driven.suite.yaml` | CSV data files, per-row templating, tags                      |
| `suites/04-auth.suite.yaml`        | Bearer tokens, token refresh via a login step, secrets        |
| `suites/05-schema.suite.yaml`      | JSON Schema validation and OpenAPI-derived contracts          |
| `perf.yaml`                        | Bounded load test with latency/RPS thresholds                 |
| `security.yaml`                    | Defensive security posture scan                               |
| `contract.yaml`                    | Contract regression against a stored baseline                 |

Everything runs against the bundled demo API — no internet access and no
credentials required.

## Run it

```bash
# 1. start the demo API (from the repository root)
node scripts/demo-server.mjs            # http://127.0.0.1:4010

# 2. in a second terminal, from this directory
npx apiforge test                       # or: apiforge test
npx apiforge performance --config perf.yaml
npx apiforge security --config security.yaml
npx apiforge contract --config contract.yaml
npx apiforge report reports/latest.json -f html
```

Or use the repository helper, which starts the server, runs everything and
prints a summary:

```bash
npm run examples
```

## Layout

```
examples/demo-api/
├── apiforge.yaml               # project configuration (report formats, defaults)
├── environments/
│   ├── local.yaml              # baseUrl for the demo API
│   └── ci.yaml                 # CI overrides, secrets sourced from env vars
├── data/
│   └── users.csv               # rows for the data-driven suite
├── openapi/
│   └── demo-api.yaml           # trimmed OpenAPI 3.1 description of the demo API
├── suites/*.suite.yaml         # test suites
├── perf.yaml                   # performance specification
├── security.yaml               # security specification
└── contract.yaml               # contract specification
```

Environment variables referenced as `${VAR}` in environment files are read at
run time; keep real secrets in your CI secret store, never in git.
