/**
 * Cloudflare Pages Function: run the real gates on a pasted snippet.
 *
 * This is the payoff for keeping gates pure. It imports the same modules the CI
 * runner imports, so the playground on the site cannot drift away from what
 * actually blocks a merge. There is no second implementation to keep in step.
 *
 * Two gates are not available here, and the response says so rather than
 * pretending they passed:
 *   - migration-safety needs git history
 *   - doc-links needs the repository file list
 * Neither exists inside a Worker handling one pasted snippet.
 */
import * as secrets from "../../gates/secrets.mjs";
import * as scope from "../../gates/scope.mjs";
import * as money from "../../gates/money.mjs";

const MAX_BYTES = 64 * 1024;

const SCOPE_CONFIG = {
  models: ["order", "customer", "invoice", "subscription", "payment"],
  tables: ["orders", "customers", "invoices", "subscriptions", "payments"],
  column: "tenantId",
  rawAccessor: "raw",
};

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send JSON: { code, filename }" }, 400);
  }

  const code = typeof body.code === "string" ? body.code : "";
  const filename = typeof body.filename === "string" && body.filename ? body.filename : "snippet.ts";

  if (!code.trim()) return json({ findings: [], unavailable: UNAVAILABLE });
  if (new TextEncoder().encode(code).length > MAX_BYTES) {
    return json({ error: "Snippet is too large. 64KB is plenty for a demonstration." }, 413);
  }

  const files = [{ path: filename, text: code }];

  // A gate that throws must not read as a pass. Same rule as the CLI.
  const findings = [];
  const crashed = [];
  for (const [gate, run] of [
    ["secrets", () => secrets.scan(files)],
    ["scope", () => scope.scan(files, SCOPE_CONFIG)],
    ["money", () => money.scan(files)],
  ]) {
    try {
      findings.push(...run());
    } catch (e) {
      crashed.push({ gate, message: e.message });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return json({ findings, crashed, unavailable: UNAVAILABLE });
}

const UNAVAILABLE = [
  { gate: "migration-safety", reason: "needs git history to know which migrations are new" },
  { gate: "doc-links", reason: "needs the repository file list to check a link resolves" },
];

export async function onRequestGet() {
  return json({ error: "POST { code, filename } here." }, 405);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
