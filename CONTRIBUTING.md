# Contributing to APIFORGE

Thanks for taking the time to contribute. This document explains how to get a
working development environment, what we expect from a change, and how to get it
merged.

- [Code of conduct](#code-of-conduct)
- [Set up](#set-up)
- [Project layout](#project-layout)
- [The gate](#the-gate)
- [Coding standards](#coding-standards)
- [Tests](#tests)
- [Commits and pull requests](#commits-and-pull-requests)
- [Reporting bugs](#reporting-bugs)
- [Proposing features](#proposing-features)

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking
part you agree to uphold it. Report unacceptable behaviour to
`maintainers@apiforge.dev`.

## Set up

Requirements:

- **Node.js 22.19 or newer** (`node --version`)
- **pnpm 9** (`corepack enable && corepack prepare pnpm@9.15.4 --activate`)

```bash
git clone https://github.com/apiforge/apiforge.git
cd apiforge
pnpm install
pnpm test       # builds first: the CLI tests spawn dist/cli.js
```

Optional, but the fastest way to see the whole product working:

```bash
pnpm examples   # starts the demo API and runs test/performance/security/contract
```

Everything works natively on Windows, macOS and Linux. The test suites, the
smoke test and the examples all spawn `node` directly rather than a shell.

## Project layout

```
packages/engine/   the library: config, http, assertions, test, performance,
                   security, contract, openapi, report
packages/cli/      Commander front end; one file per command in src/commands
examples/demo-api/ a complete runnable project
scripts/           demo server, smoke test, examples runner
docs/              suite format and architecture references
```

Architecture details and extension points are in
[`docs/architecture.md`](docs/architecture.md).

## The gate

Everything must pass before a pull request is reviewed:

```bash
pnpm verify
```

That runs, in order:

1. `prettier --check .` — formatting
2. `eslint .` — lint, including `no-explicit-any` and type-only imports
3. `tsc --noEmit` for the engine, the CLI **and the test sources**
4. `pnpm build` — engine `tsc`, CLI `tsup` (the CLI tests run the bundle)
5. `vitest run` — 321 tests
6. `node scripts/smoke-test.mjs` — 53 end-to-end checks of the built CLI

If a step fails, fix the cause rather than the check. Skipping, disabling or
loosening a test to make CI green will get a change rejected.

## Coding standards

- **TypeScript strict mode** is on, including `noUncheckedIndexedAccess`. No
  `any` (use `unknown` and narrow), no `@ts-ignore`, no non-null assertions to
  silence a real nil case.
- **Prefer pure functions** in the engine. Anything that touches the network or
  the filesystem takes its inputs as parameters so it can be tested.
- **Errors**: throw the typed error that matches the failure
  (`UsageError` → exit 2, `ConfigError`/`ValidationError` → exit 3,
  `RequestError` → exit 4). The engine never sets `process.exitCode`.
- **Messages** are complete sentences with no trailing period in headings, and
  include the offending value and a next step.
- **Secrets**: never interpolate a secret into a log, report, error message or
  test fixture. Use the redaction helpers.
- **Docs**: if you add a flag, add a row to the README table and a case to the
  CLI tests.

## Tests

```bash
pnpm test                       # everything
pnpm test -- packages/engine    # one package
pnpm test:watch                 # watch mode
pnpm test:coverage              # coverage report
```

Guidelines:

- Use the shared mock server (`packages/engine/tests/helpers/mock-server.ts`)
  instead of hitting the internet. Never depend on a third-party service.
- One assertion per behaviour, named after the behaviour, not the function.
- Every bug fix needs a regression test that fails without the fix. Say what the
  bug was in a comment above the test.
- CLI behaviour is tested by spawning `dist/cli.js`
  (`packages/cli/tests/helpers/cli.ts`), which also verifies the packaging.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add --bail to the test command
fix(engine): resolve dataFile relative to the suite directory
docs: document ${VAR} interpolation
test(security): cover cookie SameSite=None without Secure
chore(deps): bump undici to 7.30.2
```

Scopes in use: `engine`, `cli`, `report`, `security`, `perf`, `contract`,
`openapi`, `docs`, `ci`, `deps`.

Before opening a pull request:

1. Rebase on `main` (do not merge `main` into your branch).
2. `pnpm verify` locally.
3. Describe **what** changed, **why**, and **how you verified it**. Screenshots
   or terminal output help for UI and CLI changes.
4. Link the issue it closes.

Keep pull requests focused. A change that mixes a refactor with a feature is
hard to review and will usually be split.

## Reporting bugs

Open an issue using the bug template and include:

- APIFORGE version (`apiforge --version`) and Node version (`node --version`)
- the operating system
- the command you ran, with secrets removed
- the smallest suite file that reproduces the problem
- what you expected and what happened (paste the output)

If you can reproduce it in `examples/demo-api`, say which file triggers it —
that makes the bug far quicker to fix.

**Security issues** go to `maintainers@apiforge.dev`, never to the public issue
tracker. See [SECURITY.md](SECURITY.md).

## Proposing features

Open an issue first — a large pull request that implements an undiscussed
feature may be declined on scope alone. Good proposals state the problem, the
workflow they enable, and the alternative tools they replace. See
[ROADMAP.md](ROADMAP.md) for what is already planned.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
