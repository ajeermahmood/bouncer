import { finding, lines, ERROR, WARN } from "./lib/finding.mjs";

/**
 * The window where the old code runs against the new schema.
 *
 * Almost every deploy pipeline migrates before it swaps the application:
 *
 *     migrate  ->  build  ->  restart
 *
 * Between step one and step three, the PREVIOUS version of your app is talking to
 * the NEW database. On a good day that window is ninety seconds. If the build
 * fails, that window is however long it takes someone to notice, which at 3am is
 * measured in hours.
 *
 * So a migration is not "does the new code work with this schema". It is "does
 * the OLD code survive this schema". Three statements break that, always:
 *
 *   DROP TABLE / DROP COLUMN   old code still selects it
 *   RENAME                     old code uses the old name; a rename is a drop and
 *                              an add wearing a trenchcoat
 *   ADD COLUMN NOT NULL        with no default, every insert the old code makes
 *                              fails
 *
 * The fix is always the same shape, and it is called expand-contract: add the new
 * thing, deploy code that writes both, backfill, deploy code that reads the new
 * one, and only then, in a LATER release, remove the old thing. It is two deploys
 * where you wanted one. That is the price.
 *
 * Only NEW migrations are checked. History is already applied everywhere and is
 * none of this gate's business, so the caller passes in the added files.
 */
export const name = "migration-safety";
export const title = "Migration safety";
export const summary =
  "Schema changes that break the previous version of the app during the deploy window.";

const RULES = [
  {
    rule: "migration/drop-table",
    re: /\bDROP\s+TABLE\b/i,
    message: "Dropping a table. The running version of the app still reads it until the deploy finishes.",
    fix: "Stop reading it in this release. Drop it in the next one.",
  },
  {
    rule: "migration/drop-column",
    re: /\bDROP\s+(?:COLUMN\b|"?\w+"?\s*(?:,|;|$))/i,
    message: "Dropping a column. Any SELECT * or explicit read in the old version fails immediately.",
    fix: "Stop selecting it in this release, ship, then drop it in the next one.",
  },
  {
    rule: "migration/rename",
    re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i,
    message: "A rename is a drop plus an add. The old version knows only the old name.",
    fix: "Add the new name, write to both, backfill, move reads, then remove the old name later.",
  },
  {
    rule: "migration/add-not-null",
    // NOT NULL on an added column, with no DEFAULT anywhere in the statement.
    re: /\bADD\s+(?:COLUMN\s+)?(?!.*\bDEFAULT\b).*\bNOT\s+NULL\b/i,
    message: "Adding a NOT NULL column with no default. Every insert from the old version fails.",
    fix: "Add it nullable with a default, backfill, then tighten to NOT NULL in a later migration.",
  },
  {
    rule: "migration/type-narrowing",
    re: /\bALTER\s+COLUMN\b.*\bTYPE\b.*\b(?:VARCHAR|CHAR)\s*\(\s*\d+\s*\)/i,
    message: "Narrowing a column type can reject rows the old version still writes.",
    fix: "Widen freely; narrow only after you are certain nothing writes the longer value.",
    severity: WARN,
  },
  {
    rule: "migration/blocking-index",
    re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i,
    message: "Creating an index without CONCURRENTLY takes a write lock on the table for the duration.",
    fix: "Use CREATE INDEX CONCURRENTLY on a table that takes writes in production.",
    severity: WARN,
  },
];

/**
 * The acknowledgement here is per FILE rather than per line, because a migration
 * is one unit of intent. If you have decided this migration is safe (the column
 * never shipped, the change deploys dark), you say so once at the top:
 *
 *     -- bouncer-ok(migration): add_referrals never reached production
 */
const ACK = /--\s*bouncer-ok\(migration\)\s*:\s*\S+/i;

/**
 * @param {{path: string, text: string}[]} addedMigrations only files ADDED vs the base branch
 */
export function scan(addedMigrations) {
  const out = [];
  for (const file of addedMigrations) {
    if (!/\.sql$/i.test(file.path)) continue;
    if (ACK.test(file.text)) continue;

    const all = lines(file.text);
    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      if (/^\s*--/.test(line)) continue;

      for (const r of RULES) {
        if (!r.re.test(line)) continue;
        out.push(
          finding({
            path: file.path,
            line: i + 1,
            rule: r.rule,
            message: r.message,
            fix: r.fix,
            severity: r.severity ?? ERROR,
          })
        );
        break;
      }
    }
  }
  return out;
}
