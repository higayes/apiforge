# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

While the project is pre-1.0, security fixes land on the latest release only.

## Reporting a vulnerability

**Do not open a public issue.** Email `maintainers@apiforge.dev` with:

- a description of the issue and its impact
- steps to reproduce, or a proof-of-concept
- the version (`apiforge --version`) and Node version (`node --version`)
- whether you would like public credit

You will get an acknowledgement within **3 business days** and an assessment
within **10 business days**. We will keep you informed of the fix and the
release that contains it, and we will credit you unless you ask us not to.

## What counts as a vulnerability

Anything that breaks one of these guarantees:

1. **Secret hygiene.** A secret (from `secrets:`, `--secret`, or a `${VAR}`
   reference) appearing in terminal output, a report file, an HTML report, a
   JUnit XML file, an error message, or a URL printed to the console.
2. **Bounded load.** The performance engine issuing more requests, more
   concurrency, or more traffic than the configured and documented limits.
3. **No active exploitation.** The security engine sending anything beyond the
   single configured probe requests — no fuzzing, injection, brute force, or
   destructive requests.
4. **Filesystem and command safety.** Writing outside the requested output
   directory, following a symlink out of the project, executing a shell command
   from a configuration file, or reading an arbitrary path from a suite.
5. **Dependency vulnerabilities** in a shipped dependency that are reachable
   through APIFORGE's own code paths.

## Out of scope

- Findings produced _by_ the security engine about **your** target. Those are
  the product working as intended, not a vulnerability in APIFORGE.
- Misconfiguration of a scanned host.
- Running `apiforge performance` against a system you do not own.
- Issues that require an attacker to already control the machine or the
  `apiforge.yaml` in the working directory.

## Safe use of the security and performance engines

Both engines are **defensive tools for authorized testing**:

- Load tests are bounded by hard ceilings (`--concurrency` ≤ 100,
  `--requests` ≤ 100 000). When you specify neither `-d` nor `-n`, the run uses
  a bounded default of 10 seconds (and the default concurrency of 5) rather than
  running open-ended — set `-n` for a hard request cap.
- The security engine performs a **passive** review: it inspects the responses
  the server already returns. It does not attempt exploitation.
- Only run them against systems you own or have **written permission** to test.
  The CLI prints this reminder before starting.

## Dependency policy

- Direct dependencies are pinned with caret ranges and upgraded through
  Dependabot pull requests.
- `pnpm audit` runs in CI on every push to `main`.
- We do not add a dependency for something the standard library does well.

## Disclosure timeline

We aim to ship a fix within 30 days of a confirmed report and will coordinate a
public disclosure date with you. If a fix is not possible in that window we will
say so and publish a mitigation.
