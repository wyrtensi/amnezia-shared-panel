import { randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultKeyNameDisplay } from "@amnezia/contracts";
import {
  auditEvents,
  createDatabase,
  decryptSecret,
  encryptSecret,
  jobOutbox,
  nodes,
  portalPolicy,
  users,
  vpnKeys,
} from "@amnezia/db";
import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

describe("PostgresControlRepository quota race", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let actor: Actor;
  let nodeId: string;

  beforeAll(async () => {
    if (!database) return;
    await database.db.delete(jobOutbox);
    await database.db.delete(vpnKeys);
    await database.db.delete(nodes);
    await database.db.delete(portalPolicy);
    await database.db.delete(users);
    const [user] = await database.db
      .insert(users)
      .values({ email: "race@example.com" })
      .returning();
    if (!user) throw new Error("Failed to seed user");
    actor = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "user",
      status: "active",
    };
    await database.db
      .insert(portalPolicy)
      .values({ defaultKeyLimit: 5, allowedProtocols: ["awg2", "awg3"] });
    const labelSecret = randomBytes(32).toString("base64");
    const encryptedCredentials = encryptSecret("api-key", keyring, 1);
    const encryptedLabel = encryptSecret(labelSecret, keyring, 1);
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: "race-node",
        apiBaseUrl: "http://127.0.0.1:4001",
        credentialsCiphertext: encryptedCredentials.ciphertext,
        credentialsNonce: encryptedCredentials.nonce,
        credentialsAuthTag: encryptedCredentials.authTag,
        credentialsKeyVersion: encryptedCredentials.keyVersion,
        labelSecretCiphertext: encryptedLabel.ciphertext,
        labelSecretNonce: encryptedLabel.nonce,
        labelSecretAuthTag: encryptedLabel.authTag,
        labelSecretKeyVersion: encryptedLabel.keyVersion,
      })
      .returning();
    if (!node) throw new Error("Failed to seed node");
    nodeId = node.id;
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  runDatabaseTest("creates exactly five keys from ten concurrent requests", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        repository.createProvisioningKey(actor, {
          nodeId,
          protocol: "awg2",
          deviceType: "other",
          deviceLabel: `race-${index}`,
          routeProfile: "full_tunnel",
          nameDisplay: defaultKeyNameDisplay,
        }),
      ),
    );

    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => {
        const reason = result.reason as {
          code?: unknown;
          cause?: { code?: unknown };
          message?: unknown;
        };
        return {
          code: reason.code,
          causeCode: reason.cause?.code,
          message: reason.message,
        };
      });
    expect(
      results.filter((result) => result.status === "fulfilled"),
      JSON.stringify(failures),
    ).toHaveLength(5);
    const [keyCount] = await database.db
      .select({ value: count() })
      .from(vpnKeys)
      .where(eq(vpnKeys.ownerId, actor.id));
    const [jobCount] = await database.db
      .select({ value: count() })
      .from(jobOutbox);
    expect(keyCount?.value).toBe(5);
    expect(jobCount?.value).toBe(5);
  });

  runDatabaseTest(
    "creates an awg3 key on a node whose capabilities advertise awg3",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });

      const [capUser] = await database.db
        .insert(users)
        .values({ email: "cap@example.com" })
        .returning();
      if (!capUser) throw new Error("Failed to seed capability user");
      const capActor: Actor = {
        id: capUser.id,
        email: capUser.email,
        displayName: null,
        role: "user",
        status: "active",
      };

      const credentials = encryptSecret("api-key", keyring, 1);
      const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
      // Node's primary protocol is awg2, but it reports awg3 in capabilities.
      const [capNode] = await database.db
        .insert(nodes)
        .values({
          name: "cap-node",
          apiBaseUrl: "http://127.0.0.1:4002",
          protocol: "awg2",
          capabilities: { awg2: true, awg3: true },
          credentialsCiphertext: credentials.ciphertext,
          credentialsNonce: credentials.nonce,
          credentialsAuthTag: credentials.authTag,
          credentialsKeyVersion: credentials.keyVersion,
          labelSecretCiphertext: label.ciphertext,
          labelSecretNonce: label.nonce,
          labelSecretAuthTag: label.authTag,
          labelSecretKeyVersion: label.keyVersion,
        })
        .returning();
      if (!capNode) throw new Error("Failed to seed capability node");

      const key = (await repository.createProvisioningKey(capActor, {
        nodeId: capNode.id,
        protocol: "awg3",
        deviceType: "other",
        deviceLabel: "awg3-device",
        routeProfile: "full_tunnel",
        nameDisplay: defaultKeyNameDisplay,
      })) as { id: string; state: string };

      expect(key.state).toBe("provisioning");
      const [stored] = await database.db
        .select({ protocol: vpnKeys.protocol, nodeId: vpnKeys.nodeId })
        .from(vpnKeys)
        .where(eq(vpnKeys.id, key.id));
      expect(stored?.protocol).toBe("awg3");
      expect(stored?.nodeId).toBe(capNode.id);
    },
  );

  runDatabaseTest("promotes only an explicitly allowlisted bootstrap admin", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
      bootstrapAdminEmails: new Set([actor.email]),
    });

    const resolved = await repository.resolveIdentity({
      provider: "dev",
      subject: actor.email,
      email: actor.email,
    });

    expect(resolved.role).toBe("admin");
  });

  runDatabaseTest("encrypts node credentials and audits registration", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
      activeKeyVersion: 1,
    });
    const admin: Actor = { ...actor, role: "admin" };
    const apiKey = "node-api-key".padEnd(32, "x");

    const created = (await repository.createNode(admin, {
      name: "registered-node",
      apiBaseUrl: "http://127.0.0.1:4001/",
      apiKey,
      enabled: true,
      protocol: "awg2",
      maxPeers: 500,
      capabilities: { peerLifecycle: true },
    })) as { id: string; apiBaseUrl: string; apiKey?: string };

    expect(created.apiBaseUrl).toBe("http://127.0.0.1:4001");
    expect(created.apiKey).toBeUndefined();
    const [stored] = await database.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, created.id));
    if (!stored) throw new Error("Registered node was not persisted");
    expect(
      decryptSecret(
        {
          ciphertext: stored.credentialsCiphertext,
          nonce: stored.credentialsNonce,
          authTag: stored.credentialsAuthTag,
          keyVersion: stored.credentialsKeyVersion,
        },
        keyring,
      ),
    ).toBe(apiKey);
    const events = await database.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, created.id));
    expect(events).toEqual([{ action: "node.created" }]);
  });

  runDatabaseTest("deduplicates retries but allows later lifecycle cycles", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
    });
    const admin: Actor = { ...actor, role: "admin" };
    const [key] = await database.db
      .select({ id: vpnKeys.id })
      .from(vpnKeys)
      .where(eq(vpnKeys.ownerId, actor.id))
      .limit(1);
    if (!key) throw new Error("Expected a seeded key");

    await database.db.delete(jobOutbox);
    await database.db
      .update(vpnKeys)
      .set({ state: "active" })
      .where(eq(vpnKeys.id, key.id));

    await repository.adminAction(admin, "keys", key.id, "disable", {});
    await repository.adminAction(admin, "keys", key.id, "disable", {});
    await database.db
      .update(jobOutbox)
      .set({ status: "completed" })
      .where(eq(jobOutbox.type, "vpn-key.disable"));
    await repository.adminAction(admin, "keys", key.id, "enable", {});
    await database.db
      .update(jobOutbox)
      .set({ status: "completed" })
      .where(eq(jobOutbox.type, "vpn-key.enable"));
    await repository.adminAction(admin, "keys", key.id, "disable", {});

    const jobs = await database.db
      .select({ type: jobOutbox.type })
      .from(jobOutbox);
    expect(jobs.map(({ type }) => type)).toEqual([
      "vpn-key.disable",
      "vpn-key.enable",
      "vpn-key.disable",
    ]);

    await database.db
      .update(vpnKeys)
      .set({ state: "revoked" })
      .where(eq(vpnKeys.id, key.id));
    await expect(
      repository.adminAction(admin, "keys", key.id, "enable", {}),
    ).rejects.toMatchObject({ code: "INVALID_KEY_TRANSITION" });
  });
});
