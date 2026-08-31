/**
 * The one shape every gate speaks.
 *
 * Gates are PURE. A gate is handed an array of { path, text } and returns
 * findings. It does not read the filesystem, shell out to git, or print
 * anything. That constraint is the whole architecture:
 *
 *   - `bin/bouncer.mjs` reads files from disk and runs the same functions in CI
 *   - `functions/api/scan.ts` runs them inside a Cloudflare Worker, where there
 *     IS no filesystem, so the playground on the site executes the real gates
 *     rather than a reimplementation that can drift from them
 *   - the tests run them on string literals, with no fixtures on disk
 *
 * One consequence worth naming: a gate that needs git history (see
 * `migration-safety`) takes that history as an INPUT rather than fetching it.
 * The caller decides where history comes from, so the gate stays testable.
 */

/** Severity ranks. A gate fails the build only on `error`. */
export const ERROR = "error";
export const WARN = "warn";

/**
 * @param {object} f
 * @param {string} f.path      file the finding is in
 * @param {number} f.line      1-indexed line
 * @param {string} f.rule      stable id, e.g. "secrets/private-key"
 * @param {string} f.message   what is wrong, in plain words
 * @param {string} [f.fix]     what to do instead
 * @param {string} [f.severity]
 */
export function finding({ path, line, rule, message, fix, severity = ERROR }) {
  return { path, line, rule, message, fix, severity };
}

/**
 * Findings never carry the matched text.
 *
 * A secret scanner that quotes what it found writes the secret into the CI log,
 * which is usually more public than the file it came from. So gates report a
 * location and a rule, and the human opens the file. This is a deliberate
 * usability cost.
 */
export function redact(_matched) {
  return "[redacted]";
}

/** Split once, reuse everywhere. Keeps gates from each re-splitting big files. */
export function lines(text) {
  return text.split(/\r\n|\r|\n/);
}

/** 1-indexed line number for a character offset. */
export function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * An escape hatch every gate honours, so the gates stay usable.
 *
 * A gate with no way to say "I know, and it is fine here" gets deleted the
 * first week it blocks something legitimate. The rule is that the acknowledgement
 * must carry a REASON, on the offending line or the line above it:
 *
 *     const rows = await db.raw(sql); // bouncer-ok(scope): admin report, all tenants by design
 *
 * A bare `bouncer-ok` with no reason does not count. That is what keeps this
 * from decaying into a blanket ignore comment.
 */
export function acknowledged(allLines, lineIndex, gateName) {
  const pattern = new RegExp(
    "bouncer-ok\\(" + escapeRe(gateName) + "\\)\\s*:\\s*\\S+"
  );
  const here = allLines[lineIndex] ?? "";
  const above = allLines[lineIndex - 1] ?? "";
  return pattern.test(here) || pattern.test(above);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
