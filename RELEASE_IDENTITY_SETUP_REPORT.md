# Release Identity Setup — Report

**Date:** 2026-11-19
**Status:** ⛔ **BLOCKED — neither account is authenticated.** No identity was
changed, no repository was created, nothing was pushed, tagged or published.

I was asked not to fabricate usernames, URLs, permissions or CI results. Both
prerequisites fail on this machine, so sections 1, 2, 3 (selection only), 7 and 8
of the requested report **cannot be filled with real values**. What follows is
what I verified, what is ready, and exactly what you must do.

---

## 1. Verified GitHub account username

**None — there is no authenticated GitHub account on this machine.**

| Check                                      | Result                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| GitHub integration/connector               | **Not available** (`list_connector_tools` → `unsupported`) |
| `gh` CLI                                   | **Not installed**                                          |
| `GITHUB_TOKEN` / `GH_TOKEN` in environment | **Absent**                                                 |
| `~/.git-credentials`                       | **Does not exist**                                         |
| `~/.ssh/` (keys)                           | **Does not exist**                                         |
| Repo git remote                            | **None configured**                                        |
| `GET https://api.github.com/user`          | **HTTP 401**                                               |
| `POST https://api.github.com/user/repos`   | **HTTP 401**                                               |

Egress to GitHub works (public API reads succeed), so this is purely missing
credentials, not a network restriction. **I cannot discover your username, and I
will not guess one.**

### What is needed

Either:

- **A GitHub personal access token** with `repo` scope (classic) or
  _Administration: read/write_ + _Contents: read/write_ (fine-grained), exported
  as `GITHUB_TOKEN`; **or**
- The **GitHub connector enabled** for this conversation, so I can call the API
  through it.

Once one is present I can: confirm your username and account type, create
`apiforge`, push, and read real Actions results.

---

## 2. Actual new GitHub repository URL

**Not created — no URL exists.** Nothing was created because creating a
repository requires authentication (and would have to be created under an account
I cannot verify).

---

## 3. Selected npm package name

**No name was selected or applied**, because choosing correctly depends on an
authenticated npm account: the instruction is to prefer `@USERNAME/apiforge-cli`
"if the authenticated npm account owns that scope", and nothing is authenticated.

**npm identity check:**

```
$ npm whoami
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in.
```

No `//registry.npmjs.org/:_authToken` entry exists in `~/.npmrc` (it contains only
`prefix=`). `npm publish --dry-run` warns _"This command requires you to be
logged in"_.

### Availability evidence (public registry queries, current)

| Name                   | Status                                                |
| ---------------------- | ----------------------------------------------------- |
| `apiforge`             | **TAKEN** — 0.0.0, owned by `cab <conner@pixuli.com>` |
| `apiforge-cli`         | **TAKEN** — 1.0.7                                     |
| `@apiforge/cli`        | Available                                             |
| `apiforge-cli-tool`    | Available                                             |
| `apiforge-api-testing` | Available                                             |
| `apiforge-audit`       | Available                                             |
| `apiforge-toolkit`     | Available                                             |

The `@apiforge` **scope is unclaimed** (0 packages published under it), so it
would only be usable by whoever registers that npm org first.

### Recommendation

1. **`@<your-npm-username>/apiforge-cli`** — best default. Scoped names are
   exempt from the "similar to an existing package" rule that blocks
   `apiforge-something` lookalikes, and it is unambiguous once published.
2. **`apiforge-cli-tool`** — if you want an unscoped name. It is available today,
   but by npm's naming rules it could be challenged; scoped is safer.

I deliberately did **not** apply either name: neither is verified as publishable
by your account, and a scoped name containing a guessed username would be wrong.

---

## 4. Evidence the chosen name is available and publishable

- **Available:** verified by `npm view <name> version` returning `E404` (exit
  code checked, not inferred from output text). Re-run immediately before
  publishing — availability is time-sensitive.
- **Publishable by your account:** **not established.** With no session I cannot
  confirm the account exists, its 2FA/publish settings, or that it owns the
  scope. This requires `npm whoami` and a `--dry-run` from an authenticated
  shell.

---

## 5. Files changed

