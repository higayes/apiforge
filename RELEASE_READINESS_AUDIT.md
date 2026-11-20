# Release Readiness Audit — APIFORGE v0.1.0

**Date:** 2026-11-19
**Auditor:** independent audit pass (no features added, no modules redesigned)
**Commit audited:** `aa80aee` ("fix: release-audit corrections")
**Verdict:** ⚠️ **NOT READY TO PUBLISH** — the software is sound, but two
external identities are unresolved and will block or misdirect a release.

> Nothing was published, tagged, or pushed. No repository visibility was changed.
> No destructive Git operations were performed. This document contains no
> secrets.

---

## 1. Executive summary

The product itself is in good shape. I executed **every invocation advertised in
README.md (35 of them) against the installed npm tarball**, not the source tree,
and all 35 pass. Six public exit codes were verified by provoking each one. The
build, the test suite, the smoke test, the examples and the packaging test all
pass from a **clean clone**.

The blockers are not code quality — they are **release identity**:

| #   | Blocker                                                                                                              | Impact                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | The npm name `apiforge` is **already owned by another maintainer**                                                   | `npm publish` returns 403. Release cannot happen under this name.                                                                                    |
| B2  | `github.com/higayes/apiforge` **does not exist** (404); the `apiforge` GitHub account is an unrelated user from 2016 | Every documented URL is dead: repository link, issue tracker, security policy URL, CHANGELOG compare links, and the link printed by `apiforge init`. |

Both are decisions only the owner can make. Details and options in §9.

Alongside those I found and **fixed** eight real defects during the audit (§10),
including a `-H` syntax that contradicted the README, a documentation file that
every scaffolded project pointed at but did not exist, a crash when re-rendering
a legal report, and a duplicated `undici` major.

---

## 2. Method

So the audit could not be fooled by a green local test suite (which had already
hidden one shipping bug in the previous phase), I worked against the artefact
users actually receive:

1. `npm pack` the CLI, install the tarball into an empty project.
2. Drive every documented command through `node_modules/.bin/apiforge`.
3. Verify side effects on disk (reports, baselines, generated suites).
4. Re-run the whole pipeline from a fresh `git clone` to reproduce CI.

The rehearsal script lives at `audit/verify-docs.mjs` (scratch, not part of the
repository) and reports PASS/FAIL per invocation.

---

## 3. Advertised commands vs. actual execution

All 14 commands were invoked. `--help` works on every one.

| Command              | Aliases | Verified behaviour                                                                                         |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `init [dir]`         | —       | Scaffolds config, 2 environments, 2 suites, `.gitignore`; refuses to clobber                               |
| `test [paths…]`      | —       | Discovery, single file, directory, `--env`, `--filter`, `--tag`, `--bail`, `--reporter`, `--json`, `--var` |
| `run <url>`          | —       | `-X`, `-H`, `--query`, `-d`, `--body-file`, `--form`, `--json-body`, `--expect-status`                     |
| `performance [url]`  | `perf`  | `-n`, `-d`, `-c`, `--config`, `--expect-p95`, percentiles, RPS, error stats                                |
| `security`           | —       | `--url`, `--config`, `--check`, `--threshold`, severity + evidence + remediation                           |
| `contract [url]`     | —       | Create/complain about baselines, `--update`, `--config`, exits 1 on a breaking change                      |
| `report <file>`      | —       | `-f terminal,json,html,junit`, `-o`                                                                        |
| `import <spec>`      | —       | OpenAPI **3.x** and **Swagger 2.0**, `--schemas`, `--tag`, `--path`, `-o`                                  |
| `validate [paths…]`  | —       | Parses and schema-checks suites and environments, no network                                               |
| `env`                | —       | `list` (default), `show <name>` (secrets masked), `validate <file>`                                        |
| `version`            | —       | Version + Node/platform; `--json`                                                                          |
| `exit-codes`         | —       | Documents the contract; `--json`; now accepts `--no-color`                                                 |
| `completion [shell]` | —       | bash, zsh, fish                                                                                            |
| `help`               | —       | Via `--help` on every command                                                                              |

**Result: 35/35 documented invocations pass; 3/3 documented side effects appear.**

