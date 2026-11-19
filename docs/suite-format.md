# Suite format reference

A suite is a single YAML or JSON document with a `tests` array. This page is the
complete reference; [`README.md`](../README.md) has the guided tour.

- [Top level](#top-level)
- [Requests](#requests)
- [Assertions](#assertions)
- [Captures and chaining](#captures-and-chaining)
- [Data-driven tests](#data-driven-tests)
- [Templating](#templating)
- [Environments](#environments)
- [Specifications](#specifications-performance-security-contract)
- [Errors and diagnostics](#errors-and-diagnostics)

## Top level

```yaml
name: Users API            # required, shown in every report
description: …             # optional
baseUrl: https://api.example.com   # optional; environment baseUrl wins if set
variables: { version: v1 }         # optional
secrets: { token: ${API_TOKEN} }   # optional; masked in reports
defaults:                          # optional, applied to every test
  headers: { accept: application/json }
  query: { locale: en }
  timeoutMs: 5000
  retries: 1                       # 0–10
  followRedirects: true
  maxRedirects: 5                  # 0–50
thresholds:                        # optional, evaluated after the run
  - metric: successRate
    min: 100
  - metric: p95
    max: 2000
tests: [ … ]               # required, at least one
```

Unknown keys are rejected with the exact path (`tests.3.expect.tme`), so a typo
never silently disables an assertion.

A YAML key whose value is only a comment (`secrets:` with nothing under it)
parses as `null` and is treated as an empty map.

## Requests

```yaml
tests:
  - name: Create a user # required
    id: createUser # optional, referenced by capture/chaining
    description: … # optional
    method: POST # default GET
    path: /users # relative to baseUrl
    url: https://other.example.com/users # absolute alternative to path
    headers: { x-trace: abc }
    query: { page: 2, tags: [a, b] }
    cookies: { session: abc }
    auth:
      type: bearer
      token: '{{secrets.token}}'
    body:
      json: { name: Ada }
    timeoutMs: 3000
    retries: 2
    followRedirects: false
    maxRedirects: 3
    tags: [smoke, users]
    skip: because it needs a live database
    capture: { userId: id }
    expect: { … }
```

### Authentication

```yaml
auth: { type: bearer, token: '{{secrets.token}}' }
auth: { type: basic, username: ada, password: '{{secrets.password}}' }
auth: { type: apikey, in: header, name: x-api-key, value: '{{secrets.key}}' }
auth: { type: apikey, in: query, name: api_key, value: '{{secrets.key}}' }
```

### Bodies

```yaml
body: { json: { name: Ada, tags: [a] } } # objects/arrays → serialised JSON
body: { text: 'raw payload' }
body: { form: { file: '@report' } } # multipart/form-data
body: { urlencoded: { user: ada, pass: secret } }
body: { file: ./fixtures/payload.json } # read from disk, relative to the suite
```

## Assertions

```yaml
expect:
  status: 201 # exact
  status: [200, 201] # any of
  status: { min: 200, max: 299 } # range
  statusText: Created

  headers:
    content-type: { contains: application/json }
    x-request-id: { matches: '^[a-f0-9-]+$' }
    x-missing: { exists: false }

  jsonPath:
    id: 42 # shorthand for equals
    name: { equals: Ada, type: string }
    tags: { type: array, length: 2, contains: a }
    score: { gt: 9, lte: 100 }
    items: { every: { type: object } }
    payload: { a: 1, b: [2, 3] } # deep equality, key order ignored

  body:
    contains: 'created'
    notContains: 'error'
    matches: '^\{'
    schema: { type: object, required: [id] } # JSON Schema (draft-07 subset + formats)

  time:
    lessThan: 1500
    moreThan: 50
```

### Value operators

| Operator                    | Meaning                                                 | Applies to     |
| --------------------------- | ------------------------------------------------------- | -------------- |
| `equals`                    | deep equality, key order ignored                        | any            |
| `notEquals`                 | negation of `equals`                                    | any            |
| `exists`                    | presence (false = must be absent)                       | any            |
| `type`                      | `string`,`number`,`boolean`,`null`,`array`,`object`     | any            |
| `matches`                   | regular expression (`g`-free, full match not required)  | strings        |
| `min` / `max`               | inclusive bound; also works on `length` of sized values | numbers, sized |
| `gt` / `gte` / `lt` / `lte` | strict/inclusive comparisons                            | numbers        |
| `length`                    | exact length of a string, array or object               | sized          |
| `minLength` / `maxLength`   | length bounds                                           | sized          |
| `in` / `notIn`              | membership in a list                                    | any            |
| `contains` / `notContains`  | membership inside a string, array or object values      | sized          |
| `every` / `some`            | element-wise nested check                               | arrays         |
| `schema`                    | nested JSON Schema                                      | any            |

A plain object containing no known operator is treated as a literal expected
value, so `payload: { a: 1 }` means "payload deep-equals {a: 1}".

Numeric operands may be `{{placeholders}}`. If a placeholder fails to resolve to
a number, the assertion reports _"unresolved template"_ rather than silently
comparing `NaN`.

## Captures and chaining

```yaml
- name: Create
  id: create
  method: POST
  path: /users
  body: { json: { name: Ada } }
  capture:
    userId: id # JSONPath shorthand
    token: { header: x-token } # from a response header
    status: { status: true }
    raw: { body: true }

- name: Read it back
  path: /users/{{steps.create.userId}}
  headers: { authorization: 'Bearer {{steps.create.token}}' }
```

Captured values keep their type: a captured number compares as a number.

## Data-driven tests

```yaml
- name: Look up a user
  path: /users/{{userId}}
  dataFile: ../data/users.csv
  expect: { status: 200, jsonPath: { id: { equals: '{{userId}}' } } }

- name: Inline rows
  path: /users
  query: { page: '{{page}}' }
  data:
    - { page: 1 }
    - { page: 2 }
```

- `.csv` — the first row is the header; each row becomes a test case.
- `.json` — an array of objects.
- `dataFile` paths are relative to the **suite file's directory**.
- Row values are exposed directly (`{{userId}}`) and as `{{data.userId}}`.
- CSV cells are coerced only when lossless: `42` → number, `007` → text,
  `true`/`false`/`null` → their JSON values, `1e5` → text.
- An unreadable data file fails that test only; the rest of the suite still runs.

## Templating

| Expression                                       | Resolves to                                                     |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `{{name}}`                                       | variables → secrets → captured steps (most specific scope wins) |
| `{{secrets.token}}`                              | secret values (masked in every report)                          |
| `{{steps.<id>.<path>}}`                          | a captured value                                                |
| `{{$env.NAME}}`                                  | process environment                                             |
| `{{$random.uuid}}`                               | random UUID v4                                                  |
| `{{$random.int(1,100)}}`                         | random integer in range                                         |
| `{{$random.string(8)}}`                          | random alphanumeric string                                      |
| `{{$random.hex(16)}}`                            | random hex string                                               |
| `{{$now.iso}}` / `{{$now.unix}}` / `{{$now.ms}}` | current time                                                    |

An unknown variable is an error (strict mode), with a hint listing the places it
could have come from — never a silently empty string. A string that is exactly
one placeholder keeps the resolved value's type.

## Environments

```yaml
# environments/staging.yaml
name: Staging
baseUrl: ${STAGING_URL:-https://staging.example.com}
timeoutMs: 10000
headers: { x-env: staging }
variables: { version: v2 }
secrets: { token: ${STAGING_TOKEN:?set STAGING_TOKEN} }
```

`${...}` is resolved when the file loads, from the process environment:

| Form              | Behaviour                                    |
| ----------------- | -------------------------------------------- |
| `${VAR}`          | required — fails with a named error if unset |
| `${VAR:-default}` | default when unset **or empty**              |
| `${VAR-default}`  | default only when unset                      |
| `${VAR:?message}` | required with a custom error                 |
| `$${VAR}`         | literal `${VAR}`                             |

Precedence: CLI flags > environment file > suite file > project defaults.

## Specifications (performance, security, contract)

Standalone YAML/JSON files used by `--config`:

```yaml
# perf.yaml
baseUrl: ${PERF_URL:-http://127.0.0.1:4010}
target: { method: GET, path: /api/users, headers: { accept: application/json } }
concurrency: 5
durationSeconds: 10
maxRequests: 1000
timeoutMs: 2000
thinkTimeMs: 50
warmupRequests: 10
thresholds:
  - { metric: p95, max: 300 }
  - { metric: errorRate, max: 0 }
```

```yaml
# security.yaml
baseUrl: ${SECURITY_URL:-http://127.0.0.1:4010}
target: { method: GET, path: /api/hardened }
threshold: high
checks:
  tls: false
  headers: true
  cors: { origin: https://app.example.com, withCredentials: true }
  cookies: true
  disclosure: true
  auth: true
  methods: { methods: [TRACE, DELETE] }
```

```yaml
# contract.yaml
baseUrl: ${API_URL:-http://127.0.0.1:4010}
target: { method: GET, path: /api/users }
baseline: .apiforge/contracts/demo-users.json
update: false
```

`baseUrl` is only required when `target.path` is relative.

## Errors and diagnostics

Every configuration error names the file, the field path and what was expected:

```
✖ Error: Invalid suites/api.suite.yaml
  • tests.2.expect.jsonPath.items.length: Expected a number/boolean or a {{template}} placeholder
```

Common causes and the exact message you will see:

| Situation                      | Message                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| Unknown key                    | `tests.0.expect.tme: Unrecognized key`                                |
| Missing `tests`                | `tests: Invalid input: expected array, received undefined`            |
| Unset required env var         | `Environment variable "API_URL" is not set`                           |
| Unknown placeholder            | `Unknown template variable "{{userID}}"`                              |
| Data file missing              | `Could not read data file for test "…": <path>`                       |
| Relative path without base URL | `… uses a relative path ("/api/users") but no base URL is configured` |

`apiforge validate` runs the same parsers without any network traffic, so it is
the fastest way to iterate on a suite.
