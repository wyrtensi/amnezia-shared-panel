import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { awgGeneratorPresets } from "@amnezia/contracts";
import { createDatabase, encryptSecret, nodes, nodeVpnEndpoints } from "@amnezia/db";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

// The shared test database is already migrated to HEAD, so only the
// migration's backfill statements are run again over seeded rows.
const backfill = readFileSync(
  fileURLToPath(new URL("../../../packages/db/migrations/0069_awg_client_settings.sql", import.meta.url)),
  "utf8",
).split("--> statement-breakpoint").filter((statement) => /^\s*(--.*\n\s*)*UPDATE/m.test(statement));

describe("0069_awg_client_settings", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const nodeIds: string[] = [];
  const stun = awgGeneratorPresets().find(({ id }) => id === "stun")!.settings;

  const clean = async () => {
    if (!database || nodeIds.length === 0) return;
    await database.db.delete(nodeVpnEndpoints).where(inArray(nodeVpnEndpoints.nodeId, nodeIds));
    await database.db.delete(nodes).where(inArray(nodes.id, nodeIds));
    nodeIds.length = 0;
  };

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    if (database) await database.client.end();
  });

  const seedNode = async (awgGenerator: typeof stun | null) => {
    if (!database) throw new Error("disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await database.db.insert(nodes).values({
      name: `mtu-node-${randomBytes(4).toString("hex")}`,
      apiBaseUrl: "http://192.0.2.40:4001",
      protocol: "awg3",
      awgGenerator,
      credentialsCiphertext: credentials.ciphertext,
      credentialsNonce: credentials.nonce,
      credentialsAuthTag: credentials.authTag,
      credentialsKeyVersion: credentials.keyVersion,
      labelSecretCiphertext: label.ciphertext,
      labelSecretNonce: label.nonce,
      labelSecretAuthTag: label.authTag,
      labelSecretKeyVersion: label.keyVersion,
    }).returning();
    if (!node) throw new Error("seed failed");
    nodeIds.push(node.id);
    return node.id;
  };

  runDatabaseTest("gives every node and address with a saved profile its profile's MTU", async () => {
    if (!database) throw new Error("disabled");
    expect(backfill).toHaveLength(2);
    const profiled = await seedNode({ ...stun, mtu: 1400 });
    const bare = await seedNode(null);
    const [own, inherits] = await database.db.insert(nodeVpnEndpoints).values([
      { nodeId: profiled, ordinal: 1, address: "192.0.2.41", name: "Own", awgGenerator: { ...stun, mtu: 1280 } },
      { nodeId: profiled, ordinal: 2, address: "192.0.2.42", name: "Inherits" },
    ]).returning();
    if (!own || !inherits) throw new Error("seed failed");
    for (const statement of backfill) await database.client.unsafe(statement);

    const mtuOf = async (id: string) =>
      (await database.db.select({ mtu: nodes.awgMtu }).from(nodes).where(eq(nodes.id, id)))[0]?.mtu;
    const endpointMtu = async (id: string) =>
      (await database.db.select({ mtu: nodeVpnEndpoints.awgMtu }).from(nodeVpnEndpoints)
        .where(eq(nodeVpnEndpoints.id, id)))[0]?.mtu;
    expect([await mtuOf(profiled), await mtuOf(bare)]).toEqual([1400, null]);
    expect([await endpointMtu(own.id), await endpointMtu(inherits.id)]).toEqual([1280, null]);
  });
});