**No project identity files were changed** — correct values are unknown. In the
real repository, `github.com/apiforge/apiforge` and `maintainers@apiforge.dev`
remain in place and must not ship (see §10).

What I did add is a **verified, deterministic rewrite tool**,
`scripts/apply-identity.mjs`, because hand-editing 14 files invites a
half-applied identity.

**What the tool changes** (14 files, confirmed by a real dry run):

| File                                                                   | Reference                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/cli/package.json`                                            | `name`, `publishConfig.access` (scoped), `repository`, `homepage`, `bugs` |
| `packages/cli/src/cli.ts`                                              | `--help` "Documentation:" line                                            |
| `packages/cli/src/lib/project.ts`                                      | header comment written into every `apiforge init` project                 |
| `packages/engine/src/http/client.ts`                                   | HTTP `user-agent` string                                                  |
| `packages/engine/src/report/html.ts`                                   | HTML report footer link                                                   |
| `README.md`, `packages/cli/README.md`                                  | install command, docs links                                               |
| `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` | URLs, contact                                                             |
| `.github/ISSUE_TEMPLATE/{bug_report,config}.yml`                       | URLs                                                                      |
| `.github/workflows/release.yml`                                        | release config                                                            |
| `package.json` (root)                                                  | `pnpm --filter` targets                                                   |

It then **fails if any stale reference survives**, so the result cannot be
partial.

### Bugs I found in my own tool while testing it (all fixed)

I applied it to scratch clones and ran the real pipeline rather than assuming it
worked:

1. **Renaming broke the build.** `pnpm --filter apiforge` no longer matched the
   package, so the root build script built only the engine, silently produced no
   CLI bundle, and `--version` failed with `MODULE_NOT_FOUND`. Fixed by filtering
   on `./packages/cli`, which is name-independent. This would have shipped a
   broken build.
2. **`format:check` failed immediately after a rewrite** (re-wrapped prose). The
   tool now runs Prettier itself.
3. **An unused import** tripped `eslint`.

---

## 6. Commits created

Four, on `main`, all tooling only — no identity claim, no functional change:

```
039a3ce fix(tool): drop unused import flagged by eslint
713bd70 fix(tool): format after rewriting so pnpm verify passes
51a0939 fix(tool): rewrite pnpm filters when the CLI package is renamed
c24d922 chore: add a deterministic identity-rewrite tool
```

Working tree clean.

---

## 7. Did the initial push succeed?

**No push was attempted.** There is no remote and no credentials. Pushing to a
guessed URL was explicitly out of bounds.

---

## 8. GitHub Actions results and links

**No CI run exists.** No remote ⇒ no run ⇒ no logs. I will not report a job as
passed without a real Actions result. The workflows themselves are valid YAML
with `verify` and `package` jobs and a 3-OS matrix; they have simply never
executed anywhere.

---

## 9. Test and build results (real, on this machine)

Verified on the last four commits and on scratch clones with a **simulated
identity applied** (`exampleuser` / `@exampleuser/apiforge-cli`), so the release
path is proven end to end even though the final values are pending:

| Gate                                              | Result                                     |
| ------------------------------------------------- | ------------------------------------------ |
| `pnpm verify` (real repo, unchanged identity)     | **exit 0**                                 |
| Tests                                             | **321 passed**, 1 skipped, 16 files        |
| Smoke test                                        | **53/53**                                  |
| `pnpm verify` after simulated rename              | **exit 0**                                 |
| `npm pack` of renamed package                     | `@exampleuser/apiforge-cli@0.1.0`, 5 files |
| Install renamed tarball into an empty project     | **succeeds**                               |
| `apiforge --version` from renamed package         | **`0.1.0`** — bin name unchanged           |
| `apiforge init` / `validate` from renamed package | **works**                                  |
| HTML report footer                                | shows the new repo URL                     |
| `--help` "Documentation:"                         | shows the new repo URL                     |

The rename is therefore mechanically safe; only the values are missing.

---

## 10. Remaining blockers

### Blocker A — no GitHub authentication (blocks repository creation and push)

Needs a `GITHUB_TOKEN` with `repo` scope, or the GitHub connector enabled.
Without it I cannot create `apiforge`, push, or observe CI.

### Blocker B — no npm authentication (blocks name choice and publish)

Needs `npm login` (or an `NPM_TOKEN`). The specific name to pick depends on your
username and scope ownership.

### Blocker C — the unverified contact address (independent of the above)

`maintainers@apiforge.dev` appears in `SECURITY.md`, `CODE_OF_CONDUCT.md`,
`package.json` and the git author line. The `apiforge.dev` domain is not
associated with this project, so **I cannot confirm it receives mail**. A dead
security contact is worse than none. **Recommendation:** replace it with a real,
monitored address (a personal address or a project email you actually own) via
the same tool. Until then, treat the SECURITY.md reporting route as not
operational.

### Blocker D — placeholder URLs still in the tree

`github.com/apiforge/apiforge` 404s and is currently printed by `apiforge --help`,
used as the bundle's HTTP `user-agent`, linked in every HTML report footer, and
written into every scaffolded project. **Do not publish v0.1.0 with these.**

### Note — GitHub username is unknown even to me

I cannot tell you your username. It is whatever the authenticated account turns
out to be.

---

## 11. Exact commands for the eventual v0.1.0 release

Run these **in order**, once Blocker A and B are resolved. Each step is
verifiable, so you never have to trust a claim.

### Step 1 — authenticate (you)

```bash
npm login                     # then: npm whoami
export GITHUB_TOKEN=<token>   # repo scope, or enable the GitHub connector
```

### Step 2 — establish identity (me)

```bash
# Confirm both identities
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user \
  | jq '{login, type}'
