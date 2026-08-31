/**
 * The same gates, as a plain Node service. Deployed on Railway.
 *
 * This exists to make one point precisely. `functions/api/scan.js` is a
 * Cloudflare Worker, `bin/bouncer.mjs` is a CLI, `Playground.tsx` runs them in a
 * browser tab, and this is a long-lived Node process. Four runtimes, four
 * deployment models, and not one line of duplicated rule logic between them.
 *
 * That is the entire return on making gates pure functions. It is not an
 * aesthetic preference about side effects; it is the reason a rule can be
 * written once and then enforced in CI, in an editor, in a pre-commit hook, in a
 * hosted API for a team that does not run Node, and on a marketing site.
 */
import { createServer } from "node:http";
import * as secrets from "../gates/secrets.mjs";
import * as scope from "../gates/scope.mjs";
import * as money from "../gates/money.mjs";

const PORT = Number(process.env.PORT) || 8080;
const MAX_BYTES = 64 * 1024;

const SCOPE_CONFIG = {
  models: ["order", "customer", "invoice", "subscription", "payment"],
  tables: ["orders", "customers", "invoices", "subscriptions", "payments"],
  column: "tenantId",
  rawAccessor: "raw",
};

const server = createServer((req, res) => {
  const send = (status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  // Railway health checks hit the root. Answer it cheaply and without touching
  // the gates, so a health check cannot be affected by a bad rule.
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return send(200, { ok: true, gates: ["secrets", "scope", "money"] });
  }

  if (req.method !== "POST" || !req.url.startsWith("/scan")) {
    return send(404, { error: "POST /scan with { code, filename }" });
  }

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on("aborted", () => {
    if (!res.headersSent) send(413, { error: "Snippet too large. 64KB is plenty." });
  });

  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, { error: "Body must be JSON: { code, filename }" });
    }

    const code = typeof body.code === "string" ? body.code : "";
    const filename =
      typeof body.filename === "string" && body.filename ? body.filename : "snippet.ts";
    if (!code.trim()) return send(200, { findings: [], crashed: [] });

    const files = [{ path: filename, text: code }];
    const findings = [];
    const crashed = [];

    // A gate that throws must not read as a pass. Same rule as the CLI and the
    // Worker; it is the one invariant that is worth repeating in every caller.
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
    send(crashed.length ? 500 : 200, { findings, crashed });
  });
});

server.listen(PORT, () => {
  process.stdout.write(`bouncer api listening on ${PORT}\n`);
});