> Note: `apiforge help` is advertised as a command in the project brief. There is
> no dedicated `help` subcommand — help is `--help` / `-h`. This is normal for
> Commander CLIs but is worth knowing if any marketing copy lists "14 commands"
> by counting `help`.

---

## 4. Documented examples

Every code block in README.md that starts with `apiforge` was executed verbatim
(with example.com replaced by the bundled demo API). All succeed, including:

- `test` discovery, single-file, directory + environment, `--filter`, `--bail`,
  `--reporter json,html,junit`, and `--json | jq '.totals'` (stdout stayed pure
  JSON).
- `run` with `-X POST -d`, `--form`, and `-H 'Authorization: Bearer …'`.
- `performance` with `-n/-c`, `--config`, and `-d … --expect-p95`.
- `security` with `--url`, `--config … --threshold`, `--check headers,cors,tls`.
- `contract` create / `--update` / `--config`.
- `import` plain, `--schemas -o`, `--tag … --path …`.
- `report -f html`, `report -f junit -o`.
- `env`, `env show staging`, `env validate <file>`.

`docs/configuration.md` (written during this audit) was validated the same way:
its project config, environment file, `${SECRET}` interpolation, `{{placeholder}}`
substitution and all three `--config` specification examples were run, not just
read. One claim in my first draft (`suites: ['suites/**']`) was wrong — globs are
not supported, only files and directories — and was corrected after testing.

---

## 5. README feature claims — verified one by one

| Claim                                                                            | Verdict | Evidence                                                           |
| -------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| status, headers, body, JSONPath, JSON Schema assertions                          | ✅      | All exercised; `schema` and `time` blocks proven                   |
| response-time budgets                                                            | ✅      | `expect.time.lessThan` proven                                      |
| data-driven rows                                                                 | ✅      | 2 inline rows + 3 CSV rows expanded to 5 tests                     |
| request chaining                                                                 | ✅      | `capture: { userId: id }` then `{{steps.create.userId}}`           |
| performance percentiles, RPS, error/timeout stats, thresholds                    | ✅      | p50/p90/p95/p99 and threshold failure proven                       |
| security: headers, CORS, cookies, TLS, disclosure, sensitive data, auth, methods | ✅      | Each check present; findings carry severity, evidence, remediation |
| contract: snapshot shape, fail when a field/type disappears                      | ✅      | Removed field → `✖ Contract check failed`, exit 1                  |
| OpenAPI 3.x **and Swagger 2.0** import                                           | ✅      | Both formats generated a runnable suite                            |
| report re-render as terminal, HTML, JUnit                                        | ✅      | All four formats; HTML self-contained, JUnit well-formed           |
| `validate` — parse + schema-check, **no network**                                | ✅      | Runs with the target down                                          |
| `env` — list, show (secrets masked), validate                                    | ✅      | `show` renders `sup…ret`, never the value                          |
| "Unknown keys are rejected with the exact path"                                  | ✅      | `tests.1.expect.status: Too big: expected number to be <=599`      |
| HTML report is self-contained                                                    | ✅      | Only inline `<style>`; no external CSS/JS/fonts                    |

**No misleading feature claims remain in the README after the fixes in §10.**

---

## 6. Actual test and build results

Run on the audited commit from a **clean clone** (`pnpm install --frozen-lockfile`
first), Node 22.19.0, pnpm 9.15.4, Linux x64:

| Gate            | Command                                         | Result                                                 |
| --------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Install         | `pnpm install --frozen-lockfile`                | **exit 0**                                             |
| Format          | `pnpm format:check`                             | exit 0                                                 |
| Lint            | `pnpm lint`                                     | exit 0                                                 |
| Typecheck       | `pnpm typecheck`                                | exit 0                                                 |
| Build           | `pnpm build`                                    | exit 0 — `dist/cli.js` 306.3 kB                        |
| Tests           | `pnpm test`                                     | **321 passed**, 1 skipped, 16 files                    |
| Coverage        | `pnpm test:coverage`                            | **80.13 % stmts / 82.03 % lines**, thresholds enforced |
| Smoke           | `node scripts/smoke-test.mjs`                   | **53/53 checks**                                       |
| Examples        | `pnpm examples`                                 | **8/8**                                                |
| Packaging       | `APIFORGE_TEST_PACK=1 vitest packaging.test.ts` | **7/7** incl. real tarball install                     |
| Audit           | `pnpm audit`                                    | **no known vulnerabilities**                           |
| Publish dry-run | `pnpm --filter apiforge publish --dry-run`      | 5 files, ~224 kB, tag/version match                    |
| Full gate       | `pnpm verify`                                   | **exit 0**                                             |

