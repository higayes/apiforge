# Announcement draft

**Status: DRAFT — not published anywhere.** Nothing in this file has been posted.
Publishing it is a separate decision that requires your approval, and it should
not happen before `@higayes/apiforge-cli@0.1.0` is actually installable from npm.

---

## Short version (for a social post or a forum reply)

> I built **APIFORGE**, an open-source CLI that covers the API checks you usually
> wire together from four different tools: functional tests, bounded load tests, a
> passive security review, and contract regression — one config format, one
> report, no server.
>
> `npx @higayes/apiforge-cli init` and you have a runnable project in a few
> seconds. Node 22.19+, MIT.
>
> <https://github.com/higayes/apiforge>
>
> It is 0.1.0 and honestly pre-1.0. If you try it on a real API, I want the bug
> reports.

---

## Longer version (for a Show HN, a blog post, or a Reddit post)

Most API test setups are assembled from separate tools: one for functional tests,
one for load, one for security headers, and a hand-written script for "did this
response shape change". Each has its own config, its own output, and its own
opinion about exit codes.

**APIFORGE is one CLI for all four.**

```bash
npx @higayes/apiforge-cli init
apiforge test        # functional + schema + contract assertions
apiforge performance # bounded load test with latency thresholds
apiforge security    # passive posture review with evidence
apiforge contract    # fail when a response shape regresses
apiforge report reports/latest.json -f html,junit
```

**What makes it different from a thin wrapper around curl:**

- **Bounded by design.** The performance engine refuses to run unbounded load — it
  caps concurrency at 100 and requests at 100 000, and defaults to a bounded run
  rather than running open-ended. The security engine is _passive_: it inspects
  responses the server already returns and never attempts exploitation. Both print
  a reminder that you should only point them at systems you own.
- **Secrets stay secret.** Values from `secrets:` never reach terminal output,
  report files, HTML, JUnit XML, error messages or URLs. This is a documented
  guarantee with tests behind it, not a best effort.
- **Real exit codes.** `0` passed, `1` checks failed, `2` bad usage, `3` config
  error, `4` target unreachable, `130` interrupted. `apiforge exit-codes`
  documents them, so CI does not have to guess what a non-zero code meant.
- **No server, no database, no account.** A single self-contained bundle. Node
  22.19+.

**What it does not do yet** — and I would rather say this up front than have you
find out:

- No watch mode, no parallel suite execution (both on the roadmap).
- No multipart file uploads.
- No plugins or programmatic API. Plugins land in 0.3 at the earliest.
- It is 0.1.0. Pre-1.0 releases may include breaking changes; they are always
  listed in the changelog.

**Try it on something real.** `examples/demo-api/` is a working project you can
run without owning an API:

```bash
git clone https://github.com/higayes/apiforge
cd apiforge && pnpm install && pnpm examples
```

If it breaks on your API, open an issue with the suite file that reproduces it.
That is the most useful thing anyone can send me right now.

MIT licensed. <https://github.com/higayes/apiforge>

---

## Notes on using this

**Do not** add any of the following, because none of it is true: user counts,
download counts, star counts, "used by", testimonials, benchmarks against named
competitors, or a claim that it is production-proven. The project has no adoption
data yet; saying otherwise would be the fastest way to lose the credibility the
rest of the post earns.

**Before posting, confirm:**

| Check                                                          | Why                               |
| -------------------------------------------------------------- | --------------------------------- |
| `npm view @higayes/apiforge-cli version` returns `0.1.0`       | The post tells people to `npx` it |
| `npx @higayes/apiforge-cli --version` works from a clean shell | Same                              |
| The GitHub repository is public and the README renders         | It is the destination             |
| Discussions are open                                           | The post invites questions        |

**Where this actually belongs**, in rough order of likely value: a short post on a
forum where you already participate, then a Show HN (needs a working demo and an
author present to answer), then a blog post with the "why" story. Cross-posting
the same text to five places on the same day reads as spam and usually goes badly.

**Timing:** after the npm publish, not before. An announcement that leads to a 404
on the install command is worse than no announcement.
