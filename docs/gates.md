# Gate reference

Every rule, what it catches, what it deliberately does not, and how to excuse a
case it gets wrong.

A note that applies to all of them: these are **mechanical checks, not proofs**.
They match shapes. Each section below has a "what this misses" part, and those are
not apologies, they are the specification. A tool that claims to catch everything
teaches people to stop reading, and then the one it missed ships.

For the judgement-based half, see [`.claude/skills/gate-review`](../.claude/skills/gate-review/SKILL.md).

---

## secrets

**Credentials, private keys, and code that reads like an attack even when it is not.**

Two different problems share one gate.

### Secrets

| Rule | Fires on |
|---|---|
| `secrets/private-key` | A `-----BEGIN ... PRIVATE KEY-----` header |
| `secrets/aws-access-key` | `AKIA` or `ASIA` followed by 16 uppercase alphanumerics |
| `secrets/github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` plus 36 or more characters |
| `secrets/slack-token` | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` |
| `secrets/stripe-key` | `sk_live_` or `rk_live_` |
| `secrets/openai-key` | `sk-` or `sk-proj-` plus 32 or more characters |
| `secrets/connection-string` | A database URL with an inline password |
| `secrets/assigned-credential` | `password`, `secret`, `api_key`, `access_token`, `client_secret` assigned a quoted literal of 8 or more characters |

### Dangerous shape

The unusual half, and it is here for a reason that is not primarily about
security.

A repository that deploys to a VPS legitimately needs some of these shapes. What
happened in practice is that AI coding agents working in that repo were repeatedly
refused, or escalated to a human, on files that were completely benign, because
the surrounding code pattern-matched to an attack. Sessions died halfway. Nobody
could tell which refusals were real.

Keeping the shape clean fixed it. So this is a working-conditions gate as much as
a security one: the team stopped fighting their own tools.

| Rule | Fires on | Severity |
|---|---|---|
| `shape/pipe-to-shell` | `curl` or `wget` piped into a shell | error |
| `shape/tls-disabled` | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `InsecureSkipVerify: true`, `curl -k` | error |
| `shape/host-key-bypass` | `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null` | error |
| `shape/decoded-payload` | A base64 blob decoded into `eval`, `exec` or a privileged path | warn |
| `shape/chmod-777` | `chmod 777` | warn |

### What it will not report

- **Anything that looks like a placeholder.** `your-api-key-here`, `changeme`,
  `process.env.X`, `<REPLACE_ME>`, and RFC 2606 documentation domains
  (`example.com`, `.net`, `.org`, `.test`). Note the difference between
  `example.net`, which is reserved for documentation and is therefore a sample by
  definition, and `example-corp.io`, which is somebody's real company and is not
  excused.
- **Credentials pointing at a local host.** `postgres://postgres:postgres@localhost:5432/app`
  grants nothing to whoever reads it.
- **Anything in a test file, at error severity.** Findings in `*.spec.*`,
  `*.test.*`, `__tests__/`, `fixtures/` and `e2e/` downgrade to warnings.
  Credential-shaped strings in specs were 35% of all findings on a real repository
  and every one was deliberate. They are downgraded rather than excluded so a
  genuinely leaked key stays visible. **`sk_live_` is the exception and stays
  blocking**, because Stripe separates live from test credentials by prefix.
- **Secrets split across lines.** This is line-based. A key assembled from
  concatenated fragments is not detected.
- **High-entropy strings with no recognisable prefix.** Entropy scanning produces
  far more noise than it is worth at this size.

### Excusing a case

```js
const url = "postgres://u:p@db.acme-corp.io/x"; // bouncer-ok(secrets): documented sample, credentials revoked
```

---

## scope

**Database access that reaches around the tenant-scoped client.**

The bug class: a multi-tenant application where one customer can read or write
another customer's rows. It is the worst bug a SaaS product can ship, it is
silent, and no amount of care prevents it, because preventing it requires every
developer to remember it on every query forever.

