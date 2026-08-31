# Architecture

Small enough to read in one sitting. There are three pieces: pure gates, a runner
that does all the I/O, and four thin callers.

```
gates/*.mjs          pure: (files) -> findings.  no fs, no git, no printing
gates/index.mjs      the registry: what each gate needs, when it must skip
gates/lib/           finding shape, acknowledgement parsing, fingerprints, baseline
bin/bouncer.mjs      the runner: git, file reads, config, baseline, reporting
functions/api/       Cloudflare Pages Function
server/index.mjs     Node service for Railway
src/                 Astro site, with a browser-side caller
```

## Gates are pure functions

A gate takes `{ path, text, lines? }[]` and returns findings. It does not read the
filesystem, shell out to git, read the environment, or print.

This is not a style preference. It is why one implementation of every rule runs in
four places:

| Caller | Runtime | Why it exists |
|---|---|---|
| `bin/bouncer.mjs` | Node CLI | CI, pre-commit, local |
| `functions/api/scan.js` | Cloudflare Worker | the playground; no filesystem exists there |
| `server/index.mjs` | Node service on Railway | a hosted API for teams not running Node |
| `src/components/Playground.tsx` | browser | works with no server at all |

A playground with its own copy of the regexes would drift from the real gates
within a month and start teaching visitors something false. There is nothing to
drift, because there is nothing to copy.

The rule has one real consequence: **a gate that needs git history takes the
history as an argument.** `migration-safety` does not run `git diff`; the runner
does, and hands it the added `.sql` files. That keeps the gate testable on string
literals and keeps every "where does this data come from" decision in one file.

## The registry

`gates/index.mjs` declares what each gate needs, so the runner gathers each input
once rather than every gate reaching for it:

```js
{ ...scope, needs: ["source"], run: (ctx, cfg) => scope.scan(ctx.source, cfg.scope) }
```

Available inputs: `source`, `markdown`, `repoFiles`, `addedSql`.

`skipWhen(ctx, config)` returns a **reason string** when the gate cannot or need
not run, and something falsy otherwise. Returning a reason rather than a boolean
is what makes these two visibly different:

```
skip  migration-safety (no new migrations in this change)
skip  migration-safety (cannot see history: the base ref "origin/main" is not in this clone)
```

The first means we looked and there was nothing to check. The second means we
could not look at all. An early version rendered both as the first, so a shallow
CI clone printed the reassuring message while checking nothing, and would have
kept doing that indefinitely.

## A gate never fails open

Stated once here because it is the property everything else serves.

- Cannot read the input? **Skip, with a reason.** Never pass.
- Threw an exception? **The run fails.** A crashed gate is a failure, not a
  silence; otherwise the build goes green because the check broke before it could
  find anything.
- Unrecognised CLI flag? **Exit 2.** Silently accepting `--onyl scope` and scanning
  everything is how a job passes for a year while checking nothing intended.
- `--changed` with no base ref? **Exit 2.** Scanning everything would be a surprise
  timeout and scanning nothing would pass for the wrong reason, so it stops and
  says which.

## Exit codes

| Code | Means |
|---|---|
| 0 | Nothing blocking |
| 1 | Blocking findings, or a gate crashed |
| 2 | The runner could not do its job |

The 1/2 split matters in CI. A failed check and a broken tool need different
reactions, and collapsing them means a misconfigured runner looks exactly like a
codebase full of problems.

## The finding shape

```js
{ path, line, rule, message, fix, severity }   // severity: "error" | "warn"
```

Two rules about findings, both load-bearing:

**Never include the matched text.** A secret scanner that quotes what it found
writes the secret into the CI log, which is usually more public than the file it
came from. A finding carries a location and a rule id; a human opens the file.

**Every finding needs a `fix`.** "This is wrong" with no way forward is how a gate
earns a reputation as an obstacle. The `fix` has to be actionable by somebody who
has never seen the gate before, because increasingly that is who is reading it.

## The escape hatch

`acknowledged(lines, index, gateName)` looks for a marker on the offending line or
the line above:

```
// bouncer-ok(scope): finance dashboard, spans all tenants by design
```

The trailing reason is required by the regex. A bare marker matches nothing.

The design tension: the hatch has to be easy, or people route around the gate
entirely and you lose the signal. It has to be impossible to use silently, or it
decays into a blanket ignore. Requiring a reason gets both, and puts the
justification in the file rather than in a pull request nobody reopens.

There is deliberately **no config option to disable a gate globally.** If a gate is
wrong often enough to need one, the gate is wrong and should be fixed. File-level
`exclude` exists, and the runner prints how many files each pattern removed on
every run so the list cannot grow quietly.

## Performance shape

Every line-based gate follows the same three-stage funnel, cheapest first:

1. **Path reject.** Extension and directory checks, no file read.
2. **Whole-file union regex.** One alternation of every rule in the gate. If the
   file cannot match, skip it entirely, including the line split.
3. **Per-line union, then the per-rule loop.** Most lines fail the union and never
   reach the loop.

Lines are split once by the runner and shared through `lines(file)`, which caches
on the file object, so three line-based gates split each file once rather than
three times.

See [performance.md](performance.md) for what that was worth, measured.

## Adding a gate

See [CONTRIBUTING.md](../CONTRIBUTING.md), or run the
[`new-gate`](../.claude/skills/new-gate/SKILL.md) skill, which will also tell you
when the rule you want should not be a gate at all.
