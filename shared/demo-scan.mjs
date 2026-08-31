import * as secrets from "../gates/secrets.mjs";
import * as scope from "../gates/scope.mjs";
import * as money from "../gates/money.mjs";
import { DEMO_SCOPE_CONFIG, UNAVAILABLE } from "./demo-config.mjs";

/**
 * The scan every hosted endpoint performs, in one place.
 *
 * The gate rules were already shared. What was not shared was the ten lines
 * around them: which gates to run, in what order, the try/catch that stops a
 * throwing gate from reading as a pass, the sort, and the shape of the response.
 * That was copy-pasted into the Cloudflare Worker, the Pages Function and the
 * Railway service.
 *
 * Copying it three times means three chances to fix a bug in two places. It also
 * made the project's central claim untestable: "the same modules run everywhere"
 * was true of the rules and unverified for everything around them. Now there is
 * one function, and a test can assert what it returns.
 *
 * Pure and dependency-free, so it runs in a Worker, in Node and in a browser.
 *
 * @param {string} code
 * @param {string} [filename]
 * @returns {{findings: object[], crashed: {gate: string, message: string}[], unavailable: object[]}}
 */
export function runDemoGates(code, filename = "snippet.ts") {
  const files = [{ path: filename, text: code }];
  const findings = [];
  const crashed = [];

  for (const [gate, run] of [
    ["secrets", () => secrets.scan(files)],
    ["scope", () => scope.scan(files, DEMO_SCOPE_CONFIG)],
    ["money", () => money.scan(files)],
  ]) {
    // A gate that throws must not read as a pass. The single most important
    // invariant in the project, and the reason this loop is worth sharing rather
    // than retyping: it only takes one caller forgetting the try/catch, or
    // swallowing the error, for an endpoint to start reporting clean because a
    // rule crashed.
    try {
      findings.push(...run());
    } catch (e) {
      crashed.push({ gate, message: e.message });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { findings, crashed, unavailable: UNAVAILABLE };
}
