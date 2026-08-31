#!/usr/bin/env node
/**
 * Benchmark the gates against a real repository.
 *
 *   node tools/bench.mjs <repo-path> [--runs 7] [--gates <dir>]
 *
 * Measures the SCAN only. Reading files off disk and shelling out to git are the
 * runner's job and are the same work whatever the gates do, so including them
 * would flatter or punish a change for a reason that has nothing to do with it.
 * Files are read once, up front, outside the timed region.
 *
 * Reports the median rather than the mean. A benchmark on a laptop competes with
 * whatever else the machine is doing, and one 400ms outlier drags a mean of seven
 * runs by fifty milliseconds while leaving the median untouched.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const repo = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
const runs = Number(valueOf("runs") ?? 7);
// A Windows path like C:\x\gates is not a valid ESM specifier: `import()` reads
// the drive letter as a URL scheme and rejects it. pathToFileURL is the only
// portable way to load a module by filesystem path.
const gatesArg = valueOf("gates");
const gatesBase = gatesArg
  ? pathToFileURL(resolve(gatesArg) + "/").href
  : new URL("../gates/", import.meta.url).href;

function valueOf(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|astro|vue|svelte|py|go|rb|php|sh|ya?ml|json|sql)$/i;
const MD = /\.mdx?$/i;

const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8", maxBuffer: 6e7 })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const source = [];
const markdown = [];
let bytes = 0;

for (const path of tracked) {
  if (!SOURCE_EXT.test(path) && !MD.test(path)) continue;
  let buf;
  try {
    buf = readFileSync(join(repo, path));
  } catch {
    continue;
  }
  if (buf.length > 512 * 1024 || buf.includes(0)) continue;
  bytes += buf.length;
  const text = buf.toString("utf8");
  (MD.test(path) ? markdown : source).push({ path, text });
}

const secrets = await import(gatesBase + "secrets.mjs");
const scope = await import(gatesBase + "scope.mjs");
const money = await import(gatesBase + "money.mjs");
const docLinks = await import(gatesBase + "doc-links.mjs");

const repoFiles = new Set(tracked);
const scopeConfig = {
  models: ["order", "customer", "invoice", "subscription", "payment"],
  tables: ["orders", "customers", "invoices", "subscriptions", "payments"],
  column: "tenantId",
  rawAccessor: "raw",
};

const cases = [
  ["secrets", () => secrets.scan(source)],
  ["scope", () => scope.scan(source, scopeConfig)],
  ["money", () => money.scan(source)],
  ["doc-links", () => docLinks.scan(markdown, repoFiles)],
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One untimed pass so JIT warm-up is not charged to the first gate measured.
for (const [, fn] of cases) fn();

console.log(
  `\n${repo}\n${source.length} source + ${markdown.length} markdown files, ` +
    `${(bytes / 1048576).toFixed(1)} MB, median of ${runs} runs\n`
);

let totalMedian = 0;
let findings = 0;

for (const [name, fn] of cases) {
  const times = [];
  let out = [];
  for (let i = 0; i < runs; i++) {
    // Line caches live on the file objects, so clear them between runs or every
    // run after the first measures a warm cache and reports a number the real
    // CLI never sees.
    for (const f of source) delete f.lines;
    for (const f of markdown) delete f.lines;
    const t = performance.now();
    out = fn();
    times.push(performance.now() - t);
  }
  const m = median(times);
  totalMedian += m;
  findings += out.length;
  console.log(`  ${name.padEnd(11)} ${m.toFixed(1).padStart(7)} ms   ${String(out.length).padStart(4)} findings`);
}

console.log(
  `  ${"total".padEnd(11)} ${totalMedian.toFixed(1).padStart(7)} ms   ${String(findings).padStart(4)} findings\n`
);
