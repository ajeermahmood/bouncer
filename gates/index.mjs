import * as secrets from "./secrets.mjs";
import * as scope from "./scope.mjs";
import * as money from "./money.mjs";
import * as migrationSafety from "./migration-safety.mjs";
import * as docLinks from "./doc-links.mjs";

/**
 * The registry.
 *
 * `needs` declares what a gate wants, so the runner can gather it once instead of
 * every gate reaching for the filesystem itself:
 *
 *   source        every tracked source file
 *   markdown      every tracked markdown file
 *   repoFiles     the full path list, for existence checks
 *   addedSql      .sql files added relative to the base branch
 *
 * Adding a gate means adding an entry here and nothing else. That is the point:
 * a new rule should be a small, obvious, reviewable diff, or people stop adding
 * them.
 */
export const GATES = [
  { ...secrets, needs: ["source"], run: (ctx, cfg) => secrets.scan(ctx.source, cfg.secrets) },
  { ...scope, needs: ["source"], run: (ctx, cfg) => scope.scan(ctx.source, cfg.scope) },
  { ...money, needs: ["source"], run: (ctx) => money.scan(ctx.source) },
  {
    ...migrationSafety,
    needs: ["addedSql"],
    run: (ctx) => migrationSafety.scan(ctx.addedSql),
    // Nothing added means nothing to check, not a pass by luck. The runner
    // reports "skipped" rather than "passed" so a green run cannot be mistaken
    // for coverage it did not have.
    skipWhen: (ctx) => ctx.addedSql.length === 0,
    skipReason: "no new migrations in this change",
  },
  {
    ...docLinks,
    needs: ["markdown", "repoFiles"],
    run: (ctx) => docLinks.scan(ctx.markdown, ctx.repoFiles),
  },
];

export function gateByName(n) {
  return GATES.find((g) => g.name === n);
}