**This gate is not the fix.** The fix is a scoped database client that injects the
tenant filter automatically, so ordinary feature code *cannot* get it wrong. Build
that first. This gate closes the gap that client leaves: code that reaches around
it.

| Rule | Fires on |
|---|---|
| `scope/raw-client` | `db.raw.<tenantModel>` where the model is configured as tenant-owned |
| `scope/raw-alias` | The same, through a local alias: `const c = db.raw; c.order...` |
| `scope/raw-sql` | `$queryRaw` and friends touching a tenant-owned table with no scope column anywhere in the statement |

Configure it:

```json
{
  "scope": {
    "models": ["order", "customer"],
    "tables": ["orders", "customers"],
    "column": "tenantId",
    "rawAccessor": "raw",
    "rawSqlCalls": ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]
  }
}
```

With no models and no tables configured the gate reports **skipped**, not passed.

### What it misses, stated plainly

- **Interactive transactions.** `db.$transaction(async (tx) => ...)` binds a
  client to a callback parameter that static analysis cannot follow. This is the
  single most likely place for a real leak to survive a green build. Cover it in
  review.
- **Whether a `bouncer-ok(scope):` reason is still true** months after it was
  written.
- **A tenant-owned model nobody added to the config.** The gate cannot know it
  exists. This is the config's weakest point, and it is why the model list should
  be generated from your schema rather than maintained by hand.

The raw-SQL check reads one statement, bounded by paren balance and capped at 40
lines. It deliberately does not read forward into the next statement: an earlier
version did, found the *following* query's `tenantId`, and cleared an unscoped
query because the line below it happened to be correct.

---

## money

**Float arithmetic on currency, and the hardcoded exponent.**

```js
Math.round(parseFloat(input) * 100)
```

This is how most codebases turn `"12.34"` into minor units. It is wrong twice.

1. **Binary floats.** `10.005` is not representable, so it is stored slightly
   below, and `Math.round` gives `1000` rather than `1001`. The customer is
   charged a cent less, the ledger disagrees with the payment provider, and it
   happens rarely enough that nobody reproduces it for months.
2. **The hardcoded 100.** It assumes two decimal places. Japanese yen has zero, so
   a JPY amount comes out 100x too large. Bahraini dinar has three, so it comes
   out 10x too small. The first time this matters is the day you sell to a new
   country, which is also the day nobody is looking for a currency bug.

| Rule | Fires on |
|---|---|
| `money/float-to-minor` | `Math.round(... * 100)` outside a percentage context |
| `money/hardcoded-exponent` | A money-named value multiplied or divided by a literal `100` |
| `money/float-parse` | `parseFloat` or `Number` applied to a money-named value |
| `money/float-accumulate` | `+=` on a money-named value, reported only in a file that already has a hard finding |

### The percentage problem

`Math.round(x * 100)` is both the canonical money bug and the canonical way to
render a percentage. On a real repository every false positive this gate produced
was a percentage. Three signals suppress it:

- a literal `%` next to the expression
- a percentage-shaped identifier (`pct`, `percent`, `ratio`, `scale`, `progress`, `aspect`, ...)
- **a division inside the rounded expression**, because a percentage is a part over
  a whole, and money conversion never divides before scaling

Only an unambiguous money word (`amount`, `price`, `minor`, `payable`, ...)
overrides the third one. `total`, `net`, `gross` and `balance` do not, because
they are ordinary counting words: `Math.round((done / total) * 100)` on a progress
pill was reported as a currency defect until that was fixed.

Findings in test files downgrade to warnings. A money bug in an assertion is
arithmetic, not a charge to a customer.

---

## migration-safety

**Schema changes that break the previous version of the app.**

Almost every deploy pipeline migrates before it swaps the application:

```
migrate  ->  build  ->  restart
```

Between step one and step three the **previous** version of your app is talking to
the **new** database. On a good day that window is ninety seconds. If the build
fails, it is however long it takes someone to notice, which at 3am is measured in
hours.

So a migration is not "does the new code work with this schema". It is "does the
old code survive this schema".

