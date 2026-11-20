# Staged npm publishing — implementation report

**Date:** 2026-11-20
**Commit:** `f318e1e`
**Workflow:** [`.github/workflows/release.yml`](.github/workflows/release.yml)
**Status:** Workflow updated and **verified by a real dry-run in CI**. Nothing was
staged, published, tagged or released.

---

## 1. What changed

One file: `.github/workflows/release.yml`. Nothing else in the repository was
touched.

| Before                                        | After                                             |
| --------------------------------------------- | ------------------------------------------------- |
| `pnpm … publish --access public --provenance` | `npm stage publish --access public --provenance`  |
| Job `publish` / "Publish to npm"              | Job `stage` / "Stage release on npm"              |
| `node-version: '22'`                          | `node-version: '22.19.0'`                         |
| npm = whatever ships with the runner (10.9.3) | pinned `npm@11.21.3`, version-gated               |
| Release job ran on any tag push               | Opt-in: `create-release` + explicit `release-tag` |

### Why npm and not pnpm

`pnpm publish` has no staged-publishing support. The staging call has to be `npm`,
so the runner needs a modern npm regardless of the package manager used for the
build. pnpm still runs `install`, `verify` and the `prepublishOnly` hook.

### Why npm 11, not npm 12

This is the constraint that decides the pin, and it is easy to get wrong:

```
npm@11.15.0  engines: { node: '^20.17.0 || >=22.9.0' }
npm@11.21.3  engines: { node: '^20.17.0 || >=22.9.0' }
npm@12.2.3   engines: { node: '^22.22.2 || ^24.15.0 || >=26.0.0' }
```

npm 12 requires **Node ≥ 22.22.2**. This project declares `engines.node >=
22.19.0` and CI verifies on exactly 22.19.0 — installing npm 12 on that runner
would push the release toolchain past the version the project claims to support.
So the workflow pins `npm@11.21.3`, the newest 11.x.

I verified `11.15.0` is the real floor by unpacking each candidate and checking for
`lib/commands/stage`:

```
npm@11.14.0 → no stage command
npm@11.15.0 → HAS stage
npm@11.16.0 → HAS stage
```

Your stated minimum was exactly right. The workflow still asserts it at runtime:

```bash
node -e "…if(maj<11||(maj===11&&min<15)){…exit(1)}" "$(npm --version)"
```

### Preserved protections

| Protection                                     | State                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `permissions: contents: read` workflow default | unchanged                                                           |
| `id-token: write`, staging job only            | unchanged (required for `--provenance`)                             |
| `contents: write`, release job only            | unchanged; still a separate job so build scripts can never reach it |
| `pnpm verify` before any upload                | unchanged                                                           |
| Tag ↔ package version guard                    | kept, and fixed (see §2)                                            |
| `--provenance`                                 | unchanged                                                           |
| Separate `release` job                         | unchanged                                                           |

Permissions were **not weakened**; the diff does not add a single grant.

### Two bugs found and fixed while doing this

**1. The release job would have advertised a version that does not exist.** It
previously ran on `if: github.event_name == 'push'`, i.e. any tag push. Under a
staging model, a tag push stages — it does not publish — so the release would have
been created for a version still awaiting approval, with an install command that
404s. Now it requires `create-release: true` **and** a non-empty `release-tag`.

**2. `github.ref_name` is the branch on manual dispatch.** The body used
`@${{ github.ref_name }}`, which on a dispatched run renders
`npm install -g @apiforge-tools/apiforge-cli@main`. Replaced with an explicit
`release-tag` input.

Also fixed: the tag/version guard previously compared `GITHUB_REF_NAME` against the
manifest unconditionally, so **every** manual dispatch failed (`main` ≠ `0.1.0`).
It now branches on `GITHUB_EVENT_NAME`.

---

## 2. Verified in real CI

I did not stop at "the YAML parses". I dispatched the workflow with `dry-run: true`,
which exercises the whole job without uploading anything.

**Run:** <https://github.com/higayes/apiforge/actions/runs/44772427227> — **success**

```
JOB: Stage release on npm | success
    success   actions/checkout@v7
    success   pnpm/action-setup@v6
    success   actions/setup-node@v4
    success   Install npm with staged-publishing support
    success   Install
    success   Verify the tag matches package.json
    success   Full verification
    success   Stage (dry run)
    skipped   Stage release
    skipped   Record the stage id
JOB: Create GitHub release | skipped
```

Proof the steps did the right thing, from the run's own log:

```
before: npm 10.9.3
after:  npm 11.21.3
Manual dispatch (main) — staging package version 0.1.0 without a tag
npm notice Staging to https://registry.npmjs.org/ with tag latest and public access (dry-run)
npm notice stage package @apiforge-tools/apiforge-cli@0.1.0 has been staged with tag latest
```

That last line says "staged" but the `(dry-run)` marker and the skipped upload step
confirm nothing left the runner. Registry check afterwards:

```
npm view @apiforge-tools/apiforge-cli version  →  E404   (nothing published)
GitHub releases: 0    remote tags: 0    local tags: 0
```

### Local verification

