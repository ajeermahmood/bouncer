# Bouncer

**CI gates that let anyone contribute to a codebase without being able to break it.**

Live demo: [bouncer.ajeermdk001.workers.dev](https://bouncer.ajeermdk001.workers.dev) - paste code into the
playground and the real gate modules run on it.

```bash
npx bouncer-gates
```

The npm package is `bouncer-gates`; the command it installs is `bouncer`. To run it
straight from source without installing anything:

```bash
npx github:ajeermahmood/bouncer
```

---

## The problem

More people can write code now than a year ago. A designer can produce a working
page. A support lead can fix their own copy. An agent can open twenty pull
requests before lunch.

Review did not get faster. So the bottleneck moved: it is no longer writing the
change, it is being confident the change is safe.

There are two usual answers and both are bad. Review harder, which does not scale
and puts the whole safety system inside one tired person's attention. Or restrict
contribution to the people who already know where the mines are, which throws
away most of what just became possible.

Gates are the third answer. Write the expensive mistakes down once, as code, and
let the machine check every change forever. A contributor then does not need to
know that `orders` is tenant-scoped or that a float cannot hold money. They will
be told, by name, on the line, with what to do instead.

## What it checks

| Gate | Catches |
|---|---|
| [`secrets`](docs/gates.md#secrets) | Credentials and private keys, plus code that *reads* like an attack even when it is not |
| [`scope`](docs/gates.md#scope) | Database access that reaches around the tenant-scoped client, so one customer can see another's rows |
| [`money`](docs/gates.md#money) | Float arithmetic on currency, and the hardcoded `* 100` that breaks JPY and BHD |
| [`migration-safety`](docs/gates.md#migration-safety) | Schema changes that break the previous version of the app during the deploy window |
| [`doc-links`](docs/gates.md#doc-links) | Relative links in docs pointing at files that no longer exist |

Each exists because of a specific bug that is quiet, plausible and costly. None
is a style opinion, because style belongs in a formatter. [Full reference with
every rule and its rationale](docs/gates.md).

## Use it

```bash
npx bouncer-gates                        # every gate, whole repository
npx bouncer-gates --changed              # only what this branch touched
npx bouncer-gates --only scope,money     # some of them
npx bouncer-gates --explain scope        # what a gate checks, and how to excuse a case
npx bouncer-gates --json                 # machine output
npx bouncer-gates --sarif                # GitHub code scanning
```

Exit code `0` clean, `1` blocking findings, `2` the runner could not do its job.
That last one matters in CI: a failed check and a broken tool need different
reactions, and collapsing them means a misconfigured runner looks exactly like a
codebase full of problems.

`bouncer.config.json`:

```json
{
  "exclude": ["tests/**"],
  "scope": {
    "models": ["order", "customer", "invoice"],
    "tables": ["orders", "customers", "invoices"],
    "column": "tenantId",
    "rawAccessor": "raw"
  }
}
```

In GitHub Actions:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0     # without this the migration gate cannot see what is new
- run: npx bouncer-gates --base origin/${{ github.base_ref }}
```

That `fetch-depth: 0` is the difference between a real check and one that reports
*skipped* forever while everybody assumes it is running. Bouncer will tell you
which of those is happening, by name, on every run.

## Adopting it on a codebase that already has problems

Turning on a new gate in a mature repository surfaces two hundred existing
findings. Nobody fixes two hundred things before merging anything else, so
without an answer here the realistic options are to not add the gate, or to add
it as a warning everyone learns to scroll past.

```bash
npx bouncer-gates --baseline-write
```

That records what is already wrong. Those findings stop blocking; anything **new**
blocks immediately. The debt stays visible and countable, and the bleeding stops
the same afternoon.

The fingerprint is content-based, not line-based. A grandfathered finding survives
moving up and down its file, and starts blocking again the moment somebody edits
that line, which is exactly when it deserves another look. [Why that
matters](docs/adoption.md).

## The escape hatch

Every gate honours a comment on the offending line or the line above it:

```js
// bouncer-ok(scope): finance dashboard, spans all tenants by design
return db.raw.order.aggregate({ _sum: { totalMinor: true } });
```

**The reason is required.** A bare `bouncer-ok(scope):` suppresses nothing.

That one requirement is the whole design. The hatch has to be easy, or people
route around the gate entirely and you lose the signal. It has to be impossible to
use silently, or it decays into a blanket ignore within a quarter. Requiring a
reason gets both, and it puts the justification in the file where the next reader
finds it rather than in a pull request nobody will open again.

## How fast

Measured on a real 1,209 file production monorepo, 947 scannable files, 7.6 MB of
source. Median of seven runs, scan only, on a laptop:

| Gate | Before optimisation | After | |
|---|---|---|---|
| `secrets` | 92.6 ms | 38.8 ms | 2.4x |
| `scope` | 97.3 ms | 8.6 ms | 11.3x |
| `money` | 97.0 ms | 24.3 ms | 4.0x |
| `doc-links` | 4.1 ms | 1.8 ms | 2.3x |
| **total** | **291.0 ms** | **73.6 ms** | **4.0x** |

Reproduce with `npm run bench -- /path/to/repo`.

Three changes did nearly all of it, and none was clever. A union regex tested per
line so most lines skip the per-rule loop; the acknowledgement regex cached
instead of recompiled once per line per gate; and the scope gate's alias matcher
hoisted out of the inner loop, where it was building a `RegExp` per alias per
line. That last one is the 11x. [Details](docs/performance.md).

## Precision

Speed is easy. Not crying wolf is the hard part, and it is what decides whether a
gate survives its first month.

Run over that same repository, an early build reported **45 blocking findings**.
Every one was read by hand. **32 were false positives**, and they came in three
families:

- **Test fixtures.** Credential-shaped strings inside `.spec.ts` files were 35% of
  all findings and every one was deliberate test data. These now downgrade to
  warnings rather than being excluded, so a genuinely leaked key stays visible.
  A live Stripe key stays blocking even in a test, because Stripe separates live
  from test credentials by prefix and `sk_live_` is not plausible fixture data.
- **Percentages.** `Math.round(x * 100)` is both the canonical money bug and the
  canonical way to render a percentage. Progress bars, histogram bins and aspect
  ratio trims were all reported as currency defects.
- **Local development credentials.** `postgresql://postgres:postgres@localhost:5432/app`
  in a setup script's help text. It grants nothing to whoever reads it.

After fixing those the same repository reports **13 blocking findings, and all 13
are real**: four money conversions that break for zero-decimal currencies, four
float parses of currency values, and five documentation links pointing at a file
that no longer exists.

Every one of those false positives is now a named test asserting the gate stays
quiet. Those are the most valuable tests in the suite, because each is a mistake
this tool actually made.

## Four decisions worth stealing even if you never run this

**A gate never fails open.** If it cannot do its job, no git history, a missing
config, it reports *skipped* and says why. It does not return an empty array and
let the build go green. "We looked and it was fine" and "we could not look" are
different answers and only one is safe to merge on. This is the single most
important line in the repo, and getting it wrong is subtle: a shallow CI clone has
no base ref, so no migration looks new, so an early version printed the
reassuring "no new migrations in this change" while checking nothing at all.

**Findings never quote what they matched.** A secret scanner that prints what it
found writes the secret into the CI log, which is usually more public than the
file it came from. So a finding carries a location and a rule id, and a human
opens the file. A deliberate usability cost, paid on purpose.

**Gates are pure functions.** A gate takes `{path, text}[]` and returns findings.
No filesystem, no git, no printing; all input gathering lives in the runner. That
is not tidiness. It is why the same modules run in four places with no duplicated
rule logic: [the CLI](bin/bouncer.mjs), [a Cloudflare Worker](functions/api/scan.js),
[a Node service on Railway](server/index.mjs), and [the browser
playground](src/components/Playground.tsx). A gate needing git history takes the
history as an argument.

**Half the tests assert that gates stay quiet.** Catching the bad case is easy.
Not firing on the twenty near-misses around it is the difference between a gate
people keep and one that gets switched off in a month.

## Two bugs worth reading about

Both are in the code as comments, because in six months those comments are the
only thing standing between a gate and someone deleting it for being annoying.

**The placeholder allowance applied to every rule.** So
`curl https://get.example.com/install.sh | sh` sailed straight through: the line
contains "example", and the check assumed anything mentioning "example" was
documentation. For a *secret* that reasoning is right, a fake key is harmless. For
a *shape* rule it is exactly backwards, because piping a download into a shell is
dangerous regardless of where it points.

**The raw-SQL check read a fixed window of lines forward.** Given an unscoped
query followed by a scoped one, it found the second query's `tenantId` and cleared
the first. A cross-tenant leak excused because the line below it happened to be
correct. It now stops at the end of the statement. It failed open, which is the
only direction that actually hurts.

## Documentation

- [Gate reference](docs/gates.md) - every rule, what it catches, what it misses
- [Architecture](docs/architecture.md) - why gates are pure, how the runner works
- [Adoption](docs/adoption.md) - rolling this out on an existing codebase
- [Performance](docs/performance.md) - what was slow and how it was measured
- [Deployment](docs/deployment.md) - Cloudflare, Railway and npm, and how each fails quietly
- [AGENTS.md](AGENTS.md) - the contract for humans and coding agents
- [CONTRIBUTING.md](CONTRIBUTING.md) - adding a gate

There are two Claude Code skills in [`.claude/skills/`](.claude/skills):
`gate-review` covers what the mechanical gates structurally cannot see, and
`new-gate` walks through adding one, including the part where it tells you the
rule you asked for should not be a gate at all.

## Development

```bash
npm install
npm test                        # unit tests
npm run check                   # bouncer on itself
npm run bench -- ../some-repo   # measure against a real codebase
npm run dev                     # the site
```

The site is Astro with SCSS on Cloudflare Workers. Its own pull requests go through
the gates it describes.

## Licence

MIT. Take any of it.

Built by [Ajeer Mohammed](https://ajeer-portfolio.vercel.app). The patterns come
from running gates like these across eight production repositories, on a
multi-tenant platform where missing one meant a merchant seeing another merchant's
orders.
