# Configuration

APIFORGE reads three kinds of files:

| File                  | Purpose                                                         | Created by      |
| --------------------- | --------------------------------------------------------------- | --------------- |
| `apiforge.yaml`       | project defaults shared by every command                        | `apiforge init` |
| `environments/*.yaml` | per-target values: base URL, variables, secrets                 | `apiforge init` |
| `*.suite.yaml`        | the tests themselves — see [suite-format.md](./suite-format.md) | you             |

Every file is parsed with a **strict schema**: an unknown key is an error, and the
message names the exact path (`reports.format`), so a typo never silently
disables a setting.

## `apiforge.yaml`

All fields are optional; a project with an empty file still works.

```yaml
name: My API # shown in report titles
description: Customer API smoke and load checks

defaultEnvironment: staging # used when --env is omitted
environmentsDir: environments # where environment files live (default: environments)
suites: # files or directories; directories are scanned recursively
  - suites/ # every *.suite.yaml inside, recursively

reports:
  formats: [terminal, html, junit] # terminal | json | html | junit
  outDir: reports # default: reports
  title: My API checks
  open: false # open HTML in a browser after writing

defaults: # applied to every test unless the suite overrides it
  environment: staging
  timeoutMs: 10000
  headers:
    accept: application/json
  retries: 1 # 0–10
  followRedirects: true

performance: # defaults for `apiforge performance`
  concurrency: 5 # 1–100
  durationSeconds: 10 # max 3600
  maxRequests: 1000 # max 100000
  timeoutMs: 10000
  thinkTimeMs: 0
  warmupRequests: 0 # 0–1000
  thresholds:
    - metric: p95
      max: 500

security: # defaults for `apiforge security`
  threshold: high # critical | high | medium | low
  checks:
    headers: true
    cors: true

thresholds: # evaluated after `apiforge test`
  - metric: successRate
    min: 100
```

### Precedence

A value is resolved from the most specific source first:

1. command-line flag (`--timeout`, `--var`, `--header`, `-e`)
2. the suite file
3. the environment file
4. `defaults` in `apiforge.yaml`

Environment `baseUrl` wins over a suite `baseUrl`, so the same suites run against
any target.

## `environments/*.yaml`

```yaml
name: staging
description: Pre-production cluster
baseUrl: https://staging.example.com

variables: # not secret, shown in reports
  region: eu-west
  apiVersion: v2
  servicePath: /services

secrets: # masked in every report and in terminal output
  token: ${STAGING_TOKEN} # ${VAR} is read from the process environment
  apiKey: ${STAGING_API_KEY}

timeoutMs: 15000
headers:
  accept: application/json
```

`${VAR}` interpolation happens when the file is loaded; a missing variable is an
error rather than an empty string, so a misconfigured environment fails loudly.

Reference values with `{{...}}` placeholders inside a suite:

```yaml
path: '{{servicePath}}/users'
headers:
  authorization: 'Bearer {{secrets.token}}'
```

## Inspecting configuration

```bash
apiforge env                    # list environments
apiforge env show staging       # resolved values, secrets masked
apiforge env validate environments/staging.yaml   # parse one environment file
apiforge validate               # parse and schema-check every suite
```

`apiforge env show` never prints a secret in clear text — it shows a masked
form (`sup…ret`) — so it is safe to paste into a ticket.

## Command-specific specification files

`performance`, `security` and `contract` also accept a standalone spec via
`--config`. These are stricter than project defaults — they describe a single run.

```yaml
# perf.yaml — apiforge performance --config perf.yaml
target:
  url: https://api.example.com/health # or path: /health with baseUrl below
  method: GET
  headers: { accept: application/json }
baseUrl: https://api.example.com # used when target.path is relative
concurrency: 10 # 1–100
durationSeconds: 15
maxRequests: 5000
warmupRequests: 10
thinkTimeMs: 0
thresholds:
  - metric: p95
    max: 250
```

```yaml
# security.yaml — apiforge security --config security.yaml
target:
  url: https://api.example.com
threshold: medium
checks:
  headers: true
  cors: true # or { origin: https://app.example.com, withCredentials: true }
  cookies: true
  disclosure: true
  auth: true
  methods: true # or { methods: [put, delete] }
  tls: true
```

```yaml
# contract.yaml — apiforge contract --config contract.yaml
target:
  url: https://api.example.com/users
```

## Validation errors

Schemas are strict on purpose. A malformed file reports the file name and the
failing path, for example:

```
✖ Error: Invalid perf.yaml
  • target: Invalid input: expected object, received undefined
  • (root): Unrecognized keys: "url", "requests"
```

That message means `url` belongs under `target`, and the field is `maxRequests`,
not `requests`. Exit code `3` is used for every configuration error.
