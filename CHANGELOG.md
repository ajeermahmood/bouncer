# Changelog

Notable changes. Dates are the day the work was done.

## 0.2.0 - 2026-08-31

The first version was correct on its own test fixtures. This one was run against a
real 1,209 file production monorepo, and most of what follows came from reading
every finding it produced by hand.

### Precision

Blocking findings on that repository went from **45 to 13**, and all 13 remaining
were verified as genuine defects. The 32 that went away were false positives in
three families.

- **Test fixtures downgraded, not excluded.** Credential-shaped strings in
  `*.spec.*`, `*.test.*`, `__tests__/`, `fixtures/` and `e2e/` were 35% of all
  findings and every one was deliberate test data. They now report as warnings.
  Excluding those files outright would have hidden a genuinely leaked key, so they
  are still scanned. `sk_live_` stays blocking even in a test, because Stripe
  separates live from test credentials by prefix.
- **Percentages no longer read as money bugs.** `Math.round(x * 100)` is both the
  canonical currency defect and the canonical way to render a percentage.
  Suppressed by a literal `%`, by a percentage-shaped identifier, or by a division
  inside the rounded expression, since a percentage is a part over a whole and
  money conversion never divides before scaling. Only unambiguous money words
  override the last one: `total`, `net` and `gross` are ordinary counting words,
  and a progress pill was being reported as a currency defect because of one.
- **Local development credentials ignored.**
  `postgresql://postgres:postgres@localhost:5432/app` in a setup script grants
  nothing to whoever reads it.
- **Documentation domains narrowed.** `example.com` and friends are reserved by
  RFC 2606 and are placeholders by definition. `example-corp.io` is somebody's
  real company and is no longer excused by a loose word match.
- Money findings in test files downgrade to warnings, for the same reason as
  secrets.

### Correctness

- **`migration-safety` parses statements instead of lines.** A wrapped
  `ALTER TABLE / ADD COLUMN / NOT NULL` was missed entirely, which is exactly the
  case the gate exists for. Prisma emits single-line DDL, which is why it looked
  fine in testing. Statements are split on semicolons outside string literals,
  line and block comments, and dollar-quoted bodies.
- **A gate that cannot see git history now says so.** A shallow clone has no base
  ref, so no migration looks new, so the previous version printed "no new
  migrations in this change" while checking nothing at all. `skipWhen` now returns
  a reason string and the two cases read differently.
- **Unknown CLI flags exit 2** rather than being ignored. Silently accepting
  `--onyl scope` and scanning everything is how a job passes for a year while
  checking nothing intended.
- **Exit code 2** separated from 1: the runner failing to do its job is not the
  same as a codebase with problems.
- `doc-links` decodes percent-escaped paths, ignores links that climb above the
  repository root, and no longer carries regex state between files.
- New migration rules: `migration/set-not-null` and `migration/validated-fk`.
- Removed NUL bytes used as placeholder tokens in the runner's glob compiler. They
  worked, and they made the file read as binary to `grep` and to Bouncer's own
  file reader, so the tool could not scan its own runner.

### Features

- **`--baseline-write` and `bouncer.baseline.json`.** Grandfather what a codebase
  already has so a gate can be switched on without fixing two hundred things
  first. Fingerprints are content-based, not line-based, so a grandfathered
  finding survives code moving and starts blocking again the moment its line is
  edited. Stale entries are reported so the file can shrink.
- **`--changed`** scans only files that differ from the base ref. Refuses to run
  rather than guessing when the base ref is missing.
- **`--sarif`** emits SARIF 2.1.0 for GitHub code scanning.
- **`--explain <gate>`** describes a gate and how to acknowledge a case.
- **`--no-baseline`, `--no-color`, `--version`, `--help`**, and `--flag=value`
  syntax.
- `scope` reports skipped when no tenant-owned models are configured, instead of
  passing silently.

### Performance

Total scan time on that repository went from **291 ms to 73.6 ms**, a 4.0x
improvement, median of seven runs. Details and method in
[docs/performance.md](docs/performance.md).

- The acknowledgement regex was being compiled once per line per gate, roughly a
  million times on that repository. Now cached, behind a cheap substring reject.
- `scope` was building an alias matcher inside its inner loop, per alias, per
  line. Hoisted to once per alias per file. This alone is 11.3x for that gate.
- Each gate now tests a union of all its rules against the whole file, then
  against each line, before entering the per-rule loop.
- Lines are split once by the runner and shared, rather than once per gate.
- The compiled `scope` config and the `doc-links` directory set are cached, which
  matters for the hosted API and the playground rather than the CLI.
- Fixed a quadratic in the money gate.

### Documentation

- `docs/gates.md`, every rule with what it catches and what it deliberately misses
- `docs/architecture.md`, `docs/adoption.md`, `docs/performance.md`
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates
- `tools/bench.mjs`, with a `--gates` flag so the performance claims above can be
  checked against an older commit rather than trusted

## 0.1.0 - 2026-08-31

First version. Five gates, a runner, a Cloudflare Pages Function, a Node service
for Railway, and an Astro site.

Two bugs found while writing it, both now regression tests:

- The placeholder allowance applied to every rule, so
  `curl https://get.example.com/install.sh | sh` was skipped because the line
  contained "example". Right for a secret, exactly backwards for a shape rule.
- The raw-SQL check read a fixed window of lines forward, so a scoped query
  cleared an unscoped one above it. It failed open.
