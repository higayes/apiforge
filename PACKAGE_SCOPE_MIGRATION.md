# Package scope migration: `@higayes` → `@apiforge-tools`

**Date:** 2026-11-20
**Status:** Repository updated and verified. **Nothing published.**

## Identity

|                   | Previous                | Current                            |
| ----------------- | ----------------------- | ---------------------------------- |
| npm package       | `@higayes/apiforge-cli` | **`@apiforge-tools/apiforge-cli`** |
| npm organization  | — (personal scope)      | **`@apiforge-tools`**              |
| CLI command       | `apiforge`              | **`apiforge`** (unchanged)         |
| GitHub repository | `higayes/apiforge`      | `higayes/apiforge` (unchanged)     |
| Version           | `0.1.0`                 | `0.1.0` (unchanged)                |
| Publish access    | `public`                | `public` (unchanged)               |

The executable stays `apiforge`. A scope change alters how the package is
_installed_, never what it is _invoked as_: `bin.apiforge` still points at
`./dist/cli.js`, so `npm install -g @apiforge-tools/apiforge-cli` gives you an
`apiforge` command, exactly as before.

## Why the change is safe

- **The lockfile is not affected.** pnpm keys workspace importers by directory
  (`packages/cli`), not by package name. `pnpm-lock.yaml` contained zero
  occurrences of the old scope before the change and needs no edit. Verified:
  `pnpm install --frozen-lockfile` still succeeds.
- **The workspace config is not affected.** `pnpm-workspace.yaml` globs
  `packages/*` and never names the package.
- **The packaging test is not affected.** It derives the install path from
  `pkg.name` (`pkgName.split('/')`) rather than hardcoding a scope, so it followed
  the rename without a code change. It installs the real tarball and runs the
  binary — 7/7 passed, and the tarball landed in
  `node_modules/@apiforge-tools/apiforge-cli`.
- **No test asserted the scope literally.** The only scope-shaped strings in tests
  are a temporary-directory prefix (`apiforge-cli-`), which is cosmetic.

## Files changed

| File                               | Occurrences | What changed                                    |
| ---------------------------------- | ----------- | ----------------------------------------------- |
| `packages/cli/package.json`        | 1           | `name`                                          |
| `README.md`                        | 3           | `npx`, global install, CI example               |
| `packages/cli/README.md`           | 3           | same (the copy that ships in the tarball)       |
| `examples/demo-api/README.md`      | 5           | five `npx` invocations                          |
| `.github/workflows/release.yml`    | 1           | install command in the GitHub release body      |
| `CHANGELOG.md`                     | 1           | the Unreleased entry describing the install fix |
| `ANNOUNCEMENT_DRAFT.md`            | 5           | unpublished draft                               |
| `RELEASE_IDENTITY_SETUP_REPORT.md` | 0           | annotated as superseded, not rewritten          |
| `PRE_RELEASE_FINAL_AUDIT.md`       | 0           | annotated as superseded in part                 |
| `PACKAGE_SCOPE_MIGRATION.md`       | new         | this file                                       |

**19 occurrences replaced across 7 files.** The two audit reports keep their
original text on purpose: they are dated records of what was true when written.
Rewriting history to say a past audit verified a name that did not exist yet would
make them worthless. They carry a header pointing here instead. Note that
`RELEASE_IDENTITY_SETUP_REPORT.md` §11 contains release commands that would now
target the wrong package — the header says explicitly not to run them.

## Verification

| Gate                                                      | Result                                                   |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                          | exit 0 (no lockfile edit needed)                         |
| `pnpm verify`                                             | **exit 0**                                               |
| Unit + integration tests                                  | **321 passed**, 1 skipped (322)                          |
| Smoke test                                                | **53/53**                                                |
| Example project runs                                      | **8/8**                                                  |
| Packaging / tarball install                               | **7/7**                                                  |
| `npm pack --dry-run`                                      | `@apiforge-tools/apiforge-cli@0.1.0`, 5 files, 224,587 B |
| Clean install → `apiforge --version`                      | `0.1.0`                                                  |
| Clean install → `validate` + `test` against a live server | **2/2 passed**                                           |
| Installed path                                            | `node_modules/@apiforge-tools/apiforge-cli`              |

Tarball contents are unchanged: `LICENSE`, `README.md`, `dist/cli.js`,
`dist/cli.js.map`, `package.json`. No `src/`, no `tests/`.

## Registry state (observed, not assumed)

```
npm view @apiforge-tools/apiforge-cli version  →  E404  (not published — available)
```

**What I could not verify:** that the `@apiforge-tools` organization exists and
that your account may publish to it. Both endpoints that would answer this
(`npmjs.com/org/apiforge-tools`, `npmjs.com/~apiforge-tools`) return **403** to
unauthenticated requests, and there is no npm token in this environment
(`npm whoami` → `ENEEDAUTH`). You stated the organization was created
successfully; I am recording that as your statement, not as something I confirmed.
The publish check in step 4 of the release steps below is what actually proves it.

## Remaining blockers before publishing

1. **npm authentication.** No token here. `npm whoami` → `ENEEDAUTH`.
2. **`NPM_TOKEN` repository secret does not exist.** The release workflow reads
   `secrets.NPM_TOKEN`; without it the publish step fails after the full verify.
   The token must be authorized for the **`@apiforge-tools` organization**, not
   just a personal account — that is the difference from the previous setup.
3. **No `v0.1.0` tag and no GitHub release** — withheld as instructed.