| Gate                                  | Result                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`      | exit 0                                                                 |
| `pnpm verify`                         | **exit 0**                                                             |
| Unit + integration tests              | **321 passed**, 1 skipped (322)                                        |
| Smoke test                            | **53/53**                                                              |
| Examples                              | **8/8**                                                                |
| Packaging (real tarball install)      | **7/7**                                                                |
| `npm pack --dry-run`                  | `@apiforge-tools/apiforge-cli@0.1.0`, 5 files, 224.6 kB                |
| `npm stage publish --dry-run` locally | stages correctly, no credentials needed                                |
| CI on `f318e1e`                       | ✅ [5/5](https://github.com/higayes/apiforge/actions/runs/44772008483) |
| Security on `f318e1e`                 | ✅ [3/3](https://github.com/higayes/apiforge/actions/runs/44772008391) |

I also executed the workflow's shell logic directly to prove the parsers and
guards, rather than trusting them by reading:

- **Stage-id parser** against a realistic success log → extracted
  `3f9a1c2e-8b4d-4e21-9a77-1c5e0d2b6a44`; against the real `ENEEDAUTH` log →
  empty, so the guard aborts instead of silently passing.
- **Version guard**, all three paths: tag matches → pass; `v0.2.0` vs `0.1.0` →
  correctly rejected; manual dispatch → passes without a tag.

The stage-id step fails the run if npm returns no id, so a "successful" run that
staged nothing cannot pass. The staging command runs under `set -o pipefail`,
because `tee` would otherwise mask npm's exit code.

---

## 3. Important: approval cannot run in CI

This is the single most consequential finding, and it shapes the manual steps.

`npm stage approve` calls `otplease()`, and npm's `utils/auth.js` does this:

```js
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw err; // no OTP prompt is possible
}
```

A runner has no TTY, so **approval requires an interactive 2FA prompt on your
machine.** It cannot be automated from GitHub Actions, and I did not try to work
around it — a workaround would mean storing a bypass-2FA credential, which defeats
the purpose of staging.

Staging, by contrast, is explicitly designed to skip that prompt. From
`lib/commands/publish.js`:

```
// Stage intentionally bypasses otplease — 2FA is deferred to approve/reject
```

So the split is: **CI stages unattended; you approve interactively.** Your token is
correctly scoped — "Read and write (stage only)" can stage but cannot publish, which
is exactly right for a secret that sits in CI.

⚠️ **If your npm account uses a security key (WebAuthn) rather than TOTP, run the
approve command in a real terminal on your machine.** The `--otp` flag can also
carry a token-generated OTP if your setup produces one.

---

## 4. Exact manual steps

### Step 0 — confirm the secret is set (already done)

`NPM_TOKEN` already exists in the repository. Verify it is the **stage-only** token
and not an older publish-capable one:

<https://github.com/higayes/apiforge/settings/secrets/actions>

### Step 1 — stage (CI does this; no tag needed)

Do **not** create a tag yet. Run it by hand:

1. <https://github.com/higayes/apiforge/actions/workflows/release.yml>
2. **Run workflow** → branch `main`
3. `dry-run` = **false**, `create-release` = **false**, `release-tag` = empty
4. Run

This executes `pnpm verify` and then `npm stage publish --access public
--provenance`. Nothing becomes installable. The job summary will print the stage id.

### Step 2 — inspect before approving

On your machine, with the same npm version CI used:

```bash
npm install -g npm@11.21.3
npm login                      # must be an account in the @apiforge-tools org
npm whoami

npm stage list @apiforge-tools/apiforge-cli     # see what is waiting
npm stage view <stage-id>                       # metadata: version, tag, provenance
npm stage download <stage-id>                   # fetch the exact tarball

# inspect the tarball you are about to approve
tar -tzf apiforge-tools-apiforge-cli-0.1.0.tgz
```

Check three things before approving:

- 5 files only: `LICENSE`, `README.md`, `dist/cli.js`, `dist/cli.js.map`,
  `package.json` — no `src/`, no `tests/`
- the `name` inside `package.json` is `@apiforge-tools/apiforge-cli`
- provenance points at `higayes/apiforge` and the workflow run

### Step 3 — approve (interactive; publishes)

```bash
npm stage approve <stage-id>
```

This is the irreversible step: the version becomes installable and the number is
permanently burned.

### Step 4 — verify, then tag

```bash
npm view @apiforge-tools/apiforge-cli version          # 0.1.0
npm install -g @apiforge-tools/apiforge-cli
apiforge --version                                     # 0.1.0
```

Only once that passes:

```bash
git tag -a v0.1.0 -m "APIFORGE v0.1.0"
git push origin v0.1.0
```

### Step 5 — create the GitHub release

Run the workflow with **`create-release` = true** and **`release-tag` = `v0.1.0`**.

Do **not** rely on the tag push to do this. A tag push triggers the _staging_ job,
which would attempt a second staged publish of an already-published version and
fail. The release job is deliberately gated behind the manual input.

### If something is wrong before approval

```bash
npm stage reject <stage-id>
```

Rejection removes it from the staging area and nothing is published.

---

## 5. Blockers and caveats

**No blockers for this task.** The workflow is written, verified in CI, and green.

**Unverified:** that `NPM_TOKEN` is authorized for the `@apiforge-tools`
organization. I cannot check publish permissions without using your credentials,
which I will not do. The dry-run passed because `--dry-run` does not exercise
authorization. Step 1 is what actually proves it — if the token lacks org rights,
that run fails with a clear permission error and nothing is staged.

**Not done, by instruction:** no tag, no release, no staging, no publish.

**One open question for you:** `npm stage publish` uses `tag: latest` by default.
For a first release that is correct. Once 0.1.x is live, future prereleases will
want `--tag next` — worth deciding before the version after this one.
