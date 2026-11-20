# Your first contribution

This guide is for a first pull request. It assumes you have used APIFORGE once,
or not at all. If you only read one other document, read
[CONTRIBUTING.md](../CONTRIBUTING.md) after this one — it has the rules this guide
walks you through.

Nothing here needs prior knowledge of the codebase.

## 1. Get it running

You need **Node.js 22.19 or newer**. Nothing else; the project has no database, no
server and no global install.

```bash
node --version          # must be v22.19.0 or higher
corepack enable
corepack prepare pnpm@9.15.4 --activate

git clone https://github.com/higayes/apiforge.git
cd apiforge
pnpm install
pnpm build
```

Then confirm the tools work before changing anything:

```bash
node packages/cli/dist/cli.js --version    # prints 0.1.0
pnpm examples                              # runs the whole product end to end
```

`pnpm examples` starts a small demo API, runs test, performance, security and
contract against it, and prints a pass/fail line per command. If it ends with
`all example runs succeeded — 8/8`, your environment is correct.

## 2. Find something to work on

Good first issues are labelled
[`good first issue`](https://github.com/higayes/apiforge/labels/good%20first%20issue).
Each one names the files to start in and lists what "done" means. If an issue is
ambiguous, ask in the issue before you write code — that is cheaper for everyone
than a rewrite.

If you have spotted something yourself, open an issue first and describe it. A
two-line bug report with a failing suite attached is a genuinely useful
contribution on its own.

## 3. The layout, briefly

```
packages/engine/     the actual work: HTTP, assertions, performance,
                     security, contract, OpenAPI, reports
packages/cli/        argument parsing and output formatting only
examples/demo-api/   a runnable project used by the docs and the examples run
scripts/             the smoke test, the example runner, the demo server
```

The split matters: **the CLI does not do HTTP**, and **the engine does not print**.
If you find yourself adding `console.log` to `packages/engine`, the change probably
belongs in `packages/cli`.

## 4. Make the change

Write the test first if you can. Every behaviour in this repo has a test next to
it, and a pull request without one will be asked for it.

Run the specific test file while you work:

```bash
pnpm --filter ./packages/engine exec vitest run tests/test/runner.test.ts
```

Then before you push, run the same gate CI runs:

```bash
pnpm verify
```

That is `format:check && lint && typecheck && build && test && smoke-test &&
examples`, in that order. It takes about 90 seconds and it is exactly what fails
your pull request if you skip it.

## 5. What reviewers will ask

- **Does the test fail without your change?** If not, the test proves nothing.
- **Is the new behaviour documented?** `README.md` for user-facing commands,
  `docs/` for formats, `CHANGELOG.md` under `Unreleased`.
- **Does it work on Windows?** CI runs Windows and macOS too. Use `node:path`
  instead of string concatenation, never spawn a bare command name, and do not
  assume `/`.
- **Is a new dependency really needed?** The dependency policy is in
  [SECURITY.md](../SECURITY.md); the standard library usually wins.
- **Do secrets stay secret?** If your change touches output, reports or logging,
  see the secret-hygiene guarantee in `SECURITY.md`. A test that proves a secret
  cannot leak is very welcome.

## 6. Open the pull request

Push your branch and open the pull request against `main`. The template asks for
three things: what changed, why, and how you verified it. Fill in the last one
with the actual command you ran and its result.

`main` is protected: it requires the five CI jobs, an up-to-date branch, and a fork
or branch (not a direct push). That is not distrust — it means nobody, including
the maintainer, can merge something red.

## 7. If your pull request goes quiet

The project is currently maintained by one person. If nobody has responded in a
week, comment on the pull request. A polite bump is never rude.

## Not ready to write code?

Three other things are genuinely useful:

- **Report a bug** with the suite file that reproduces it. A minimal failing
  suite is worth more than a paragraph of description.
- **Improve a doc** — if a page confused you, it will confuse the next person,
  and you are the only one who can say exactly which sentence did it.
- **Try it on your own API** and open an issue about what broke. That is the
  feedback this project most needs before 1.0.
