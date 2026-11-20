# APIFORGE — Pre-Release Final Audit

> **⚠️ SUPERSEDED IN PART — historical record, 2026-11-20.**
> The audit itself is unchanged and still valid, but the package identity has
> moved from `@higayes/apiforge-cli` to **`@apiforge-tools/apiforge-cli`**. Read
> the package name below as the identity at the time of the audit, not the current
> one. See `PACKAGE_SCOPE_MIGRATION.md`.

**Date:** 2026-11-20
**Repository:** <https://github.com/higayes/apiforge>
**Audited commit:** `7360925`
**Package:** `@higayes/apiforge-cli@0.1.0` — **not published**
**Verdict:** ✅ **Ready to release, pending two decisions that are yours** (npm
login, and approval to publish). Nothing was published, tagged or released.

Every result below is from an actual run. Where something could not be verified,
it says so rather than guessing.

---

## Summary of what changed

| Area                        | Before                                    | After                            |
| --------------------------- | ----------------------------------------- | -------------------------------- |
| Dependabot                  | 6 open PRs, all failing on stale commits  | 6 resolved, 5 merged, 0 open     |
| Install docs                | `npx apiforge` → **a stranger's package** | `npx @higayes/apiforge-cli`      |
| Release job                 | Would publish a broken install command    | Correct command + provenance     |
| Permissions                 | `contents: write` on a job running builds | Two jobs, least privilege        |
| Branch                      | Unprotected                               | 5 required checks, no force-push |
| Dependabot security updates | Disabled                                  | Enabled                          |
| Discussions                 | Linked but 404                            | Enabled and resolving            |
| Topics                      | None                                      | 14                               |
| Beginner issues             | None                                      | 5, all verified as real gaps     |

---

## 1. Dependabot review

Six PRs were open when the audit started. **All six had failing CI**, and the
reason mattered: every one was branched from `305427f`, a commit older than the
three cross-platform fixes made in the previous session. Their red checks were the
already-fixed Windows `format:check` and Ubuntu `examples` failures — not
regressions from the dependency updates.

Rebasing each onto current `main` was therefore the first step, not merging.

### Final status: 5 merged, 1 superseded, 0 open

| PR  | Change                            | Decision                      | Merge commit |
| --- | --------------------------------- | ----------------------------- | ------------ |
| #2  | `gitleaks/gitleaks-action` 2→3    | **Merged**                    | `c476551`    |
| #5  | `actions/checkout` 4→7            | **Merged**                    | `d319ae8`    |
| #3  | `softprops/action-gh-release` 2→3 | **Merged**                    | `bd7a0ee`    |
| #6  | `@types/node` 24→26               | **Merged**                    | `f3be100`    |
| #4  | `pnpm/action-setup` 4→6           | **Merged**                    | `0bd44c5`    |
| #1  | `github/codeql-action` 3→4        | Withdrawn, then done directly | `a8a4a84`    |

### Per-PR analysis

**#2 — `gitleaks/gitleaks-action` v2 → v3.** The maintainers state it plainly:
"migrates the runtime from Node 20 to Node 24. **No changes to inputs, outputs, or
behavior.**" The urgency is real — GitHub removed the Node 20 runtime on
2026-09-16, so `@v2` stops working entirely. Zero compatibility risk; it is a
required migration. **Merged.**

**#5 — `actions/checkout` v4 → v7.** This is three majors (v5, v6, v7). v5/v6/v7
carry a breaking change: a new `allow-unsafe-pr-checkout` input and safer defaults
for `pull_request_target`. **We do not use `pull_request_target` anywhere** — all
three workflows trigger on `push`, `pull_request`, `schedule` and
`workflow_dispatch` only — so the breaking change does not reach us. v7.0.1 is the
current release. **Merged.**

**#3 — `softprops/action-gh-release` v2 → v3.** v3 is the Node 20 → Node 24
runtime move, again with the same inputs. Used in exactly one place, in the new
`release` job. **Merged.**

**#4 — `pnpm/action-setup` v4 → v6.** The one I was least willing to take on
faith, since this project pins `pnpm@9.15.4` while the action's recent work targets
pnpm 11/12. I read the action's own `action.yml`: `standalone` is documented as
"for pnpm **v11 and earlier**", so pnpm 9 remains supported, and `version` is still
an accepted input. The decisive check was empirical: the rebased PR ran the full
matrix installing pnpm 9.15.4 on Ubuntu, macOS and Windows and passed all of them.
**Merged.**

**#6 — `@types/node` 24.19.2 → 26.6.6.** The only genuine dependency change, and
the only dev-dependency. Semver-major, so I did not take it on trust. I applied it
in an isolated copy of the repo and ran the full gate before merging:

