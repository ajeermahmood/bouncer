import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { globToRe } from "../gates/lib/glob.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 6e7 })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const SOURCE = /\.(?:m?[jt]sx?|astro|json|md|scss|ya?ml|toml)$/i;

describe("repository health", () => {
  it("has no source file the tool would skip as binary", () => {
    // This is a regression test for a bug the tool had for several releases.
    //
    // `gates/lib/finding.mjs` used raw NUL bytes as fingerprint separators. The
    // runtime behaviour was fine, but the file was then binary, and the runner
    // skips binary files, so the core library was silently never scanned by any
    // gate. Nothing in the output suggested it.
    //
    // A control character in source is almost always accidental, and this is the
    // cheapest possible way to never let it happen quietly again.
    const binary = [];
    for (const path of tracked) {
      if (!SOURCE.test(path)) continue;
      const buf = readFileSync(join(ROOT, path));
      if (buf.includes(0)) binary.push(path);
    }
    expect(binary).toEqual([]);
  });

  it("does not duplicate the demo scope config", () => {
    // The gate logic was correctly shared across four runtimes while the gate
    // CONFIG was copy-pasted into five of them, which is the same drift this
    // project argues against, sitting inside the project. One definition only.
    const offenders = tracked.filter((path) => {
      if (!SOURCE.test(path)) return false;
      if (path === "shared/demo-config.mjs" || path.startsWith("tests/")) return false;
      const buf = readFileSync(join(ROOT, path));
      if (buf.includes(0)) return false;
      return buf.toString("utf8").includes('models: ["order", "customer", "invoice"');
    });
    expect(offenders).toEqual([]);
  });
});

describe("globToRe", () => {
  // Lives in gates/lib so it can be tested at all. It used to be exported from
  // bin/bouncer.mjs, which runs the entire CLI at import time, so importing it
  // to test it would have executed a scan and called process.exit.
  const matches = (pattern, path) => globToRe(pattern).test(path);

  it("matches a single star within one segment only", () => {
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false);
  });

  it("spans directories with a double star", () => {
    expect(matches("tests/**", "tests/a.mjs")).toBe(true);
    expect(matches("tests/**", "tests/deep/nested/a.mjs")).toBe(true);
  });

  it("treats docs/**/x as also matching docs/x", () => {
    expect(matches("docs/**/x.md", "docs/x.md")).toBe(true);
    expect(matches("docs/**/x.md", "docs/a/b/x.md")).toBe(true);
  });

  it("escapes regex metacharacters in a literal path", () => {
    expect(matches("a.b/c+d.ts", "a.b/c+d.ts")).toBe(true);
    expect(matches("a.b/c+d.ts", "axb/c+d.ts")).toBe(false);
  });

  it("anchors, so a pattern does not match a longer path", () => {
    expect(matches("src/a.ts", "other/src/a.ts")).toBe(false);
    expect(matches("src/a.ts", "src/a.ts.bak")).toBe(false);
  });

  it("supports ? as a single non-slash character", () => {
    expect(matches("a?.ts", "ab.ts")).toBe(true);
    expect(matches("a?.ts", "a/.ts")).toBe(false);
  });
});
