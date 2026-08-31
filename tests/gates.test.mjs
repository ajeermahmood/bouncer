import { describe, it, expect } from "vitest";
import * as secrets from "../gates/secrets.mjs";
import * as scope from "../gates/scope.mjs";
import * as money from "../gates/money.mjs";
import * as migration from "../gates/migration-safety.mjs";
import * as docLinks from "../gates/doc-links.mjs";

/**
 * Half of these tests assert that a gate stays QUIET.
 *
 * That is deliberate, and it is the half that matters. A gate is easy to write so
 * that it catches the bad case; the hard part is not firing on the twenty
 * near-misses around it. Every false positive spends a developer's attention, and
 * a gate that spends more attention than it saves gets switched off within a
 * month. Then it protects nothing, while still appearing in the workflow file and
 * making everyone feel covered.
 *
 * So: for each rule, one test that it fires, and at least one that it does not.
 */

const at = (path, text) => [{ path, text }];
const rules = (findings) => findings.map((f) => f.rule);

describe("secrets", () => {
  it("catches a private key", () => {
    const f = secrets.scan(at("k.ts", "-----BEGIN RSA PRIVATE KEY-----"));
    expect(rules(f)).toContain("secrets/private-key");
  });

  it("catches an assigned credential and a live Stripe key", () => {
    const f = secrets.scan(
      at("c.ts", ['const password = "hunter2hunter2";', 'const k = "sk_live_abcdefghij1234567890";'].join("\n"))
    );
    expect(rules(f)).toContain("secrets/assigned-credential");
    expect(rules(f)).toContain("secrets/stripe-key");
  });

  it("stays quiet on env reads and obvious placeholders", () => {
    const text = [
      "const password = process.env.DB_PASSWORD;",
      'const apiKey = "your-api-key-here";',
      'const secret = "changeme";',
      'const token = "<REPLACE_ME>";',
      "const pw = import.meta.env.PW;",
    ].join("\n");
    expect(secrets.scan(at("ok.ts", text))).toHaveLength(0);
  });

  it("flags dangerous shape even when the host is an example, which secrets alone would excuse", () => {
    // The regression this pins: the placeholder allowance used to apply to every
    // rule, so any line containing the word "example" was skipped. A pipe-to-shell
    // is dangerous because of its form, not because of where it points.
    const f = secrets.scan(at("d.sh", "curl https://get.example.com/install.sh | sh"));
    expect(rules(f)).toContain("shape/pipe-to-shell");
  });

  it("catches disabled TLS and host-key bypass", () => {
    const text = ["fetch(u, { rejectUnauthorized: false });", "ssh -o StrictHostKeyChecking=no host"].join("\n");
    expect(rules(secrets.scan(at("s.sh", text)))).toEqual(
      expect.arrayContaining(["shape/tls-disabled", "shape/host-key-bypass"])
    );
  });

  it("honours an acknowledgement that carries a reason", () => {
    const text = 'const db = "postgres://u:realpw12345@h/d"; // bouncer-ok(secrets): fixture for the test suite';
    expect(secrets.scan(at("t.ts", text))).toHaveLength(0);
  });

  it("ignores a bare acknowledgement with no reason", () => {
    const text = 'const db = "postgres://u:realpw12345@h/d"; // bouncer-ok(secrets):';
    expect(secrets.scan(at("t.ts", text))).toHaveLength(1);
  });

  it("never puts the matched text into the finding", () => {
    const leak = "sk_live_abcdefghij1234567890";
    const f = secrets.scan(at("k.ts", `const k = "${leak}";`));
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain(leak);
  });
});

describe("scope", () => {
  const cfg = {
    models: ["order", "customer"],
    tables: ["orders"],
    column: "tenantId",
    rawAccessor: "raw",
  };

  it("catches the raw client, an alias of it, and unscoped raw SQL", () => {
    const text = [
      "const a = await db.raw.order.findMany();",
      "const c = db.raw;",
      "const d = await c.customer.findMany();",
      "await db.$queryRaw(`SELECT * FROM orders`);",
    ].join("\n");
    expect(rules(scope.scan(at("s.ts", text), cfg))).toEqual([
      "scope/raw-client",
      "scope/raw-alias",
      "scope/raw-sql",
    ]);
  });

  it("stays quiet on the scoped client and on scoped SQL", () => {
    const text = [
      "const a = await db.forTenant(id).order.findMany();",
      "await db.$queryRaw(`SELECT * FROM orders WHERE tenantId = $1`, id);",
      "const x = await db.raw.auditLog.findMany();",
    ].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });

  it("does not let the next statement launder the previous one", () => {
    // The window used to run a fixed number of lines forward, so the scoped
    // query below cleared the unscoped one above it. That failed open, which is
    // the only direction that actually hurts.
    const text = [
      "await db.$queryRaw(`SELECT * FROM orders WHERE id = 1`);",
      "await db.$queryRaw(`SELECT * FROM orders WHERE tenantId = $1`, id);",
    ].join("\n");
    const f = scope.scan(at("s.ts", text), cfg);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(1);
  });

  it("does not flag its own documentation", () => {
    const text = [" * Example of the bad pattern:", " *     db.raw.order.findMany()", "const ok = 1;"].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });

  it("does nothing at all when no models are configured", () => {
    const text = "const a = await db.raw.order.findMany();";
    expect(scope.scan(at("s.ts", text), {})).toHaveLength(0);
  });
});

