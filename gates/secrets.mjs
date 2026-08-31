import { finding, lines, acknowledged, ERROR, WARN } from "./lib/finding.mjs";

/**
 * Two problems, one gate.
 *
 * 1. SECRETS. A credential or private key committed to the repo. Obvious harm,
 *    well-trodden ground.
 *
 * 2. DANGEROUS SHAPE. Code that merely READS like offensive tooling: a remote
 *    script piped into a shell, TLS verification switched off, host-key checking
 *    auto-accepted, a payload decoded into a root path.
 *
 * The second one is the unusual half, and it is here for a reason that is not
 * primarily about security.
 *
 * A repository that deploys to a VPS legitimately needs some of these shapes.
 * What happened in practice is that AI coding agents working in that repo were
 * repeatedly refused, or escalated to a human, on files that were completely
 * benign, because the surrounding code pattern-matched to an attack. Sessions
 * died halfway. Nobody could tell which refusals were real.
 *
 * Keeping the shape clean fixed it. So this is a working-conditions gate as much
 * as a security one: the team stopped fighting their own tools. If you only care
 * about the first half, run with `--secrets-only`.
 */
export const name = "secrets";
export const title = "Secrets and dangerous shape";
export const summary =
  "Credentials, private keys, and code that reads like an attack even when it is not.";

const SECRET_RULES = [
  {
    rule: "secrets/private-key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
    message: "A private key is committed in this file.",
    fix: "Remove it, rotate the key, and load it from an environment variable or your host's secret store.",
  },
  {
    rule: "secrets/aws-access-key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    message: "An AWS access key id is hardcoded here.",
    fix: "Rotate it now, then read it from the environment.",
  },
  {
    rule: "secrets/github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    message: "A GitHub token is hardcoded here.",
    fix: "Revoke it, then use an Actions secret or the GITHUB_TOKEN the workflow already provides.",
  },
  {
    rule: "secrets/slack-token",
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
    message: "A Slack token is hardcoded here.",
    fix: "Revoke it and move it to your secret store.",
  },
  {
    rule: "secrets/stripe-key",
    re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/,
    message: "A live Stripe key is hardcoded here.",
    fix: "Roll the key immediately. Live keys never belong in a repo, even a private one.",
  },
  {
    rule: "secrets/openai-key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
    message: "What looks like an API key is hardcoded here.",
    fix: "Move it to an environment variable.",
  },
  {
    rule: "secrets/connection-string",
    // A URL with a real-looking inline password. Placeholders are excluded below.
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/i,
    message: "A database URL with an inline password is hardcoded here.",
    fix: "Read the whole URL from the environment. Do not split it into parts and rebuild it.",
  },
  {
    rule: "secrets/assigned-credential",
    // password = "literal". Deliberately narrow: assignment only, quoted only.
    re: /\b(?:password|passwd|secret|api_?key|access_?token|client_?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    message: "A credential is assigned a literal value here.",
    fix: "Read it from the environment. If this is test data, make it obviously fake.",
  },
];

const SHAPE_RULES = [
  {
    rule: "shape/pipe-to-shell",
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|)sh\b/,
    message: "This pipes something downloaded off the network straight into a shell.",
    fix: "Download to a file, check it into the repo or verify a checksum, then run it. Reviewers and agents both stop trusting a repo that does this.",
  },
  {
    rule: "shape/tls-disabled",
    re: /\b(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|curl\b[^\n]*\s-(?:k|-insecure)\b)/,
    message: "TLS certificate verification is switched off here.",
    fix: "Trust the real certificate. If a self-signed cert is genuinely required, pin that specific CA instead of disabling the check.",
  },
  {
    rule: "shape/host-key-bypass",
    re: /StrictHostKeyChecking[=\s]+no|UserKnownHostsFile[=\s]+\/dev\/null/,
    message: "SSH host-key checking is disabled here.",
    fix: "Put the host key in known_hosts as part of provisioning, and check against it.",
  },
  {
    rule: "shape/decoded-payload",
    re: /\b(?:base64\s+(?:-d|--decode)|atob\s*\()[^\n]{0,80}(?:eval|exec|\/etc\/|\/root\/|Function\s*\()/,
    message: "A decoded blob is executed or written somewhere privileged.",
    fix: "Store the content in a readable file. Nobody can review a base64 string, and tools will flag it forever.",
    severity: WARN,
  },
  {
    rule: "shape/chmod-777",
    re: /\bchmod\s+(?:-R\s+)?0?777\b/,
    message: "This makes a path world-writable.",
    fix: "Grant the narrowest mode that works, usually 755 for directories and 644 for files.",
    severity: WARN,
  },
];

/** Obvious non-secrets. Without these the gate cries wolf and gets switched off. */
const PLACEHOLDER =
  /\b(?:example|examples|sample|placeholder|dummy|fake|redacted|changeme|change_me|your[-_]?\w+|my[-_]?\w+|xxx+|test|TODO|FIXME|\.{3,}|<[^>]+>|\$\{[^}]+\}|process\.env|import\.meta\.env|os\.environ|None|null|undefined)\b/i;

/**
 * @param {{path: string, text: string}[]} files
 * @param {{secretsOnly?: boolean}} [opts]
 */
export function scan(files, opts = {}) {
  // Tag each rule with its family. The placeholder allowance below applies to
  // secret rules ONLY, and finding that out cost a real false negative:
  //
  //     curl https://get.example.com/install.sh | sh
  //
  // sailed straight through, because the line contains the word "example" and
  // the placeholder check assumed any line mentioning "example" was a doc
  // sample. For a SECRET that reasoning is right, since a fake key is harmless.
  // For a SHAPE rule it is exactly backwards: piping a download into a shell is
  // dangerous because of its form, and the host it points at is irrelevant.
  const rules = [
    ...SECRET_RULES.map((r) => ({ ...r, family: "secret" })),
    ...(opts.secretsOnly ? [] : SHAPE_RULES.map((r) => ({ ...r, family: "shape" }))),
  ];
  const out = [];

  for (const file of files) {
    // A gate that flags its own rule table is useless. Same for lockfiles,
    // which are full of hashes that look like tokens.
    if (isSelfOrNoise(file.path)) continue;

    const all = lines(file.text);
    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      if (line.length > 2000) continue; // minified bundle, not review material

      for (const r of rules) {
        if (!r.re.test(line)) continue;
        if (r.family === "secret" && PLACEHOLDER.test(line)) continue;
        if (acknowledged(all, i, "secrets")) continue;

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
      }
    }
  }
  return out;
}

function isSelfOrNoise(p) {
  const n = p.replace(/\\/g, "/");
  return (
    n.includes("gates/secrets.mjs") ||
    n.includes("gates/secrets.test.mjs") ||
    /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.min\.(?:js|css))$/.test(n) ||
    /(?:^|\/)(?:node_modules|dist|build|\.astro|\.git)\//.test(n)
  );
}
