import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  createDatabase,
  encryptSecret,
  nodes,
  reachabilityProbe,
  users,
  vpnKeys,
} from "@amnezia/db";
import { awgClientProfileV1Schema } from "@amnezia/vpn-config";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

// The shared test database is already migrated to HEAD, so the migration's
// statement is run again over rows seeded the way old panels left them.
const migration = readFileSync(
  fileURLToPath(
    new URL("../../../packages/db/migrations/0066_probe_key_client_profiles.sql", import.meta.url),
  ),
  "utf8",
);

describe("0066_probe_key_client_profiles", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const userIds: string[] = [];
  const nodeIds: string[] = [];

  const clean = async () => {
    if (!database) return;
    await database.db.delete(reachabilityProbe);
    if (nodeIds.length > 0) {
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.nodeId, nodeIds));
      await database.db.delete(nodes).where(inArray(nodes.id, nodeIds));
    }
    if (userIds.length > 0) await database.db.delete(users).where(inArray(users.id, userIds));
    nodeIds.length = 0;
    userIds.length = 0;
  };

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    if (database) await database.client.end();
  });

  const seed = async (probeKeys: number) => {
    if (!database) throw new Error("disabled");
    const [service, person] = await database.db.insert(users).values([
      { email: `probe-${randomBytes(4).toString("hex")}@service.invalid`, serviceAccount: true },
      { email: `person-${randomBytes(4).toString("hex")}@example.com` },
    ]).returning();
    if (!service || !person) throw new Error("seed failed");
    userIds.push(service.id, person.id);
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await database.db.insert(nodes).values({
      name: `migration-node-${randomBytes(4).toString("hex")}`,
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
    const key = (
      ownerId: string,
      protocol: "awg2" | "awg3",
      state: "active" | "revoked",
      awgClientProfile: Record<string, unknown> | null = null,
    ) => ({
      ownerId,
      nodeId: node.id,
      nodeLabel: `migration_${randomBytes(6).toString("hex")}`,
      protocol,
      state,
      routeProfile: "full_tunnel" as const,
      awgClientProfile,
    });
    const kept = { version: 1, revision: 4, jc: 5, jmin: 50, jmax: 120, cpsOrder: 2 };
    const legacy = await database.db.insert(vpnKeys).values(
      Array.from({ length: probeKeys }, () => key(service.id, "awg3", "active")),
    ).returning({ id: vpnKeys.id });
    const [revoked, awg2, personal, profiled] = await database.db.insert(vpnKeys).values([
      key(service.id, "awg3", "revoked"),
      key(service.id, "awg2", "active"),
      key(person.id, "awg3", "active"),
      key(service.id, "awg3", "active", kept),
    ]).returning({ id: vpnKeys.id });
    if (!revoked || !awg2 || !personal || !profiled) throw new Error("seed failed");
    const probeCredentials = encryptSecret("probe-api-key", keyring, 1);
    await database.db.insert(reachabilityProbe).values({
      label: "Vantage",
      apiBaseUrl: "http://probe.test",
      credentialsCiphertext: probeCredentials.ciphertext,
      credentialsNonce: probeCredentials.nonce,
      credentialsAuthTag: probeCredentials.authTag,
      credentialsKeyVersion: probeCredentials.keyVersion,
      controlUrl: "https://example.com/",
    });
    return { legacy: legacy.map(({ id }) => id), revoked, awg2, personal, profiled, kept };
  };

  const profileOf = async (id: string) => {
    if (!database) throw new Error("disabled");
    const [row] = await database.db.select({ profile: vpnKeys.awgClientProfile }).from(vpnKeys)
      .where(eq(vpnKeys.id, id));
    return row?.profile ?? null;
  };
  const requestedAt = async () => {
    if (!database) throw new Error("disabled");
    const [probe] = await database.db.select({ at: reachabilityProbe.runRequestedAt }).from(reachabilityProbe);
    return probe?.at ?? null;
  };

  runDatabaseTest("gives every live AWG 3 probe key a valid profile and queues a run", async () => {
    if (!database) return;
    const seeded = await seed(120);
    await database.client.unsafe(migration);

    const drawn = await Promise.all(seeded.legacy.map(profileOf));
    for (const profile of drawn) {
      expect(awgClientProfileV1Schema.parse(profile)).toMatchObject({ version: 1, revision: 1 });
    }
    // Drawn per key, not one value for all of them.
    expect(new Set(drawn.map((profile) => JSON.stringify(profile))).size).toBeGreaterThan(1);
    expect(await profileOf(seeded.revoked.id)).toBeNull();
    expect(await profileOf(seeded.awg2.id)).toBeNull();
    expect(await profileOf(seeded.personal.id)).toBeNull();
    expect(await profileOf(seeded.profiled.id)).toEqual(seeded.kept);
    expect(await requestedAt()).not.toBeNull();
  });

  runDatabaseTest("changes nothing and queues nothing when run again", async () => {
    if (!database) return;
    const seeded = await seed(3);
    await database.client.unsafe(migration);
    const first = await Promise.all(seeded.legacy.map(profileOf));
    await database.db.update(reachabilityProbe).set({ runRequestedAt: null });

    await database.client.unsafe(migration);
    expect(await Promise.all(seeded.legacy.map(profileOf))).toEqual(first);
    expect(await requestedAt()).toBeNull();
  });
});
