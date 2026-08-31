import { finding, lineAt, ERROR } from "./lib/finding.mjs";

/**
 * Every relative link in the docs points at a file that exists.
 *
 * This is the cheapest gate here and it earns its place for a reason that only
 * became obvious once agents started reading the repo.
 *
 * A stale doc link used to cost a human thirty seconds: they notice the 404,
 * shrug, and grep for the file. An agent does not shrug. It follows the link,
 * finds nothing, and then either invents what the document probably said or
 * spends a long time hunting. Both outcomes are worse than the broken link, and
 * neither is visible in the diff it eventually produces.
 *
 * So: docs that lie are a correctness problem now, not a tidiness one.
 *
 * A note on how this is scoped, because the first version was quietly broken.
 * It listed files with `git ls-files "*.md" "**\/*.md"`. On Linux the shell
 * expanded those patterns before git ever saw them, and `**` is not recursive in
 * sh, so only top-level markdown was checked while the gate cheerfully reported
 * OK. On Windows the patterns reached git intact and it worked. A gate that
 * passes for the wrong reason is worse than no gate. This version takes the file
 * list as an argument and filters in JavaScript, which behaves the same
 * everywhere.
 */
export const name = "doc-links";
export const title = "Documentation links";
export const summary = "Relative links in markdown that point at files which no longer exist.";

// [text](target) but not ![image](target)
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * @param {{path: string, text: string}[]} files  markdown files
 * @param {Set<string>|string[]} repoFiles  every path in the repo, forward-slashed
 */
export function scan(files, repoFiles) {
  const known = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);
  // Directories count as valid targets: [docs](docs/) should resolve.
  const dirs = new Set();
  for (const p of known) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }

  const out = [];
  for (const file of files) {
    if (!/\.mdx?$/i.test(file.path)) continue;
    const from = file.path.replace(/\\/g, "/");
    const baseDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";

    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(file.text)) !== null) {
      const raw = m[1];
      if (isExternal(raw)) continue;

      // Strip the anchor. Whether the heading exists is a different gate, and a
      // noisier one, so it is deliberately not checked here.
      const target = raw.split("#")[0];
      if (!target) continue; // a bare "#anchor" link, same page

      const resolved = resolvePath(baseDir, target);
      if (known.has(resolved) || dirs.has(resolved)) continue;

      out.push(
        finding({
          path: file.path,
          line: lineAt(file.text, m.index),
          rule: "doc-links/broken",
          message: `This link points at "${target}", which does not exist in the repository.`,
          fix: "Update it to the file's new location, or delete the link. A doc that points nowhere sends the next reader, human or agent, somewhere wrong.",
          severity: ERROR,
        })
      );
    }
  }
  return out;
}

function isExternal(href) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || // http:, mailto:, tel:, ...
    href.startsWith("//") ||
    href.startsWith("#") ||
    href.startsWith("{") // template placeholder
  );
}

function resolvePath(baseDir, target) {
  const start = target.startsWith("/")
    ? []
    : baseDir
      ? baseDir.split("/")
      : [];
  const parts = [...start];
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