npm whoami

# Verify the package name is free AND that you can publish it
npm view <CHOSEN_NAME> version   # expect E404
```

### Step 3 — create the repository (me)

```bash
curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" https://api.github.com/user/repos \
  -d '{"name":"apiforge","description":"Open-source API testing and quality toolkit. Test smarter. Ship with confidence.","license_template":"mit","private":false,"has_issues":true}'
```

The response is the authority for the real `full_name` and `html_url` — the URL
gets taken from there, never assumed.

### Step 4 — apply the identity to the project (me)

```bash
node scripts/apply-identity.mjs \
  --github-owner <ACTUAL_OWNER> \
  --npm-name <CHOSEN_NAME> \
  --email <REAL_MONITORED_ADDRESS> \
  [--repo apiforge]
```

This rewrites all 14 files, normalises formatting, and **exits non-zero if any
stale reference remains**.

### Step 5 — verify before pushing (me)

```bash
pnpm install --frozen-lockfile
pnpm verify                                   # expect exit 0
APIFORGE_TEST_PACK=1 pnpm exec vitest run packages/cli/tests/packaging.test.ts
npm pack --dry-run --json | jq '.[0] | {name, version, entryCount}'
grep -rE "github\.com/apiforge|maintainers@apiforge\.dev" \
  --include="*.{md,ts,yml,json}" . | grep -v node_modules   # expect no output
```

### Step 6 — push (me)

```bash
git remote add origin https://github.com/<ACTUAL_OWNER>/apiforge.git
git add -A && git commit -m "chore: set release identity"
git push -u origin main
```

### Step 7 — confirm CI on all three OSes (me, reporting real results)

```bash
gh run list --limit 5        # or the Actions API
```

Ubuntu/Windows/macOS results get reported only from actual run output.

### Step 8 — release (your approval gate)

Only after CI is green and you have approved:

```bash
npm publish --access public            # from packages/cli
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```

`release.yml` also gates publishing on a tag/version match and a full
`pnpm verify`.

---

## Bottom line

The application is unchanged and green: **321 tests, 53 smoke checks, 0 failures**,
verified again after every tooling commit. I could not perform the identity work
because **neither account is authenticated on this machine**, and I will not
invent a username, a URL or a permission.

What is ready: a tool that applies a real identity across all 14 reference sites
in one pass, proven on scratch clones to produce a buildable, testable,
installable package under a _different_ name — while keeping the command
`apiforge`. Give me a `GITHUB_TOKEN` and an `npm login`, plus the address you
want used for security reports, and Steps 2–7 take a few minutes.