Exit-code contract, provoked deliberately:

| Scenario                | Exit | Expected |
| ----------------------- | ---- | -------- |
| All checks pass         | 0    | 0        |
| Assertion fails         | 1    | 1        |
| Unknown command         | 2    | 2        |
| Missing suite file      | 3    | 3        |
| Unreachable host        | 4    | 4        |
| Slow endpoint (timeout) | 1    | 1        |

---

## 7. Package metadata and contents

`npm pack` produces **5 files** (223 kB packed / 935 kB unpacked):

```
LICENSE            1.1 kB   MIT
README.md         18.3 kB
dist/cli.js      312.5 kB   shebang + ESM bundle
dist/cli.js.map  601.7 kB   source map
package.json       1.2 kB
```

Verified: `name`, `version`, `description`, `license`, `engines.node >=22.19.0`,
`bin.apiforge`, `files` allowlist, `keywords`, `repository`, `homepage`, `bugs`.
No `src/`, `tests/`, reports, coverage, or `.env` files are included. The bundle
also shrank correctly: the CLI's dependency list is now exactly the six packages
the bundle imports at runtime.

**Observation (not a blocker):** the source map is 590 kB — 193 % of the bundle,
because `sourcesContent` embeds all 55 sources — so the download is ~897 kB of
which two-thirds is the map. Most CLIs ship it; dropping it (or setting
`sourcesContent: false`) would roughly halve the install size. Owner's call.

---

## 8. Platform compatibility

The environment is Linux; Windows and macOS were not executed, so this is a code
review, not a runtime guarantee, plus what CI is configured to prove.

