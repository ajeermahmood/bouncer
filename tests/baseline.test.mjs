import { describe, it, expect } from "vitest";
import { fingerprint } from "../gates/lib/finding.mjs";
import {
  fingerprintAll,
  createBaseline,
  applyBaseline,
  validateBaseline,
  BASELINE_VERSION,
} from "../gates/lib/baseline.mjs";

const f = (over = {}) => ({
  path: "src/a.ts",
  line: 10,
  rule: "money/float-to-minor",
  message: "m",
  severity: "error",
  ...over,
});

describe("fingerprint", () => {
  it("is stable for the same rule, path and line content", () => {
    expect(fingerprint(f(), "const x = 1;")).toBe(fingerprint(f(), "const x = 1;"));
  });

  it("ignores the line NUMBER, so inserting code above does not invalidate it", () => {
    // This is the whole reason the baseline is content-keyed. Keyed on line
    // numbers, adding one import at the top of a file re-reports every
    // grandfathered finding at once, in a pull request that had nothing to do
    // with any of them, and people stop trusting the tool that same day.
    expect(fingerprint(f({ line: 10 }), "const x = 1;")).toBe(
      fingerprint(f({ line: 400 }), "const x = 1;")
    );
  });

  it("ignores reindentation but not a real edit", () => {
    expect(fingerprint(f(), "  const x = 1;")).toBe(fingerprint(f(), "const   x = 1;"));
    expect(fingerprint(f(), "const x = 2;")).not.toBe(fingerprint(f(), "const x = 1;"));
  });

  it("separates the same line text in different files and under different rules", () => {
    expect(fingerprint(f({ path: "src/b.ts" }), "x")).not.toBe(fingerprint(f(), "x"));
    expect(fingerprint(f({ rule: "money/float-parse" }), "x")).not.toBe(fingerprint(f(), "x"));
  });
});

describe("baseline", () => {
  const lineOf = () => "const minor = Math.round(parseFloat(input) * 100);";

  it("grandfathers what it recorded and blocks what it did not", () => {
    const existing = fingerprintAll([f()], lineOf);
    const baseline = createBaseline(existing);

    const now = fingerprintAll([f(), f({ path: "src/new.ts" })], lineOf);
    const { blocking, grandfathered } = applyBaseline(now, baseline);

    expect(grandfathered).toHaveLength(1);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].path).toBe("src/new.ts");
  });

  it("survives the finding moving to a different line", () => {
    const baseline = createBaseline(fingerprintAll([f({ line: 10 })], lineOf));
    const moved = fingerprintAll([f({ line: 93 })], lineOf);
    expect(applyBaseline(moved, baseline).blocking).toHaveLength(0);
  });

  it("blocks again once the offending line is edited", () => {
    const baseline = createBaseline(fingerprintAll([f()], lineOf));
    const edited = fingerprintAll([f()], () => "const minor = Math.round(parseFloat(input) * 1000);");
    expect(applyBaseline(edited, baseline).blocking).toHaveLength(1);
  });

  it("reports entries that no longer match, so the file can shrink", () => {
    const baseline = createBaseline(fingerprintAll([f(), f({ path: "src/fixed.ts" })], lineOf));
    const { stale } = applyBaseline(fingerprintAll([f()], lineOf), baseline);
    expect(stale).toHaveLength(1);
  });

  it("passes everything through when there is no baseline", () => {
    const now = fingerprintAll([f()], lineOf);
    expect(applyBaseline(now, null).blocking).toHaveLength(1);
    expect(applyBaseline(now, undefined).blocking).toHaveLength(1);
  });

  it("is not confused by a finding fingerprinted as an inherited property name", () => {
    // hasOwnProperty rather than `in`, so a fingerprint that happens to spell
    // "constructor" or "toString" cannot be treated as already baselined.
    const baseline = { version: BASELINE_VERSION, entries: {} };
    const now = [{ ...f(), fp: "constructor" }];
    expect(applyBaseline(now, baseline).blocking).toHaveLength(1);
  });

  it("rejects a baseline from a future version rather than misreading it", () => {
    expect(validateBaseline({ version: 99, entries: {} })).toMatch(/not supported/);
    expect(validateBaseline({ version: BASELINE_VERSION, entries: {} })).toBeNull();
    expect(validateBaseline(null)).toMatch(/not an object/);
    expect(validateBaseline({ version: BASELINE_VERSION })).toMatch(/no entries/);
  });

  it("records a readable rule and path for every entry", () => {
    // A baseline nobody can read in a pull request is a baseline nobody shrinks.
    const baseline = createBaseline(fingerprintAll([f()], lineOf));
    expect(Object.values(baseline.entries)[0]).toEqual({
      rule: "money/float-to-minor",
      path: "src/a.ts",
    });
    expect(baseline.count).toBe(1);
  });
});