```
pnpm typecheck  → exit 0
pnpm verify     → exit 0 · 321 passed / 1 skipped · smoke 53/53 · examples 8/8
```

`@types/node` is types-only and is never shipped (the tarball contains
`dist/cli.js` only), so the runtime surface is unchanged. **Merged.**

**#1 — `github/codeql-action` v3 → v4.** Dependabot **closed this PR itself** with
"Looks like github/codeql-action is up-to-date now, so this is no longer needed"
after my rebase request. That message is misleading — v3 is deprecated in December 2026. Rather than leave the pin on a deprecated major, I made the change directly.

I verified it is a pure runtime migration before doing so, by diffing the action's
own `init/action.yml` between the two tags:

```
$ diff <(v3/init/action.yml) <(v4/init/action.yml)
183c183
<   using: node20
>   using: node24
```

One line. Same inputs, same queries, same languages. Both lines are still actively
released (v3.39.3 on 2026-11-04, v4.39.4 on 2026-11-20), so this is a deliberate
migration rather than chasing an abandoned branch. Commit `a8a4a84`, and CodeQL
passed on v4 in every run after it.

### Method note

Nothing was merged on the strength of Dependabot's own claim. Each PR was rebased
onto the current `main`, and merged only after its **own** CI run completed green
on all nine jobs. PR #4 needed a close/reopen to force a fresh run on the current
base, because the earlier green checks predated the other merges and would have
proven nothing.

---

## 2. Security review

### 2.1 The most serious finding: the release workflow published poisoned instructions

`.github/workflows/release.yml` built the GitHub release body from:

```yaml
npm install -g apiforge@${{ github.ref_name }}
```

`apiforge` on npm is **not ours**. It is `apiforge@0.0.0`, published in 2013 by a
different owner (`cab`), pointing at `github.com/ampsio/apiforge`. I unpacked it:
it has **no `bin` field at all**, so the documented command cannot work — it
installs a package that provides no command and fails at `npm install`. Anyone
following our release notes would have hit a dead end at best.

The same mistake reached the docs. `README.md`, `packages/cli/README.md` and
`examples/demo-api/README.md` all said `npx apiforge`, and **`npx` executes what it
resolves**. `package.json` for that package has `"main": "index.js"` but no such
file is shipped, so `npx` fails rather than running anyone's code — but relying on
a squatter's packaging mistake for safety is not a security posture.

**Fixed:** all install lines, including the one in the release body, now name
`@higayes/apiforge-cli`. Verified: `grep -rn "npx apiforge\|install -g apiforge"`
returns nothing outside `@higayes/`-scoped references.

### 2.2 My own defect, caught before release

While hardening permissions I put `permissions:` on two individual steps in
`release.yml`. **GitHub only accepts `permissions` at workflow or job level.**
Commit `a8a4a84` therefore made the Release workflow invalid — the run shows
`completed/failure` with **zero jobs and no logs**.

This was mine, and it is worth recording because it is exactly the failure mode
this audit exists to catch: it would have surfaced as "the release workflow doesn't
run" on the day you tried to tag.

**Fixed in `a7d56f8`** by splitting the workflow into two jobs — which is also
stricter than the original:

```
publish  permissions: contents: read, id-token: write   ← runs build scripts
release  permissions: contents: write                    ← runs no project code
```

A build script can no longer reach a `contents: write` token. Verified by parsing
the file and by the absence of any Release run on subsequent pushes (correct: it
only triggers on `v*.*.*`).

### 2.3 GitHub Actions permissions

