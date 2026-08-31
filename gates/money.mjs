import { finding, lines, acknowledged, ERROR } from "./lib/finding.mjs";

/**
 * Two bugs hiding in one innocent-looking expression.
 *
 *     Math.round(parseFloat(input) * 100)
 *
 * This is how most codebases turn "12.34" into minor units. It is wrong twice.
 *
 * 1. BINARY FLOATS. 10.005 is not representable, so it is stored slightly below
 *    10.005, and Math.round gives 1000 rather than 1001. The customer is charged
 *    a cent less, the ledger disagrees with the payment provider, and it happens
 *    rarely enough that nobody reproduces it for months.
 *
 * 2. THE HARDCODED 100. It assumes every currency has two decimal places.
 *    Japanese yen has zero, so a JPY amount comes out 100x too large. Bahraini
 *    dinar has three, so it comes out 10x too small. The first time this matters
 *    is the day you sell to a new country, which is also the day nobody is
 *    looking for a currency bug.
 *
 * The fix is not "round more carefully". It is to stop letting float touch money
 * at all: parse the decimal string to an integer directly, and get the exponent
 * from the currency.
 *
 * This gate is narrow on purpose. It flags the specific shape "float arithmetic
 * on something named like money" and the specific constant 100 next to a currency
 * amount. It will not catch money bugs expressed some other way. It catches the
 * one that is in nearly every codebase.
 */
export const name = "money";
export const title = "Money arithmetic";
export const summary =
  "Float maths on currency, and the hardcoded x100 that breaks every zero- and three-decimal currency.";

const MONEYISH =
  "(?:amount|price|total|subtotal|cost|fee|balance|paise|cents|minor|gross|net|charge|refund|discount|tax|shipping)";

const RULES = [
  {
    rule: "money/float-to-minor",
    re: new RegExp(
      "Math\\.round\\s*\\(\\s*(?:parseFloat|Number|parseInt)?\\s*\\(?[^)]*\\)?\\s*\\*\\s*(?:100|1000)\\b",
      "i"
    ),
    message:
      "This converts a decimal amount to minor units through a float, which rounds the wrong way on values like 10.005.",
    fix: "Parse the decimal string to an integer without going through a float, and take the exponent from the currency rather than assuming 2.",
  },
  {
    rule: "money/hardcoded-exponent",
    re: new RegExp("\\b" + MONEYISH + "\\w*\\s*[*/]\\s*100\\b", "i"),
    message:
      "A currency amount is multiplied or divided by a hardcoded 100, which assumes every currency has two decimal places. JPY has none; BHD has three.",
    fix: "Look the exponent up from the currency code.",
  },
  {
    rule: "money/float-parse",
    re: new RegExp("(?:parseFloat|Number)\\s*\\(\\s*\\w*" + MONEYISH + "\\w*\\s*\\)", "i"),
    message: "A currency value is parsed into a float. Every later operation on it inherits binary rounding error.",
    fix: "Keep money as an integer in minor units, or as a decimal string, all the way through.",
  },
  {
    rule: "money/float-accumulate",
    re: new RegExp("\\b" + MONEYISH + "\\w*\\s*\\+=\\s*(?!\\s*\\d+\\s*;)", "i"),
    message:
      "A currency value is accumulated in place. If it is a float, the error compounds once per line item.",
    fix: "Sum integer minor units. If this is already an integer total, acknowledge it.",
    softOnly: true,
  },
];

export function scan(files) {
  const out = [];
  for (const file of files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file.path)) continue;
    const norm = file.path.replace(/\\/g, "/");
    if (/(?:^|\/)(?:node_modules|dist|build)\//.test(norm)) continue;
    if (norm.includes("gates/money.mjs")) continue;

    const all = lines(file.text);
    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue; // a comment explaining the bug is not the bug
      if (acknowledged(all, i, "money")) continue;

      for (const r of RULES) {
        // The accumulate rule is noisy on its own; only report it when the file
        // already shows float money handling, so it adds context instead of spam.
        if (r.softOnly && !out.some((f) => f.path === file.path)) continue;
        if (!r.re.test(line)) continue;
        out.push(
          finding({
            path: file.path,
            line: i + 1,
            rule: r.rule,
            message: r.message,
            fix: r.fix,
            severity: ERROR,
          })
        );
        break; // one finding per line; the first rule is the most specific
      }
    }
  }
  return out;
}
