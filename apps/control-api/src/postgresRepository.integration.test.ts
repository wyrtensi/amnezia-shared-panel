import { randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
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
  quotaRequests,
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

  /** A node with no keys, so `deleteNode` can remove it. */
  const seedNode = async (name: string): Promise<string> => {
    if (!database) throw new Error("No database");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await database.db
      .insert(nodes)
      .values({
        name,
        publicName: `${name} (public)`,
        apiBaseUrl: `http://127.0.0.1:4001/${name}`,
        credentialsCiphertext: credentials.ciphertext,
        credentialsNonce: credentials.nonce,
        credentialsAuthTag: credentials.authTag,
        credentialsKeyVersion: credentials.keyVersion,
        labelSecretCiphertext: label.ciphertext,
        labelSecretNonce: label.nonce,
        labelSecretAuthTag: label.authTag,
        labelSecretKeyVersion: label.keyVersion,
      })
      .returning({ id: nodes.id });
    if (!node) throw new Error("Failed to seed node");
    return node.id;
  };

  const seedQuotaUser = async (
    email: string,
    values: {
      keyLimitOverride?: number | null;
      nodeKeyLimits?: Record<string, number> | null;
      allowedNodeIds?: string[] | null;
    } = {},
  ): Promise<Actor> => {
    if (!database) throw new Error("No database");
    const [user] = await database.db
      .insert(users)
      .values({
        email,
        keyLimitOverride: values.keyLimitOverride ?? null,
        nodeKeyLimits: values.nodeKeyLimits ?? null,
        policyOverride:
          values.allowedNodeIds === undefined
            ? null
            : { allowedNodeIds: values.allowedNodeIds },
      })
      .returning();
    if (!user) throw new Error("Failed to seed quota user");
    return {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "user",
      status: "active",
    };
  };

  runDatabaseTest(
    "approving a per-server request raises that server only",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const targetNode = await seedNode("quota-target");
      const owner = await seedQuotaUser("per-node@example.com", {
        keyLimitOverride: 4,
        // An explicit per-node limit that used to beat the flat override and
        // made approvals a no-op on exactly the server that ran out of room.
        nodeKeyLimits: { [targetNode]: 1 },
      });

      const created = await repository.createQuotaRequest(owner, {
        requestedLimit: 7,
        nodeId: targetNode,
      });
      await repository.adminAction(
        admin,
        "quota-requests",
        created.id,
        "approve",
        {},
      );

      const [updated] = await database.db
        .select({
          keyLimitOverride: users.keyLimitOverride,
          nodeKeyLimits: users.nodeKeyLimits,
        })
        .from(users)
        .where(eq(users.id, owner.id));
      expect(updated?.nodeKeyLimits).toEqual({ [targetNode]: 7 });
      // The flat override is untouched, so every other server keeps its limit.
      expect(updated?.keyLimitOverride).toBe(4);
    },
  );

  runDatabaseTest(
    "approving an every-server request clears shadowing per-node limits",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const nodeA = await seedNode("quota-all-a");
      const owner = await seedQuotaUser("every-node@example.com", {
        keyLimitOverride: 2,
        nodeKeyLimits: { [nodeA]: 1 },
      });

      const created = await repository.createQuotaRequest(owner, {
        requestedLimit: 9,
      });
      await repository.adminAction(
        admin,
        "quota-requests",
        created.id,
        "approve",
        {},
      );

      const [updated] = await database.db
        .select({
          keyLimitOverride: users.keyLimitOverride,
          nodeKeyLimits: users.nodeKeyLimits,
        })
        .from(users)
        .where(eq(users.id, owner.id));
      expect(updated?.keyLimitOverride).toBe(9);
      // Approval outranks the earlier per-node values, which would otherwise
      // keep overriding the grant on the servers the admin just said yes to.
      expect(updated?.nodeKeyLimits).toBeNull();
      const [event] = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, created.id));
      expect(event?.metadata).toMatchObject({ clearedNodeLimitCount: 1 });
    },
  );

  runDatabaseTest(
    "refuses a request for a server the user may not use",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const allowedNode = await seedNode("quota-allowed");
      const forbiddenNode = await seedNode("quota-forbidden");
      const owner = await seedQuotaUser("restricted@example.com", {
        allowedNodeIds: [allowedNode],
      });

      await expect(
        repository.createQuotaRequest(owner, {
          requestedLimit: 3,
          nodeId: forbiddenNode,
        }),
      ).rejects.toMatchObject({ code: "NODE_NOT_ALLOWED", statusCode: 403 });
      await expect(
        repository.createQuotaRequest(owner, {
          requestedLimit: 3,
          nodeId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({ code: "NODE_NOT_FOUND", statusCode: 400 });
      const [pending] = await database.db
        .select({ value: count() })
        .from(quotaRequests)
        .where(eq(quotaRequests.userId, owner.id));
      expect(pending?.value).toBe(0);
    },
  );

  runDatabaseTest(
    "cancels pending requests aimed at a removed server",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const doomedNode = await seedNode("quota-doomed");
      const owner = await seedQuotaUser("doomed-node@example.com");
      const created = await repository.createQuotaRequest(owner, {
        requestedLimit: 6,
        nodeId: doomedNode,
      });

      await repository.deleteNode(admin, doomedNode);

      const [request] = await database.db
        .select({
          status: quotaRequests.status,
          nodeId: quotaRequests.nodeId,
          reviewNote: quotaRequests.reviewNote,
        })
        .from(quotaRequests)
        .where(eq(quotaRequests.id, created.id));
      // Without this the ON DELETE SET NULL would silently turn a per-server
      // ask into an every-server one.
      expect(request?.status).toBe("cancelled");
      expect(request?.reviewNote).toBe("target server was removed");
      expect(request?.nodeId).toBeNull();
    },
  );

  runDatabaseTest(
    "keeps one rule refresh in flight and re-arms a finished one",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      await database.db
        .delete(jobOutbox)
        .where(eq(jobOutbox.deduplicationKey, "rules.refresh"));

      const first = await repository.adminAction(
        admin,
        "rules",
        "global",
        "refresh",
        {},
      );
      const second = await repository.adminAction(
        admin,
        "rules",
        "global",
        "refresh",
        {},
      );
      expect(first).toMatchObject({ status: "pending" });
      // A second click while one run is in flight must not queue another.
      expect(second).toMatchObject({
        status: "pending",
        queuedAt: (first as { queuedAt: string }).queuedAt,
      });
      const [queued] = await database.db
        .select({ value: count() })
        .from(jobOutbox)
        .where(eq(jobOutbox.deduplicationKey, "rules.refresh"));
      expect(queued?.value).toBe(1);

      // The completed row still holds the unique key, so the next ask has to
      // reuse it rather than insert a duplicate.
      await database.db
        .update(jobOutbox)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(jobOutbox.deduplicationKey, "rules.refresh"));
      const rearmed = await repository.adminAction(
        admin,
        "rules",
        "global",
        "refresh",
        {},
      );
      expect(rearmed).toMatchObject({ status: "pending", completedAt: null });
      const [afterRearm] = await database.db
        .select({ value: count() })
        .from(jobOutbox)
        .where(eq(jobOutbox.deduplicationKey, "rules.refresh"));
      expect(afterRearm?.value).toBe(1);
      expect(await repository.getRulesRefreshStatus()).toMatchObject({
        status: "pending",
      });
      const [audits] = await database.db
        .select({ value: count() })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "admin.rules.refresh"),
            eq(auditEvents.targetType, "rules"),
          ),
        );
      expect(audits?.value).toBe(3);
    },
  );

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