| Workflow       | Before                                                                       | After                                                                     |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ci.yml`       | `contents: read`                                                             | unchanged (already correct)                                               |
| `security.yml` | `contents: read`, `security-events: write`, `actions: read` on **every** job | `contents: read` default; `security-events: write` only on the CodeQL job |
| `release.yml`  | `contents: write` for the whole job                                          | read-only default; split into two jobs as above                           |

The audit job held `security-events: write` without ever uploading SARIF — an
unnecessary write grant on a job that runs `pnpm audit`. Removed. `actions: read`
was also unnecessary and is gone.

Also added: `build-mode: none` on CodeQL. JavaScript/TypeScript is an interpreted
language, so no database build is needed; stating it explicitly means a future
default change cannot silently break the job.

### 2.4 npm publishing permissions

- `publishConfig.access: public` is set — required, since a scoped package
  published without it goes private and the first publish cannot be undone.
- **`--provenance` added.** The publish step now records the repository, commit and
  workflow that produced the tarball, so a consumer can verify it was built by CI
  and not on someone's laptop. This requires the `id-token: write` permission,
  which is granted to that job and no other.
- The tag/version mismatch check is present and correct (`v0.1.0` must match
  `0.1.0`), as is the `pnpm verify` gate before publishing.
- **Still missing: the `NPM_TOKEN` secret itself.** It cannot be created; see §5.

### 2.5 Dependency security

```
pnpm audit --audit-level low   → No known vulnerabilities found
pnpm audit --prod              → No known vulnerabilities found
```

Runtime dependencies, all at their latest published version:

| Package     | Spec      | Installed | Latest |
| ----------- | --------- | --------- | ------ |
| ajv         | `^8.20.0` | 8.20.0    | 8.20.0 |
| ajv-formats | `^3.0.1`  | 3.0.1     | 3.0.1  |
| commander   | `^15.1.0` | 15.1.0    | 15.1.0 |
| undici      | `^8.12.4` | 8.12.4    | 8.13.0 |
| yaml        | `^2.9.1`  | 2.9.1     | 2.9.1  |
| zod         | `^4.6.7`  | 4.6.7     | 4.6.7  |

`undici` is one patch behind (8.12.4 vs 8.13.0) inside its caret range; Dependabot
will open that PR on its schedule. No advisory is involved.

Only `dist/cli.js` ships, but the six packages above are real runtime dependencies
resolved at install time, so they are the correct attack surface to measure.

### 2.6 Gitleaks and CodeQL configuration

**Gitleaks** — runs with `fetch-depth: 0` so the whole history is scanned, not
just the tip. This matters: the Stripe-shaped test fixture flagged by push
protection in the previous session was found in an _old_ commit. On the audited
commit the job passed:

```
Secret scan → success (steps: Set up job, checkout@v7, gitleaks, Post checkout, Complete)
```

**CodeQL** — `javascript-typescript`, `security-and-quality` query suite (the
broader one, not just `security-extended`), now on v4 with an explicit build mode.
Passed on the audited commit.

### 2.7 `SECURITY.md` reporting instructions

Reviewed in full. Accurate and specific: supported versions, a private reporting
address, 3-day acknowledgement / 10-day assessment commitments, five concrete
security guarantees (secret hygiene, bounded load, no active exploitation,
filesystem safety, reachable dependency vulnerabilities), and a clear out-of-scope
list.

**One judgement call you should make:** the contact is
`mohammedsofian2008@gmail.com` — a real, verified address, but a personal one,
published in a security policy that promises response times. It works. Whether
you want a personal inbox receiving vulnerability reports for a public project is
your call; a dedicated address is the usual answer before wider promotion.

### 2.8 Secrets and credential exposure

- No token, key or password in the tree or in any commit: searched every reachable
  commit for `ghp_*`, `github_pat_*`, `sk_live_*` and `AKIA*`.
- Two files match the `AKIA` pattern: `RELEASE_READINESS_AUDIT.md:271` and
  `packages/engine/tests/security/checks.test.ts:191`. **Both are
  `AKIAIOSFODNN7EXAMPLE`**, AWS's own documented placeholder key, used deliberately
  to prove the disclosure scanner detects one. Gitleaks agrees — it passes on this
  commit. Not secrets, and removing them would break a real test.
- No credentials in `git config --local`; no `.env`, `.netrc` or `.git-credentials`
  in the repository. `.npmrc` contains only `node-linker` and
  `strict-peer-dependencies`.
- Both personal access tokens you pasted into this conversation should still be
  treated as exposed. Push commands used a per-command `http.extraheader`, so
  nothing was written into `.git/config`.

### 2.9 Branch protection and release workflow

`main` was **completely unprotected** (`GET /branches/main/protection` → 404, no
rulesets). Anyone with write access could force-push over the verified history or
merge red code. Now:

| Setting                          | Value                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required status checks           | 5: `Package check`, `Verify (Node 22.19.0 on ubuntu-latest)`, `Verify (Node 22 on ubuntu-latest)`, `Verify (Node 22 on macos-latest)`, `Verify (Node 22 on windows-latest)` |
| Require branches up to date      | **yes** (strict)                                                                                                                                                            |
| Force pushes                     | **forbidden**                                                                                                                                                               |
| Deletion                         | **forbidden**                                                                                                                                                               |
| Required conversation resolution | yes                                                                                                                                                                         |
| `enforce_admins`                 | **no** — deliberate; see below                                                                                                                                              |

`enforce_admins: false` means you can still bypass the gate in an emergency. With
a single maintainer, enforcing it would risk locking you out of your own repository
with no second reviewer to approve. Revisit once there is a second maintainer.

Other repository settings applied: secret scanning **enabled**, push protection
**enabled**, Dependabot security updates **enabled** (was disabled),
squash-only merges, `delete_branch_on_merge`.

---

## 3. Open-source readiness

| Item                         | State                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                  | 430 lines. Install, quick start, 14-command reference, suite format, CI, contributing.                                                                                |
| `CONTRIBUTING.md`            | 166 lines. Setup, layout, the gate, standards, commit conventions. Now links the new first-contribution guide.                                                        |
| `CODE_OF_CONDUCT.md`         | Contributor Covenant, 91 lines, with an enforcement contact.                                                                                                          |
| `SECURITY.md`                | 75 lines. See §2.7.                                                                                                                                                   |
| `LICENSE`                    | MIT, `Copyright (c) 2026 higayes`, matching what GitHub generated.                                                                                                    |
| Issue templates              | 3 files: bug report, feature request, `config.yml` with contact links.                                                                                                |
| PR template                  | Present, asks what/why/how-verified.                                                                                                                                  |
| `docs/first-contribution.md` | **New.** Clean clone → open PR in seven steps.                                                                                                                        |
| GitHub Discussions           | Was **linked but 404** — `has_discussions` was `false` while `config.yml` pointed at `/discussions`. **Enabled**; the URL now returns 200.                            |
| npm metadata                 | `name`, `version`, `description`, `license`, `repository`, `homepage`, `bugs`, `keywords`, `engines`, `bin`, `files`, `publishConfig.access` all present and correct. |
| Topics                       | None → **14** (see §4).                                                                                                                                               |

### Documentation accuracy — the part that needed real work

I checked every documented command against the CLI's actual `--help` output. All
14 documented commands exist and all 14 implemented commands are documented; there
are no phantom features in the README.

But **three files contained install instructions that were wrong**, and wrong in a
way that executes third-party code (`npx`). Fixed in §2.1. This was the only
doc-versus-reality mismatch I found, and it was a significant one.

I also verified the `docs/first-contribution.md` test command by running it. My
first draft said `src/test/runner.test.ts`; the real path is
`tests/test/runner.test.ts`. Corrected before committing — a first-contribution
guide that fails on step one is worse than no guide.

---

## 4. Community adoption preparation

### Repository description

Already set and kept:

> Open-source API testing and quality toolkit. Test smarter. Ship with confidence.

That is accurate and does not overpromise. It reads as a toolkit, not a platform,
which matches what exists.

### Topics (14, applied)

`api-testing`, `api`, `testing`, `cli`, `typescript`, `nodejs`,
`performance-testing`, `security`, `openapi`, `contract-testing`,
`quality-assurance`, `developer-tools`, `qa`, `load-testing`

All describe implemented functionality. I deliberately did not add `postman`,
`insomnia`, `playwright` or `pytest` — none of those are true, and keyword-stuffing
into unrelated searches is how a project gets its first hostile issue.

### First-time contributor guide

`docs/first-contribution.md`, linked from `CONTRIBUTING.md`. Covers getting set up,
finding an issue, the `engine` vs `cli` split (the one architectural fact a
newcomer needs), writing the test first, the exact local gate, the five things
reviewers ask, opening the PR, and what to do if the PR goes quiet. It also names
three ways to contribute without writing code.

### Five beginner-friendly issues — all genuine, all verified

I only filed issues I could prove are real. For each one I checked the actual CLI
`--help` output or the source before writing it.

| #                                                    | Issue                                  | Evidence it is real                                            |
| ---------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| [#7](https://github.com/higayes/apiforge/issues/7)   | `apiforge test --watch`                | `test --help` has no `--watch`; listed as 🚧 in ROADMAP 0.2    |
| [#8](https://github.com/higayes/apiforge/issues/8)   | Parallel suite execution (`--jobs`)    | No `--jobs` or parallel path; ROADMAP 0.2                      |
| [#9](https://github.com/higayes/apiforge/issues/9)   | `apiforge env new`                     | `env --help` lists only `list`, `show`, `validate`             |
| [#10](https://github.com/higayes/apiforge/issues/10) | Multipart file uploads                 | `client.ts` sends `form:` as URL-encoded and documents the gap |
| [#11](https://github.com/higayes/apiforge/issues/11) | "First suite in 5 minutes" walkthrough | README shows commands but no guided first run                  |

Four carry `good first issue`; #10 is labelled `enhancement` only, because
multipart parsing and the filesystem-safety rules are not a beginner's first
afternoon. Each issue names the files to start in, lists acceptance criteria, and
states what it must not break — #8 explicitly reminds the contributor that
`--jobs` must not multiply the load-test concurrency, since `SECURITY.md` promises
bounded load.

No fake contributors, users, stars, downloads or benchmarks appear anywhere in the
repository or in the announcement draft.

### Announcement draft

`ANNOUNCEMENT_DRAFT.md` — a short version and a longer version, plus explicit
instructions on what **not** to add (no user counts, no "used by", no benchmark
comparisons) and where it should be posted. Every factual claim in it was checked
against the CLI: the concurrency cap of 100, the request cap of 100 000, all six
exit codes, and the six runtime dependencies.

**It is unpublished and should stay unpublished until the package is installable.**
An announcement that leads to a failing `npx` is worse than silence.

---

## 5. Final release gate

### Local gate, on the audited tree

```
pnpm verify → exit 0
  format:check  pass
  lint          pass
  typecheck     pass
  build         pass
  tests         321 passed · 1 skipped (322)
  smoke test    53/53
  examples      8/8
