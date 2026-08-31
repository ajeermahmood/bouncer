# Bouncer

**CI gates that let anyone contribute to a codebase without being able to break it.**

Live: [bouncer.pages.dev](https://bouncer.pages.dev) - there is a playground on the
page that runs the real gates on whatever you paste into it.

---

## The problem this solves

More people can write code now than a year ago. A designer can produce a working
page. A support lead can fix their own copy. An agent can open twenty pull
requests before lunch.

Review did not get faster. So the bottleneck moved: it is no longer writing the
change, it is being confident the change is safe.

There are two usual answers and both are bad. Review harder, which does not
scale and puts the entire safety system inside one tired person's attention. Or
restrict contribution to the people who already know where the mines are, which
throws away most of what just became possible.

Gates are the third answer. Write the expensive mistakes down once, as code, and
let the machine check every change forever. A contributor then does not need to
know that `orders` is tenant-scoped or that a float cannot hold money. They will
be told, by name, on the line, with what to do instead.

## What it checks

| Gate | Catches |
|---|---|
| `secrets` | Credentials and private keys, plus code that *reads* like an attack even when it is not |
| `scope` | Database access that reaches around the tenant-scoped client, so one customer can see another's rows |
| `money` | Float arithmetic on currency, and the hardcoded `* 100` that breaks JPY and BHD |
| `migration-safety` | Schema changes that break the previous version of the app during the deploy window |
| `doc-links` | Relative links in docs pointing at files that no longer exist |

Each exists because of a specific bug that is quiet, plausible and costly. None
of them is a style opinion, because style belongs in a formatter.

## Use it

```bash
npx bouncer                        # every gate
npx bouncer --only scope,money     # some of them
npx bouncer --json                 # machine output
npx bouncer --base origin/develop  # what "new" is measured against
```

Exit code is 1 if anything blocking was found.

`bouncer.config.json`:

```json
{
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
- run: npx bouncer --base origin/${{ github.base_ref }}
```

That `fetch-depth: 0` is the difference between a real check and one that
reports "skipped" forever while everybody assumes it is running.

## The escape hatch

Every gate honours a comment on the offending line or the line above it:

```js
// bouncer-ok(scope): finance dashboard, spans all tenants by design
return db.raw.order.aggregate({ _sum: { totalMinor: true } });
```

**The reason is required.** A bare `bouncer-ok(scope):` suppresses nothing.

That one requirement is the whole design. The hatch has to be easy, or people
route around the gate entirely and you lose the signal. It has to be impossible
to use silently, or it decays into a blanket ignore within a quarter. Requiring a
reason gets both, and it puts the justification in the file where the next reader
finds it rather than in a pull request nobody will open again.

## Excluding files, loudly

A repository of gates necessarily contains the patterns its gates look for. The
test fixtures and the playground examples in this repo are hardcoded secrets and
cross-tenant queries on purpose, so exclusion has to exist:

```json
{ "exclude": ["tests/**", "src/components/Playground.tsx"] }
```

What matters is that it is loud. Every run prints how many files each pattern
removed:

```
bouncer - 16 source, 5 markdown, 0 new migrations
         2 files not scanned: src/components/Playground.tsx (1), tests/** (1)
```

An exclude list that quietly grows to cover half the codebase is the most likely
way a setup like this rots, and printing the number on every run is the cheapest
defence against it. Note that this removes a *file* from scanning. It is not a way
to switch a rule off across the repo; that is what the per-line escape hatch is
for, and that one demands a reason.

## Four decisions worth stealing even if you never use this

**A gate never fails open.** If it cannot do its job, no git history, a missing
config, it reports *skipped* and says why. It does not return an empty array and
let the build go green. "We looked and it was fine" and "we could not look" are
different answers and only one of them is safe to merge on. This is the single
most important line in the whole repo.

**Findings never quote what they matched.** A secret scanner that prints what it
found writes the secret into the CI log, which is usually more public than the
file it came from. So a finding carries a location and a rule id, and a human
opens the file. That is a deliberate usability cost, paid on purpose.

**Gates are pure functions.** A gate takes `{path, text}[]` and returns findings.
No filesystem, no git, no printing; all input gathering lives in the runner. That
is not tidiness. It is why the same modules run in CI, inside the Cloudflare
Worker behind the playground, and in the tests, with no second implementation to
drift out of sync. A gate that needs git history takes the history as an
argument.

**Half the tests assert that gates stay quiet.** Catching the bad case is easy.
Not firing on the twenty near-misses around it is the difference between a gate
people keep and a gate that gets switched off in a month, leaving everyone
feeling covered while nothing is checked. Every rule has at least one negative
test.

## Two things that were caught by writing this

Both are in the code as comments, because in six months they are the only thing
standing between a gate and someone deleting it for being annoying.

**The placeholder allowance used to apply to every rule.** So
`curl https://get.example.com/install.sh | sh` sailed straight through: the line
contains the word "example", and the check assumed anything mentioning "example"
was documentation. For a *secret* that reasoning is right, a fake key is
harmless. For a *shape* rule it is exactly backwards, because piping a download
into a shell is dangerous regardless of where it points.

**The raw-SQL check used to read a fixed window of lines forward.** Given an
unscoped query followed by a scoped one, it found the second query's `tenantId`
and cleared the first. A cross-tenant leak was excused because the line below it
happened to be correct. It now stops at the end of the statement. It failed open,
which is the only direction that actually hurts.

## Adding a gate

New file in `gates/`, an entry in `gates/index.mjs`, and tests. `AGENTS.md` has
the contract. There is a `.claude/skills/new-gate` skill that walks an agent
through it, including the part where it tells you the rule you asked for should
not be a gate at all, which is a normal outcome.

There is also `.claude/skills/gate-review`, which covers what the mechanical
gates structurally cannot see: whether a `bouncer-ok` reason is still true, tenant
scoping inside interactive transactions, and whether a migration is genuinely
backward compatible. A green run is necessary, not sufficient, and the honest
version of a tool like this says exactly where it stops.

## Development

```bash
npm install
npm test          # the gates
npm run check     # run bouncer on itself
npm run dev       # the site
npm run build
```

The site is Astro with SCSS, deployed to Cloudflare Pages. The playground posts
to a Pages Function that imports the same gate modules the CI runner does. If
that endpoint is unreachable the component runs them in the browser instead,
which works because they are pure, and the footer tells you which one answered.

## Licence

MIT. Take any of it.

Built by [Ajeer Mohammed](https://ajeer-portfolio.vercel.app). The patterns come
from running gates like these on a multi-tenant e-commerce platform, where
missing one meant a merchant seeing another merchant's orders.