describe("money", () => {
  it("catches float conversion to minor units", () => {
    const f = money.scan(at("m.ts", "const minor = Math.round(parseFloat(input) * 100);"));
    expect(rules(f)).toContain("money/float-to-minor");
  });

  it("catches a hardcoded exponent on a currency value", () => {
    const f = money.scan(at("m.ts", "const display = totalAmount / 100;"));
    expect(rules(f)).toContain("money/hardcoded-exponent");
  });

  it("stays quiet on integer minor units and on non-money maths", () => {
    const text = [
      "const minor = decimalToMinor(input, currency);",
      "const pct = (score / 100) * weight;",
      "const total = lineItems.reduce((a, b) => a + b.amountMinor, 0);",
    ].join("\n");
    expect(money.scan(at("m.ts", text))).toHaveLength(0);
  });

  it("does not flag a comment that describes the bug", () => {
    const text = "// never write Math.round(parseFloat(x) * 100), it rounds 10.005 down";
    expect(money.scan(at("m.ts", text))).toHaveLength(0);
  });
});

describe("migration-safety", () => {
  it("catches the four statements that break the previous app version", () => {
    const f = migration.scan(
      at("001.sql", [
        "ALTER TABLE orders DROP COLUMN legacy_ref;",
        "ALTER TABLE orders RENAME COLUMN total TO total_minor;",
        "ALTER TABLE orders ADD COLUMN currency VARCHAR(3) NOT NULL;",
        "DROP TABLE old_carts;",
      ].join("\n"))
    );
    expect(rules(f)).toEqual(
      expect.arrayContaining([
        "migration/drop-column",
        "migration/rename",
        "migration/add-not-null",
        "migration/drop-table",
      ])
    );
  });

  it("allows an added column that is nullable, or has a default", () => {
    const text = [
      "ALTER TABLE orders ADD COLUMN note TEXT;",
      "ALTER TABLE orders ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'EUR';",
    ].join("\n");
    expect(migration.scan(at("002.sql", text))).toHaveLength(0);
  });

  it("warns about a non-concurrent index but does not block on it", () => {
    const f = migration.scan(at("003.sql", "CREATE INDEX idx_orders_tenant ON orders (tenant_id);"));
    expect(f[0].rule).toBe("migration/blocking-index");
    expect(f[0].severity).toBe("warn");
  });

  it("respects a file-level acknowledgement", () => {
    const text = ["-- bouncer-ok(migration): add_referrals never reached production", "DROP TABLE referrals;"].join("\n");
    expect(migration.scan(at("004.sql", text))).toHaveLength(0);
  });
});

describe("doc-links", () => {
  const repo = ["README.md", "docs/guide.md", "docs/img/x.png", "gates/scope.mjs"];

  it("catches a relative link to a file that does not exist", () => {
    const f = docLinks.scan(at("README.md", "See [the guide](docs/missing.md)."), repo);
    expect(rules(f)).toEqual(["doc-links/broken"]);
  });

  it("resolves links relative to the file, including parent traversal", () => {
    const text = "[up](../README.md) and [sibling](guide.md) and [dir](img/)";
    expect(docLinks.scan(at("docs/other.md", text), repo)).toHaveLength(0);
  });

  it("ignores external links, anchors, and images", () => {
    const text = [
      "[site](https://example.com)",
      "[mail](mailto:a@b.c)",
      "[anchor](#section)",
      "![pic](docs/img/x.png)",
      "[with anchor](docs/guide.md#setup)",
    ].join("\n");
    expect(docLinks.scan(at("README.md", text), repo)).toHaveLength(0);
  });
});