```

Tarball: `@higayes/apiforge-cli@0.1.0`, **5 files** (`LICENSE`, `README.md`,
`dist/cli.js`, `dist/cli.js.map`, `package.json`), 224,577 bytes. No `src/`, no
`tests/`.

### CI, on the audited commit `7360925`

| Run          | Result                    | Link                                                           |
| ------------ | ------------------------- | -------------------------------------------------------------- |
| **CI**       | ✅ **success** (5/5 jobs) | <https://github.com/higayes/apiforge/actions/runs/44721173960> |
| **Security** | ✅ **success** (3/3 jobs) | <https://github.com/higayes/apiforge/actions/runs/44721173818> |

```
CI        PASS  Package check
CI        PASS  Verify (Node 22.19.0 on ubuntu-latest)
CI        PASS  Verify (Node 22 on ubuntu-latest)
CI        PASS  Verify (Node 22 on macos-latest)
CI        PASS  Verify (Node 22 on windows-latest)
Security  PASS  CodeQL
Security  PASS  Dependency audit
Security  PASS  Secret scan
```

This green result came **after** all five merges and the CodeQL migration, so it
verifies the final state including every accepted update — not the state before
them.

### Remaining blockers

**A. No npm authentication.** `npm whoami` → `ENEEDAUTH`. Two things are needed
and only you can do them:

1. Sign in and confirm the username `higayes` is available (or register it). The
   scope `@higayes` cannot be published without the matching npm account.
2. Confirm that account may publish `@higayes/apiforge-cli` publicly.

I could not verify username availability: every unauthenticated probe of the npm
user endpoint returns `401` for every name, including ones that certainly exist, so
a `401` proves nothing. `npmjs.com/~higayes` returns `403`.

**B. The `NPM_TOKEN` repository secret does not exist.** The release workflow reads
`secrets.NPM_TOKEN`. Without it, the publish step fails at authentication — after
running the full verification. Create it before tagging.

**C. No `v0.1.0` tag and no GitHub release** — deliberately withheld, as
instructed.

**D. Six open Dependabot PRs:** none. Zero open PRs remain.

### Minor, non-blocking

- `actions/setup-node@v4` is the last action still on an older major. Dependabot
  has not proposed a newer one and I did not force it — `setup-node@v4` is
  current-generation for Node 22 and works. Worth revisiting when v5 lands.
- `undici` is one patch behind inside its caret range (8.12.4 → 8.13.0).
- The personal email address in `SECURITY.md`, `CODE_OF_CONDUCT.md` and the package
  metadata (see §2.7).

---

## 6. Recommended release decision

**Proceed to publish, once A and B are done.**

The code is in a better state than when this audit began, and the improvements are
not cosmetic: the release workflow would have shipped a broken install command to
every user, and `main` had no protection at all.

Before you publish, in this order:

1. `npm login` as `higayes`; confirm `npm whoami` prints it.
2. Add repository secret `NPM_TOKEN` (an npm Automation or Granular token with
   publish rights on `@higayes`).
3. Decide on the personal email address in `SECURITY.md`.
4. Tell me to proceed.

Then, in one session: publish `0.1.0`, verify the published tarball installs from a
clean directory, tag `v0.1.0`, confirm the Release workflow succeeds, and only then
consider the announcement draft.

**Do not** tag before publishing. A tag that points at a version nobody can install
is the one mistake here that cannot be undone — npm versions are permanent, and a
broken 0.1.0 would have to be followed by 0.1.1.

### What is still not true

APIFORGE is **not published**, **not tagged**, and **not announced**. It has no
users, no stars and no adoption data, and this report claims none. What it has is a
green matrix on three operating systems, a hardened release path, and a clean
audit trail.