| Rule | Fires on | Severity |
|---|---|---|
| `migration/drop-table` | `DROP TABLE` | error |
| `migration/drop-column` | `DROP COLUMN x`, or the bare `DROP x` inside `ALTER TABLE` | error |
| `migration/rename` | `RENAME TO`, `RENAME COLUMN`, `RENAME CONSTRAINT` | error |
| `migration/add-not-null` | An added column that is `NOT NULL` with no `DEFAULT` | error |
| `migration/set-not-null` | `ALTER COLUMN ... SET NOT NULL` on an existing column | error |
| `migration/type-narrowing` | `ALTER COLUMN ... TYPE VARCHAR(n)` | warn |
| `migration/blocking-index` | `CREATE INDEX` without `CONCURRENTLY` | warn |
| `migration/validated-fk` | `ADD CONSTRAINT ... FOREIGN KEY` or `CHECK` without `NOT VALID` | warn |

The fix is always the same shape and it is called **expand-contract**: add the new
thing, deploy code that writes both, backfill, deploy code that reads the new one,
and only then, in a *later* release, remove the old thing. Two deploys where you
wanted one. That is the price.

### Only new migrations

History is already applied everywhere and is none of this gate's business, so only
`.sql` files **added** relative to the base ref are checked. That requires git
history. Without it the gate reports:

```
skip  migration-safety (cannot see history: the base ref "origin/main" is not in
      this clone, so no migration can be identified as new)
```

not "no new migrations". Those are different statements and an earlier version
printed the reassuring one.

### It parses statements, not lines

```sql
ALTER TABLE orders
  ADD COLUMN currency VARCHAR(3)
  NOT NULL;
```

The line-based version missed this entirely, because `ADD COLUMN` and `NOT NULL`
are on different lines. Prisma emits single-line DDL, which is why it looked fine
in testing; hand-written migrations wrap constantly. Statements are split on
semicolons outside string literals, line comments, block comments and
dollar-quoted bodies.

### Excusing a migration

Per file, because a migration is one unit of intent:

```sql
-- bouncer-ok(migration): add_referrals never reached production
DROP TABLE referrals;
```

---

## doc-links

**Relative links in markdown pointing at files that no longer exist.**

The cheapest gate here, and it earns its place for a reason that only became
obvious once agents started reading repositories.

A stale doc link used to cost a human thirty seconds: they notice the 404, shrug,
and grep for the file. An agent does not shrug. It follows the link, finds
nothing, and then either invents what the document probably said or spends a long
time hunting. Both outcomes are worse than the broken link, and neither is visible
in the diff it eventually produces.

Docs that lie are a correctness problem now, not a tidiness one.

### What it skips

- External links, `mailto:`, bare `#anchors`, and images
- The anchor part of `guide.md#setup`; whether the heading exists is a different
  and much noisier gate
- Links that climb above the repository root, which a monorepo doc pointing at a
  sibling package legitimately does
- Percent-escaped paths are decoded before checking

### Absolute links back into this repository

Set `repoUrl` and links to your own repo are unwrapped and checked as paths:

```json
{ "doc-links": { "repoUrl": "https://github.com/you/yourrepo" } }
```

This exists because of npm. A README published to the registry keeps its relative
links verbatim, and they resolve against npmjs.com rather than your repository, so
they all 404. This project shipped nineteen broken links onto its own package page
that way, which is an instructive thing to discover about a tool whose job includes
catching documentation that lies.

Rewriting them as absolute GitHub URLs fixes npm, and would normally cost the
coverage, because absolute links are skipped as external. Recognising your own
repository keeps both. Any ref is accepted, so a link pinned to a tag still
resolves, checked against the working tree rather than against history the gate
does not have.

### A cautionary note about how this is scoped

The first version listed files with `git ls-files "*.md" "**/*.md"`. On Linux the
shell expanded those patterns before git saw them, and `**` is not recursive in
sh, so only top-level markdown was checked while the gate cheerfully reported OK.
On Windows the patterns reached git intact and it worked.

A gate that passes for the wrong reason is worse than no gate. The file list is
now an argument and the filtering happens in JavaScript, which behaves the same
everywhere.
