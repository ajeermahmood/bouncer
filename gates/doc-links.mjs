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

// [text](target), but not ![image](target).
//
// Used with matchAll, which iterates over an internal clone, so this module-level
// regex never carries lastIndex state between files. A plain /g regex driven by
// exec() would, and a throw mid-loop would leave the next file starting halfway
// through its own text.
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const MD = /\.mdx?$/i;

/**
 * Directory set derived from the repo file list, cached.
 *
 * Deriving it walks every path segment of every tracked file. The CLI calls scan
 * once so it does not matter there, but the hosted API calls it per request with
 * the same file list, and recomputing this for a 1,200 file repository on every
 * call is exactly the kind of quiet waste that makes a service feel slow for no
 * reason. Keyed by the Set instance, held weakly so a caller passing fresh sets
 * cannot leak memory.
 */
const DIR_CACHE = new WeakMap();

function directoriesOf(known) {
  const hit = DIR_CACHE.get(known);
  if (hit) return hit;
  const dirs = new Set();
  for (const p of known) {
    let idx = p.indexOf("/");
    while (idx !== -1) {
      dirs.add(p.slice(0, idx));
      idx = p.indexOf("/", idx + 1);
    }
  }
  DIR_CACHE.set(known, dirs);
  return dirs;
}

/**
 * @param {{path: string, text: string}[]} files  markdown files
 * @param {Set<string>|string[]} repoFiles  every path in the repo, forward-slashed
 */
export function scan(files, repoFiles) {
  const known = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);
  const dirs = directoriesOf(known);
  const out = [];

  for (const file of files) {
    if (!MD.test(file.path)) continue;
    // Cheap reject: a document with no "](" has no links to resolve.
    if (file.text.indexOf("](") === -1) continue;

    const from = file.path.replace(/\\/g, "/");
    const slash = from.lastIndexOf("/");
    const baseDir = slash === -1 ? "" : from.slice(0, slash);

    for (const m of file.text.matchAll(LINK)) {
      const raw = m[1];
      if (isExternal(raw)) continue;

      // Strip the anchor. Whether the heading exists is a different gate, and a
      // noisier one, so it is deliberately not checked here.
      const hashAt = raw.indexOf("#");
      const target = hashAt === -1 ? raw : raw.slice(0, hashAt);
      if (!target) continue; // a bare "#anchor" link, same page

      const resolved = resolvePath(baseDir, decodeTarget(target));
      if (resolved === null) continue; // escaped above the repo root; not ours to judge
      if (known.has(resolved) || dirs.has(resolved)) continue;

      out.push(
        finding({
          path: file.path,
          line: lineAt(file.text, m.index),
          rule: "doc-links/broken",
          message: 'This link points at "' + target + '", which does not exist in the repository.',
          fix:
            "Update it to the file's new location, or delete the link. A doc that points " +
            "nowhere sends the next reader, human or agent, somewhere wrong.",
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

/** `%20` and friends. A link written with an escaped space still points at a
 *  real file, and reporting it as broken would be wrong. */
function decodeTarget(t) {
  try {
    return decodeURIComponent(t);
  } catch {
    return t; // malformed escape; judge it as written
  }
}

/**
 * Resolve a relative link against the linking file's directory.
 *
 * Returns null when the path climbs above the repository root. That is not a
 * broken link in any sense this gate can judge, and reporting it would be a
 * false positive on a monorepo doc that legitimately points at a sibling
 * package outside the git root.
 */
function resolvePath(baseDir, target) {
  const parts = target.startsWith("/") ? [] : baseDir ? baseDir.split("/") : [];
  const result = parts.slice();
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (result.length === 0) return null;
      result.pop();
    } else result.push(seg);
  }
  return result.join("/");
}
