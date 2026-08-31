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
import { MAX_SNIPPET_BYTES } from "../../shared/demo-config.mjs";
import { runDemoGates } from "../../shared/demo-scan.mjs";

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send JSON: { code, filename }" }, 400);
  }

  const code = typeof body.code === "string" ? body.code : "";
  const filename = typeof body.filename === "string" && body.filename ? body.filename : "snippet.ts";

  if (!code.trim()) return json(runDemoGates(""));
  if (new TextEncoder().encode(code).length > MAX_SNIPPET_BYTES) {
    return json({ error: "Snippet is too large. 64KB is plenty for a demonstration." }, 413);
  }

  const { findings, crashed, unavailable } = runDemoGates(code, filename);
  return json({ findings, crashed, unavailable });
}

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