| Concern            | Status                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Path handling      | ✅ All file paths via `node:path` (`join`/`resolve`/`relative`)                                  |
| Shell-outs         | ✅ None in shipped code; smoke/examples spawn `node` directly, no shell                          |
| `clean` scripts    | ✅ Node one-liner, not `rm -rf`                                                                  |
| Coverage script    | ✅ No POSIX inline env assignment (fixed in a prior phase)                                       |
| Entry guard        | ✅ Compares realpaths, so `.cmd`/`.ps1`/symlink shims all work                                   |
| Windows path regex | ✅ `/\benvironments?[\\/]/i` already handles `\`                                                 |
| CI matrix          | ✅ Ubuntu (22.19.0 + 22), Windows, macOS — **but never observed to run**, since no remote exists |

**Real caveat:** the Windows and macOS legs have never actually executed,
because there is no GitHub remote. Until they run once, cross-platform support is
"reviewed and designed for", not "demonstrated".

---

## 9. Release blockers (require an owner decision)

### B1 — the npm package name is taken

```
$ npm view apiforge
apiforge@0.0.0 | BSD-2-Clause | versions: 1
maintainers: cab <conner@pixuli.com>
published over a year ago
```

`npm publish` will fail with `403 Forbidden`. Options:

| Option | Name                                 | Ready?                                                        |
| ------ | ------------------------------------ | ------------------------------------------------------------- |
| A      | `@apiforge/cli` (scoped)             | **available** — needs `"publishConfig": {"access": "public"}` |
| B      | A different unscoped name            | `apiforge-cli` is also taken (1.0.7); would need a new name   |
| C      | Acquire the existing `apiforge` name | Requires contacting the current owner                         |

The bin name can stay `apiforge` regardless of the package name.

### B2 — the GitHub repository URL does not exist

```
404  https://github.com/higayes/apiforge
200  https://github.com/apiforge        (a personal account created 2016, not an org)
```

Nine tracked files reference `github.com/higayes/apiforge`, including
`package.json` (`repository`, `homepage`, `bugs`), `SECURITY.md`, `CHANGELOG.md`
compare links, issue-template links, and the "Documentation:" line printed by
`apiforge --help`. Shipping as-is would send users, security reporters and
`npm`'s "Repository" link to a 404 or to a stranger's profile.

This is a documentation/metadata change once the real home is known — I did not
guess a URL.

---

## 10. Defects found and fixed during this audit

All fixed, tested, and committed as `aa80aee`. `pnpm verify` is green.

| #   | Defect                                                                                                                                             | Severity                                                       | Fix                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `-H 'Name: value'` (documented in README, the curl convention) was rejected — only `NAME=value` worked                                             | **High** — copied README commands failed                       | Both forms accepted; colons preserved inside values; 2 regression tests |
| 2   | `packages/cli/README.md` (the npm landing page) used relative links to `CONTRIBUTING.md`, `CHANGELOG.md`, `ROADMAP.md`, `docs/*`, all 404 on npmjs | Medium                                                         | Rewritten to absolute URLs; link check now reports 0 broken             |
| 3   | Every scaffolded project pointed at `docs/configuration.md`, which did not exist                                                                   | Medium                                                         | Written; every example executed to confirm it is accurate               |
| 4   | `report -f terminal` crashed with a raw `TypeError` on a report lacking `thresholds` (an optional field)                                           | Medium                                                         | Guarded in the renderer; regression test                                |
| 5   | `report` accepted a structurally incomplete report and failed deep inside a renderer                                                               | Low                                                            | Rejected up front with an actionable message                            |
| 6   | SECURITY.md referenced a non-existent `apiforge load` command and claimed load tests "refuse to run without a cap" (they default to 10 s)          | Medium — a security document that is wrong is worse than terse | Corrected to the real behaviour                                         |
| 7   | CLI declared `undici ^7` while the engine used `^8` → two majors installed for one externally-imported dependency                                  | Medium                                                         | Aligned on `^8.12.4`; single copy verified                              |
| 8   | Test counts stale in README/CONTRIBUTING                                                                                                           | Low                                                            | Refreshed to 321                                                        |

---

## 11. Repository hygiene

| Check                                                         | Result                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Credentials / API keys / private keys                         | **None.** Only obvious fixtures (`s3cret-token`, AWS's `AKIAIOSFODNN7EXAMPLE`)               |
| `.env` files committed                                        | None; `.env*` is gitignored except `.env.example`                                            |
| `console.log` / `debugger` / `TODO` / `FIXME` in shipped code | **0** of each                                                                                |
| Logs, `.tgz`, `.bak`, `.DS_Store`, `.idea`, `.vscode` tracked | None                                                                                         |
| `reports/`, `coverage/`, `dist/`, `.apiforge/` tracked        | None — all gitignored                                                                        |
| Secrets in generated reports                                  | **Not present** in terminal output, JSON, HTML or JUnit (verified with a distinctive secret) |
| Working tree                                                  | Clean                                                                                        |

---

## 12. Dependencies and licensing

Runtime dependencies shipped to users — all permissive, all declared:

| Package     | Range     | License |
| ----------- | --------- | ------- |
| ajv         | `^8.20.0` | MIT     |
| ajv-formats | `^3.0.1`  | MIT     |
| commander   | `^15.1.0` | MIT     |
| undici      | `^8.12.4` | MIT     |
| yaml        | `^2.9.1`  | ISC     |
| zod         | `^4.6.7`  | MIT     |

- Project license **MIT**, consistent across `LICENSE`, `package.json` and the
  tarball. No copyleft in the runtime tree.
- `pnpm audit`: **no known vulnerabilities** (the `esbuild` advisory was cleared
  by moving to tsup 9).
- Dependabot covers npm (weekly, grouped) and Actions (monthly), with major
  bumps ignored for TypeScript/ESLint/Vitest/Zod.
- `engines.node >= 22.19.0` matches undici 8's real requirement.

---

## 13. CI enforcement

Workflows present and valid YAML: `ci.yml` (verify + package), `security.yml`
(audit, CodeQL, gitleaks), `release.yml` (tag/version equality → `pnpm verify` →
publish → GH release).

`ci.yml` builds **before** testing (the CLI tests execute the built bundle), runs
the matrix on Ubuntu/Windows/macOS, uploads coverage, and runs the packaging test
with `APIFORGE_TEST_PACK=1`. `release.yml` gates publishing on `pnpm verify` and
refuses to publish when the tag ≠ `package.json` version.

**Gap:** there is no `.github/CODEOWNERS`, and **branch protection with required
status checks cannot be configured in the repository** — it is a GitHub setting.
Nothing currently _forces_ a green CI run before a release except `release.yml`'s
own `pnpm verify` step. Recommend enabling protected `main` with required checks
`Verify (Node 22 on ubuntu-latest)` and `Package check` once the remote exists.

---

## 14. Known limitations (accurate, documented)

1. **No plugin system** — extending behaviour needs a code change.
2. **No `pre`/`post` hooks or lifecycle scripts** in suite files.
3. **Single-process load generation** — deliberately bounded (concurrency ≤ 100,
   requests ≤ 100 000, 10 s default). Not a high-throughput load tool.
4. **Passive security review only** — no exploitation, fuzzing or injection.
5. **Coverage measures the engine only.** CLI behaviour is covered by 54
   end-to-end tests that spawn the binary, which v8 cannot instrument.
6. **No remote exists**, so no CI run, no Windows/macOS execution and no
   real-world `npm install` have ever been observed.
7. **Source map doubles the package size** (~590 kB of the ~897 kB download).

---

## 15. Recommended release checklist

Complete in order. Items marked ⛔ block the release.

**Identity (must be decided first)**

- [ ] ⛔ **B1** Choose the published name. For `@apiforge/cli`: set `name`,
      add `"publishConfig": {"access": "public"}`, keep `bin: apiforge`, and
      re-run `npm pack` + install-from-tarball.
- [ ] ⛔ **B2** Create the real repository, then replace the 9 files' references
      to `github.com/higayes/apiforge` and confirm the `mohammedsofian2008@gmail.com`
      address receives mail (or replace it) — it is the only security contact.
- [ ] Update `repository`, `homepage`, `bugs` in `packages/cli/package.json`.
- [ ] Confirm `npm view <name>` is still free **at publish time**.

**Repository configuration**

- [ ] Push to the new remote and let CI run once; confirm all three OS legs pass.
- [ ] Enable branch protection on `main` with required checks:
      `Verify (Node 22 on ubuntu-latest)`, `Package check`.
- [ ] Enable private vulnerability reporting / confirm the SECURITY.md route.
- [ ] Add the `NPM_TOKEN` secret used by `release.yml`.

**Verification (already green, re-run after identity changes)**

- [ ] `pnpm install --frozen-lockfile && pnpm verify` → exit 0.
- [ ] `pnpm test:coverage` → thresholds met.
- [ ] `APIFORGE_TEST_PACK=1 pnpm exec vitest run packages/cli/tests/packaging.test.ts` → 7/7.
- [ ] `pnpm audit` → clean.
- [ ] Install the final tarball into an empty project; run `--version`, `init`,
      `test` and `security` — this is the check that caught the last shipping bug.

**Release**

- [ ] Set the CHANGELOG `[Unreleased]` section to `[0.1.0] — <date>`.
- [ ] `git tag -a v0.1.0 -m "v0.1.0"` and push the tag (this starts `release.yml`).
- [ ] Rehearse first with `workflow_dispatch` and `dry-run: true`.
- [ ] Publish, then verify `npm install -g <name>` in a clean shell.
- [ ] Create the GitHub release from the generated notes.

**Post-release**

- [ ] Watch `security.yml` on the first scheduled run.
- [ ] Open issues for the ROADMAP 0.2 items you actually intend to build.

---

## 16. Bottom line

The CLI does what it advertises. Thirty-five documented invocations pass against
the shipped tarball, the README makes no claim I could falsify, the repository is
free of secrets and debug residue, the dependency tree is small, permissive and
unpatched, and the whole pipeline is green from a clean clone.

I would not publish today for two reasons that have nothing to do with the code:
**the npm name belongs to someone else**, and **every URL in the project points
at a GitHub repository that does not exist**. Resolve those two, re-run
`pnpm verify`, and this is a credible 0.1.0.
