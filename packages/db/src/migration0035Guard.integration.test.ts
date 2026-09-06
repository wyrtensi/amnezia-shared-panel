import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.js";

/**
 * Exercises migration 0035's guard through drizzle's REAL migrator against a
 * real database, rather than only reading the SQL as text (see
 * `migrations.test.ts` for that half of the coverage). This is the one
 * migration in the folder that must never run past a stuck key, so the plan
 * asked for it to be proven, not just asserted on statically.
 *
 * Why this cannot run against the shared `TEST_DATABASE_URL`: that database is
 * migrated all the way to HEAD before the test suite runs (see
 * `.github/workflows/ci.yml`), so its `route_profile` enum no longer contains
 * `'ru_whitelist'` by the time any test executes. A row using that value
 * cannot even be inserted there, and the guard's own query would fail on the
 * enum cast rather than exercising the guard's logic. So this test builds its
 * own throwaway database on the same server: migrates it to `0034` only
 * (`route_profile` still has three values there), inserts a key on the
 * profile being removed, then runs the real migrations folder — including
 * `0035` — and asserts it refuses.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

describe("0035_drop_whitelist_profile guard", () => {
  const tempDbName = `amnezia_migration_guard_${randomUUID().replace(/-/g, "")}`;
  let admin: ReturnType<typeof createDatabase> | null = null;
  let tempDbUrl = "";
  let tempMigrationsDir = "";

  beforeAll(async () => {
    if (!databaseUrl) return;
    admin = createDatabase(databaseUrl);
    await admin.client.unsafe(`CREATE DATABASE "${tempDbName}"`);

    const url = new URL(databaseUrl);
    url.pathname = `/${tempDbName}`;
    tempDbUrl = url.toString();

    // A migrations folder holding only what the real journal calls 0000..0034,
    // so migrating it stops one migration short of the one under test.
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const priorEntries = journal.entries.filter(
      (entry) => entry.tag !== "0035_drop_whitelist_profile",
    );

    tempMigrationsDir = mkdtempSync(join(tmpdir(), "amnezia-migration-guard-"));
    const fs = await import("node:fs");
    fs.mkdirSync(join(tempMigrationsDir, "meta"), { recursive: true });
    writeFileSync(
      join(tempMigrationsDir, "meta/_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries: priorEntries }),
    );
    for (const entry of priorEntries) {
      fs.copyFileSync(
        join(migrationsDir, `${entry.tag}.sql`),
        join(tempMigrationsDir, `${entry.tag}.sql`),
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (!admin) return;
    rmSync(tempMigrationsDir, { recursive: true, force: true });
    // FORCE disconnects any lingering session from the guard test itself
    // before dropping — DROP DATABASE otherwise refuses while a client is
    // still attached.
    await admin.client.unsafe(
      `DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`,
    );
    await admin.client.end();
  }, 30_000);

  runDatabaseTest(
    "refuses to run past a vpn_keys row still on the removed profile",
    async () => {
      const target = createDatabase(tempDbUrl);
      try {
        // Bring the throwaway database to exactly the state every real
        // deployment is in right before this migration: everything up to
        // 0034 applied, route_profile still carrying ru_whitelist.
        await migrate(target.db, { migrationsFolder: tempMigrationsDir });

        const [user] = await target.client<{ id: string }[]>`
          INSERT INTO users (email) VALUES ('guard-test@example.invalid')
          RETURNING id
        `;
        const [node] = await target.client<{ id: string }[]>`
          INSERT INTO nodes (
            name, api_base_url,
            credentials_ciphertext, credentials_nonce, credentials_auth_tag, credentials_key_version,
            label_secret_ciphertext, label_secret_nonce, label_secret_auth_tag, label_secret_key_version
          ) VALUES (
            'guard-test-node', 'https://node.example.invalid',
            'x', 'x', 'x', 1,
            'x', 'x', 'x', 1
          )
          RETURNING id
        `;
        if (!user || !node) throw new Error("failed to seed guard-test fixtures");
        await target.client`
          INSERT INTO vpn_keys (owner_id, node_id, node_label, protocol, route_profile)
          VALUES (${user.id}, ${node.id}, 'guard-test-key', 'awg2', 'ru_whitelist')
        `;

        // The real migrations folder, 0035 included: applying it now must
        // refuse rather than strand the peer this row still points at.
        // The driver wraps the database error as `.cause` behind a generic
        // "Failed query" message, so the guard's own text is asserted there.
        const failure = await migrate(target.db, {
          migrationsFolder: migrationsDir,
        }).then(
          () => null,
          (error: unknown) => error as { cause?: { message?: string } },
        );
        expect(failure?.cause?.message).toMatch(
          /ru_whitelist is being removed but 1 vpn_keys still use it/,
        );

        // Refusing must mean refusing entirely: the row the guard complained
        // about is still exactly as it was, not partially migrated.
        const [key] = await target.client<{ route_profile: string }[]>`
          SELECT route_profile FROM vpn_keys WHERE node_label = 'guard-test-key'
        `;
        expect(key?.route_profile).toBe("ru_whitelist");
      } finally {
        await target.client.end();
      }
    },
    30_000,
  );

  runDatabaseTest(
    "runs clean once no key uses the removed profile",
    async () => {
      const target = createDatabase(tempDbUrl);
      try {
        // The guard test above may have already brought this database to
        // 0034 and left a row behind (its own migration attempt rolled back,
        // so 0035 never actually applied). Either way, clear the profile off
        // any surviving row so this path exercises the success case cleanly.
        await migrate(target.db, { migrationsFolder: tempMigrationsDir });
        await target.client.unsafe(
          `UPDATE vpn_keys SET route_profile = 'ru_blacklist' WHERE route_profile = 'ru_whitelist'`,
        );

        await migrate(target.db, { migrationsFolder: migrationsDir });

        const [row] = await target.client<{ typname_exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'route_profile' AND e.enumlabel = 'ru_whitelist'
          ) AS typname_exists
        `;
        expect(row?.typname_exists).toBe(false);
      } finally {
        await target.client.end();
      }
    },
    30_000,
  );
});
