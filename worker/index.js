/**
 * Cloudflare Worker entry: the API, with static assets behind it.
 *
 * There are two ways to put this site on Cloudflare and they need different
 * plumbing, which is worth writing down because getting it wrong is silent.
 *
 *   Pages   picks up `functions/api/scan.js` by convention and compiles it for
 *           you. Nothing else to configure.
 *   Workers ignores `functions/` entirely. You provide one entry, route what you
 *           want yourself, and hand everything else to the assets binding.
 *
 * The first deployment of this site went out as a Worker, so `/api/scan` was
 * never wired up and returned the static 404 page. Nothing looked broken: the
 * playground caught the failure and ran the gates in the browser instead, exactly
 * as designed. The fallback did its job so well that it hid the outage, which is
 * the honest hazard of building a good fallback. The footer saying which runtime
 * answered is what makes that visible rather than invisible.
 *
 * `functions/api/scan.js` is kept for anyone deploying this to Pages. Both paths
 * import the same gate modules, so there is still exactly one implementation of
 * every rule.
 */
import * as secrets from "../gates/secrets.mjs";
import * as scope from "../gates/scope.mjs";
import * as money from "../gates/money.mjs";

const MAX_BYTES = 64 * 1024;

const SCOPE_CONFIG = {
  models: ["order", "customer", "invoice", "subscription", "payment"],
  tables: ["orders", "customers", "invoices", "subscriptions", "payments"],
  column: "tenantId",
  rawAccessor: "raw",
};

// Stated rather than implied: a gate needing git history or the repository file
// list cannot run against one pasted snippet. Saying so beats letting a visitor
// assume five gates ran when three did.
const UNAVAILABLE = [
  { gate: "migration-safety", reason: "needs git history to know which migrations are new" },
  { gate: "doc-links", reason: "needs the repository file list to check a link resolves" },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/scan") return handleScan(request);

    // Everything else is the static site.
    return env.ASSETS.fetch(request);
  },
};

async function handleScan(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "POST { code, filename } here." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON: { code, filename }" }, 400);
  }

  const code = typeof body.code === "string" ? body.code : "";
  const filename =
    typeof body.filename === "string" && body.filename ? body.filename : "snippet.ts";

  if (!code.trim()) return json({ findings: [], crashed: [], unavailable: UNAVAILABLE });
  if (new TextEncoder().encode(code).length > MAX_BYTES) {
    return json({ error: "Snippet is too large. 64KB is plenty for a demonstration." }, 413);
  }

  const files = [{ path: filename, text: code }];
  const findings = [];
  const crashed = [];

  // A gate that throws must not read as a pass. Same invariant as the CLI, and
  // worth repeating in every caller rather than assumed.
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
  return json({ findings, crashed, unavailable: UNAVAILABLE }, crashed.length ? 500 : 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
