import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  createDatabase,
  encryptSecret,
  nodeReachabilityState,
  nodes,
  nodeVpnEndpoints,
} from "@amnezia/db";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

// The shared test database is already migrated to HEAD, so only the
// migration's backfill statement is run again over seeded rows.
const [, backfill] = readFileSync(
  fileURLToPath(
    new URL("../../../packages/db/migrations/0068_node_state_address_based.sql", import.meta.url),
  ),
  "utf8",
).split("--> statement-breakpoint");

describe("0068_node_state_address_based", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const nodeIds: string[] = [];

  const clean = async () => {
    if (!database || nodeIds.length === 0) return;
    await database.db.delete(nodeVpnEndpoints).where(inArray(nodeVpnEndpoints.nodeId, nodeIds));
    await database.db.delete(nodeReachabilityState).where(inArray(nodeReachabilityState.nodeId, nodeIds));
    await database.db.delete(nodes).where(inArray(nodes.id, nodeIds));
    nodeIds.length = 0;
  };

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    if (database) await database.client.end();
  });

  const seedNode = async (endpoint: Partial<typeof nodeVpnEndpoints.$inferInsert>) => {
    if (!database) throw new Error("disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await database.db.insert(nodes).values({
      name: `backfill-node-${randomBytes(4).toString("hex")}`,
      apiBaseUrl: "http://192.0.2.40:4001",
      protocol: "awg3",
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
    await database.db.insert(nodeReachabilityState).values({
      nodeId: node.id, status: "ok", checkedAt: new Date(),
    });
    await database.db.insert(nodeVpnEndpoints).values({
      nodeId: node.id, ordinal: 1, address: "192.0.2.40", name: "Primary", ...endpoint,
    });
    return node.id;
  };

  runDatabaseTest("marks only nodes whose checked addresses already carry a verdict", async () => {
    if (!database || !backfill) throw new Error("backfill statement missing");
    const measured = await seedNode({ probeStatus: "ok", probeCheckedAt: new Date() });
    const waiting = await seedNode({ probeStatus: null });
    const unchecked = await seedNode({ probeStatus: "ok", reachabilityEnabled: false });
    await database.client.unsafe(backfill);

    const rows = await database.db.select().from(nodeReachabilityState)
      .where(inArray(nodeReachabilityState.nodeId, nodeIds));
    const marked = new Map(rows.map((row) => [row.nodeId, row.addressBased]));
    expect([marked.get(measured), marked.get(waiting), marked.get(unchecked)]).toEqual([true, false, false]);
  });
});
