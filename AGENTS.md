# AGENTS.md

Read this before changing anything. It is short on purpose.

## What this repository is

Bouncer is a set of CI gates. Each gate is a pure function that takes files and
returns findings. The gates are the product; the website in `src/` is
documentation for them.

## The one rule that matters here

**A gate must never fail open.**

If a gate cannot do its job (no git history, a file it cannot parse, a config it
does not understand), it reports that it was *skipped* and says why. It does not
return an empty array and let the build go green. "We looked and it was fine" and
"we could not look" are different answers, and only one of them is safe to merge
on.

If you are adding a code path where a gate returns no findings, ask which of
those two things just happened, and make the output say so.

## Where a rule belongs

Not everything belongs in a gate. Put each rule in the cheapest place that can
hold it:

| Kind of rule | Where | Why |
|---|---|---|
| Formatting, import order | Formatter | Deterministic, already solved |
| Types, null safety | Compiler, strict mode | Free and runs everywhere |
| Taste, context, intent | This file | A machine cannot check taste |
| Wrong is expensive | **A gate in `gates/`** | Only this category actually holds |

A rule in this file that you would be upset to find broken in production is in
the wrong place. Move it into a gate.

## Gates are pure

A gate imports from `./lib/finding.mjs` and nothing else. No `node:fs`, no
`child_process`, no `process.env`, no printing.

This is not style. The same functions run in three places:

- `bin/bouncer.mjs`, which reads from disk, in CI
- `functions/api/scan.ts`, a Cloudflare Worker, where there is no filesystem
- the tests, which pass string literals

If a gate needs git history, it takes the history as an argument. The caller
decides where it comes from. See `migration-safety`.

## Adding a gate

1. New file in `gates/`, exporting `name`, `title`, `summary`, `scan`.
2. Register it in `gates/index.mjs` with what it `needs`.
3. Tests in `tests/gates.test.mjs`. **Test that it stays quiet**, not only that
   it fires. At least one negative test per rule. A gate with false positives is
   worse than no gate, because it gets switched off and everyone still feels
   covered.
4. Add a card in `src/pages/index.astro` so it is documented where people look.

## Findings

- Report a location and a rule id. **Never include the matched text.** A secret
  scanner that quotes what it found writes the secret into the CI log, which is
  more public than the file it came from.
- Every finding needs a `fix` that says what to do instead. "This is wrong" with
  no way forward is how a gate earns its reputation as an obstacle.
- `error` blocks the merge. `warn` does not. Choose `warn` when you are not
  confident enough to stop someone's afternoon.

## The escape hatch

Every gate honours a comment on the offending line or the line above:

```
// bouncer-ok(scope): admin dashboard reports across all tenants by design
```

The reason is required. A bare `bouncer-ok(scope):` does not suppress anything.
That is the whole design: the escape hatch is easy to use and impossible to use
silently, so the justification ends up in the file where the next reader finds
it.

Do not add a config option that disables a gate globally. If a gate is wrong
often enough to need that, fix the gate.

## Things that will waste your time

- Windows checkouts. `git ls-files` returns forward slashes, but `path.join` does
  not. Normalise with `.replace(/\\/g, "/")` before comparing paths. An earlier
  version of the doc-links gate passed on Windows and silently checked almost
  nothing on Linux.
- Writing a gate that scans its own rule table and flags itself. Whole-line
  comments are skipped for this reason.
- `npm ci` needs `package-lock.json` committed. It is.

## Conventions

- ES modules, `.mjs` for anything that runs in Node directly.
- No dependencies in `gates/`. It must run with nothing installed.
- Plain SCSS in the site, no framework.
