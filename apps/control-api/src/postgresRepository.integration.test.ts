import { randomBytes } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultKeyNameDisplay, idleAccessSyncStatus } from "@amnezia/contracts";
import type { KeyLimitMode } from "@amnezia/contracts";
import {
  auditEvents,
  createDatabase,
  decryptSecret,
  encryptSecret,
  jobOutbox,
  nodeAgentReleases,
  nodeMetricsCurrent,
  nodeServiceCheckResults,
  nodeServiceChecks,
  nodes,
  peerCurrent,
  portalPolicy,
  quotaRequests,
  users,
  vpnKeys,
} from "@amnezia/db";
import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

/**
 * Resolves to the rejection value of `promise`, or null when it fulfils.
 * `expect(...).rejects.toMatchObject({ message: expect.stringContaining(x) })`
 * would type the matcher as `any`, which the lint rules reject; this keeps the
 * assertion on the message explicit and typed.
 */
const failureOf = async (
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; code?: string; message?: string } | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { statusCode?: number; code?: string; message?: string };
  }
};

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
    // Audit rows are cascaded away with their users, but rows left by an
    // earlier run against a re-used database are not: some assertions here
    // COUNT audit events, so the table has to start empty for the suite to be
    // self-contained rather than only passing on CI's throwaway database.
    await database.db.delete(auditEvents);
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

  /** Flip the singleton's mode; the row exists because beforeAll inserted it. */
  const setGlobalKeyLimitMode = async (mode: KeyLimitMode): Promise<void> => {
    if (!database) throw new Error("No database");
    await database.db.update(portalPolicy).set({ keyLimitMode: mode });
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
      // Filter on the action too: the request id is also the target of the
      // earlier `quota_request.created` event, so matching on the id alone
      // would assert against whichever of the two the planner returned first.
      const [event] = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, created.id),
            eq(auditEvents.action, "admin.quota-requests.approve"),
          ),
        );
      expect(event?.metadata).toMatchObject({ clearedNodeLimitCount: 1 });
    },
  );

  runDatabaseTest(
    "global mode: the limit is one pool across every server",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await setGlobalKeyLimitMode("global");
      try {
        const nodeA = await seedNode("pool-a");
        const nodeB = await seedNode("pool-b");
        // Pool of 2, with a dormant per-node limit of 0 on B that must NOT apply.
        const owner = await seedQuotaUser("pool@example.com", {
          keyLimitOverride: 2,
          nodeKeyLimits: { [nodeB]: 0 },
        });
        const create = (nodeId: string, label: string) =>
          repository.createProvisioningKey(owner, {
            nodeId,
            protocol: "awg2",
            deviceType: "other",
            deviceLabel: label,
            routeProfile: "full_tunnel",
            nameDisplay: defaultKeyNameDisplay,
          });

        await create(nodeA, "pool-1");
        await create(nodeB, "pool-2");
        await expect(create(nodeA, "pool-3")).rejects.toMatchObject({
          code: "QUOTA_EXCEEDED",
        });

        const me = (await repository.getMe(owner)) as {
          keyLimit: number;
          keyLimitMode: string;
          keyCount: number;
          perNode: Array<{ nodeId: string; used: number; limit: number }>;
        };
        expect(me.keyLimitMode).toBe("global");
        expect(me.keyLimit).toBe(2);
        expect(me.keyCount).toBe(2);
        // Every per-node entry reports the pool, not the dormant per-node value.
        expect(me.perNode.find((entry) => entry.nodeId === nodeB)?.limit).toBe(2);
      } finally {
        await setGlobalKeyLimitMode("per_node");
      }
    },
  );

  runDatabaseTest(
    "global mode: ten concurrent requests across two servers create exactly the pool",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await setGlobalKeyLimitMode("global");
      try {
        const nodeA = await seedNode("pool-race-a");
        const nodeB = await seedNode("pool-race-b");
        const owner = await seedQuotaUser("pool-race@example.com", {
          keyLimitOverride: 3,
        });
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, (_, index) =>
            repository.createProvisioningKey(owner, {
              nodeId: index % 2 === 0 ? nodeA : nodeB,
              protocol: "awg2",
              deviceType: "other",
              deviceLabel: `pool-race-${index}`,
              routeProfile: "full_tunnel",
              nameDisplay: defaultKeyNameDisplay,
            }),
          ),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(3);
        const [total] = await database.db
          .select({ value: count() })
          .from(vpnKeys)
          .where(eq(vpnKeys.ownerId, owner.id));
        expect(total?.value).toBe(3);
      } finally {
        await setGlobalKeyLimitMode("per_node");
      }
    },
  );

  runDatabaseTest("a per-user mode override wins over the global mode", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
    });
    const admin: Actor = { ...actor, role: "admin" };
    const nodeA = await seedNode("override-a");
    const nodeB = await seedNode("override-b");
    const owner = await seedQuotaUser("override@example.com", {
      keyLimitOverride: 1,
    });
    // Global policy stays per_node; this user alone is switched to global.
    const result = await repository.adminAction(
      admin,
      "users",
      owner.id,
      "set-limit",
      { keyLimitOverride: 1, keyLimitMode: "global" },
    );
    expect(result).toMatchObject({ keyLimitMode: "global" });
    const [row] = await database.db
      .select({ policyOverride: users.policyOverride })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(row?.policyOverride).toEqual({ keyLimitMode: "global" });

    await repository.createProvisioningKey(owner, {
      nodeId: nodeA,
      protocol: "awg2",
      deviceType: "other",
      deviceLabel: "override-1",
      routeProfile: "full_tunnel",
      nameDisplay: defaultKeyNameDisplay,
    });
    // Per-node mode would allow one key on B as well; the pool of 1 does not.
    await expect(
      repository.createProvisioningKey(owner, {
        nodeId: nodeB,
        protocol: "awg2",
        deviceType: "other",
        deviceLabel: "override-2",
        routeProfile: "full_tunnel",
        nameDisplay: defaultKeyNameDisplay,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    // Clearing the override (null) removes the key and leaves nothing behind.
    await repository.adminAction(admin, "users", owner.id, "set-limit", {
      keyLimitOverride: 1,
      keyLimitMode: null,
    });
    const [cleared] = await database.db
      .select({ policyOverride: users.policyOverride })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(cleared?.policyOverride).toBeNull();
  });

  runDatabaseTest(
    "global mode: a per-server request is refused, a legacy one is coerced on approval",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const nodeA = await seedNode("coerce-a");
      const owner = await seedQuotaUser("coerce@example.com", {
        keyLimitOverride: 2,
        nodeKeyLimits: { [nodeA]: 1 },
      });
      // Created while the user is still in per-node mode.
      const legacy = await repository.createQuotaRequest(owner, {
        requestedLimit: 6,
        nodeId: nodeA,
      });
      await setGlobalKeyLimitMode("global");
      try {
        await expect(
          repository.createQuotaRequest(owner, {
            requestedLimit: 7,
            nodeId: nodeA,
          }),
        ).rejects.toMatchObject({ code: "NODE_TARGET_NOT_APPLICABLE" });

        await repository.adminAction(
          admin,
          "quota-requests",
          legacy.id,
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
        // The pool was raised; the dormant per-node entry is untouched.
        expect(updated?.keyLimitOverride).toBe(6);
        expect(updated?.nodeKeyLimits).toEqual({ [nodeA]: 1 });
        const [event] = await database.db
          .select({ metadata: auditEvents.metadata })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetId, legacy.id),
              eq(auditEvents.action, "admin.quota-requests.approve"),
            ),
          );
        expect(event?.metadata).toMatchObject({
          keyLimitMode: "global",
          targetCoerced: true,
          clearedNodeLimitCount: 0,
        });
      } finally {
        await setGlobalKeyLimitMode("per_node");
      }
    },
  );

  // S8, the half that is easiest to break by accident: approving a request moves
  // a NUMBER. It must never move the mode, in either direction -- an admin who
  // clicks approve is answering "may they have more keys", not "should everyone
  // read their limits differently". Checked against the database rather than the
  // return value, because the damage would be a stray column write.
  runDatabaseTest("approving a request never moves the key limit mode", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
    });
    const admin: Actor = { ...actor, role: "admin" };
    await setGlobalKeyLimitMode("global");
    try {
      const owner = await seedQuotaUser("mode-invariant@example.com", {
        keyLimitOverride: 2,
      });
      const request = await repository.createQuotaRequest(owner, {
        requestedLimit: 6,
      });

      await repository.adminAction(
        admin,
        "quota-requests",
        request.id,
        "approve",
        {},
      );

      const [policy] = await database.db.select().from(portalPolicy);
      expect(policy?.keyLimitMode).toBe("global");
      const [user] = await database.db
        .select({ policyOverride: users.policyOverride })
        .from(users)
        .where(eq(users.id, owner.id));
      // Untouched: the user never had a mode override, and approval must not
      // invent one -- that would silently pin them against a later switch.
      expect(user?.policyOverride?.keyLimitMode).toBeUndefined();
    } finally {
      await setGlobalKeyLimitMode("per_node");
    }
  });

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

  // resolvePortalPolicy spreads a user's override over the global policy, so
  // every field the override carries is a field that user stops inheriting.
  // zod materialises defaults on a .partial() parse, so persisting the parse
  // result verbatim would freeze a user against every future global change the
  // moment an admin saved anything about them. Pinned against a real database
  // because the damage is in what is written, not in what is computed.
  runDatabaseTest(
    "stores only the policy fields an admin actually named",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const target = await seedQuotaUser("policy-target@example.com");

      await repository.adminAction(admin, "users", target.id, "set-policy", {
        allowKeyCreation: false,
      });

      const [row] = await database.db
        .select({ policyOverride: users.policyOverride })
        .from(users)
        .where(eq(users.id, target.id));
      expect(row?.policyOverride).toEqual({ allowKeyCreation: false });
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

    // Ordered explicitly: the assertion is a sequence, and an unordered select
    // returns rows in whatever physical order the updates above left them in.
    const jobs = await database.db
      .select({ type: jobOutbox.type })
      .from(jobOutbox)
      .orderBy(jobOutbox.createdAt);
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

  runDatabaseTest("refuses to delete a node that still has keys", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({ db: database.db, keyring });
    const admin: Actor = { ...actor, role: "admin" };
    const node = await seedNode("delete-guard");
    const owner = await seedQuotaUser("delete-guard@example.com");
    await repository.createProvisioningKey(owner, {
      nodeId: node,
      protocol: "awg2",
      deviceType: "other",
      deviceLabel: "laptop",
      routeProfile: "full_tunnel",
      nameDisplay: defaultKeyNameDisplay,
    });

    await expect(
      repository.deleteNode(admin, node, { deleteKeys: false }),
    ).rejects.toMatchObject({ code: "NODE_HAS_KEYS" });
    // The refusal must leave everything exactly as it was.
    const [stillThere] = await database.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, node));
    expect(stillThere?.id).toBe(node);
  });

  runDatabaseTest("deletes a node together with its keys when asked", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({ db: database.db, keyring });
    const admin: Actor = { ...actor, role: "admin" };
    const node = await seedNode("delete-cascade");
    const owner = await seedQuotaUser("delete-cascade@example.com");
    const key = (await repository.createProvisioningKey(owner, {
      nodeId: node,
      protocol: "awg2",
      deviceType: "other",
      deviceLabel: "laptop",
      routeProfile: "full_tunnel",
      nameDisplay: defaultKeyNameDisplay,
    })) as { id: string };
    // Provisioning enqueues a job whose key id lives in the payload, not in a
    // foreign key — the delete has to clear it or the worker retries forever.
    const jobKey = `vpn-key.provision:${key.id}`;
    const [queued] = await database.db
      .select({ id: jobOutbox.id })
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, jobKey));
    expect(queued?.id).toBeDefined();

    const result = (await repository.deleteNode(admin, node, {
      deleteKeys: true,
    })) as { deletedKeys: number; affectedOwners: number; droppedJobs: number };
    expect(result.deletedKeys).toBe(1);
    expect(result.affectedOwners).toBe(1);
    expect(result.droppedJobs).toBe(1);

    expect(
      await database.db.select().from(nodes).where(eq(nodes.id, node)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(vpnKeys).where(eq(vpnKeys.id, key.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(jobOutbox)
        .where(eq(jobOutbox.deduplicationKey, jobKey)),
    ).toHaveLength(0);
    // The owner survives; only their key on that node is gone.
    expect(
      await database.db.select().from(users).where(eq(users.id, owner.id)),
    ).toHaveLength(1);
    const [event] = await database.db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, node),
          eq(auditEvents.action, "node.deleted"),
        ),
      );
    expect(event?.metadata).toMatchObject({ deletedKeys: 1, affectedOwners: 1 });
  });

  runDatabaseTest(
    "scrubs a deleted node from the policy node lists",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const doomed = await seedNode("scrub-doomed");
      const survivor = await seedNode("scrub-survivor");
      const tail = await seedNode("scrub-tail");
      // doomed and survivor are the recommended top two; tail is only
      // positioned.
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        nodeOrder: [doomed, survivor, tail],
        recommendedNodeIds: [doomed, survivor],
      });

      await repository.deleteNode(admin, doomed, { deleteKeys: false });

      const [policy] = await database.db
        .select({
          recommendedNodeIds: portalPolicy.recommendedNodeIds,
          nodeOrder: portalPolicy.nodeOrder,
        })
        .from(portalPolicy);
      // Only the deleted id goes; the survivors keep their relative positions,
      // and the recommended set is still a prefix of the order.
      expect(policy?.recommendedNodeIds).toEqual([survivor]);
      expect(policy?.nodeOrder).toEqual([survivor, tail]);

      const [event] = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "node.deleted"),
            eq(auditEvents.targetId, doomed),
          ),
        );
      expect(event?.metadata).toMatchObject({
        scrubbedFromRecommended: true,
        scrubbedFromOrder: true,
      });

      // Leave the shared policy row as the later cases expect to find it.
      // Both fields go in one payload: clearing the order alone while a
      // recommended id survives is exactly what the prefix check rejects.
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        recommendedNodeIds: [],
        nodeOrder: [],
      });
    },
  );

  runDatabaseTest(
    "auto-picks in the admin order and never a node the user may not use",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const alpha = await seedNode("auto-alpha");
      const beta = await seedNode("auto-beta");
      await database.db
        .update(portalPolicy)
        .set({ allowNodeSelection: false })
        .where(eq(portalPolicy.id, true));
      try {
        // Phase A: both nodes available, admin put beta first. The pick must
        // follow that, not the uuid order the SELECT locks rows in.
        const bothUser = await seedQuotaUser("auto-both@example.com", {
          allowedNodeIds: [alpha, beta],
        });
        await repository.adminAction(
          admin,
          "portal-policy",
          "global",
          "update",
          { nodeOrder: [beta, alpha], recommendedNodeIds: [] },
        );
        const firstKey = (await repository.createProvisioningKey(bothUser, {
          nodeId: alpha, // ignored while node selection is off
          protocol: "awg2",
          deviceType: "other",
          deviceLabel: "auto-a",
          routeProfile: "full_tunnel",
          nameDisplay: defaultKeyNameDisplay,
        })) as { id: string };
        const [storedA] = await database.db
          .select({ nodeId: vpnKeys.nodeId })
          .from(vpnKeys)
          .where(eq(vpnKeys.id, firstKey.id));
        expect(storedA?.nodeId).toBe(beta);

        // Phase B: alpha is now first in the order AND the recommended one
        // (which the prefix rule allows, since it is the top), but this user is
        // not allowed to use it. It must not be picked, and beta must not
        // inherit any "recommended" preference - it is simply the next
        // available node in the admin order.
        const limitedUser = await seedQuotaUser("auto-limited@example.com", {
          allowedNodeIds: [beta],
        });
        await repository.adminAction(
          admin,
          "portal-policy",
          "global",
          "update",
          { nodeOrder: [alpha, beta], recommendedNodeIds: [alpha] },
        );
        const secondKey = (await repository.createProvisioningKey(limitedUser, {
          nodeId: alpha,
          protocol: "awg2",
          deviceType: "other",
          deviceLabel: "auto-b",
          routeProfile: "full_tunnel",
          nameDisplay: defaultKeyNameDisplay,
        })) as { id: string };
        const [storedB] = await database.db
          .select({ nodeId: vpnKeys.nodeId })
          .from(vpnKeys)
          .where(eq(vpnKeys.id, secondKey.id));
        expect(storedB?.nodeId).toBe(beta);
      } finally {
        // Restore the shared policy row for the cases that run after this one.
        await database.db
          .update(portalPolicy)
          .set({
            allowNodeSelection: true,
            recommendedNodeIds: [],
            nodeOrder: [],
          })
          .where(eq(portalPolicy.id, true));
      }
    },
  );

  // The panel resolves a host once and keeps the answer, which is right because
  // a server's address does not change under it. The one case that breaks is a
  // server moving to a new IP behind the same DNS name -- and without this the
  // only remedy would be an UPDATE against production. Both columns must clear
  // together: the timestamp answers "when did the panel learn this address", so
  // leaving it behind would stamp an address that is gone.
  runDatabaseTest("forgets a resolved public IP on request", async () => {
    if (!database) return;
    const repository = new PostgresControlRepository({
      db: database.db,
      keyring,
    });
    const admin: Actor = { ...actor, role: "admin" };
    const nodeId = await seedNode("address-clearable");
    await database.db
      .update(nodes)
      .set({
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
        publicIpResolvedAt: new Date("2026-09-03T08:00:00Z"),
      })
      .where(eq(nodes.id, nodeId));

    await repository.updateNode(admin, nodeId, { publicIp: null });

    const [row] = await database.db
      .select({
        publicHost: nodes.publicHost,
        publicIp: nodes.publicIp,
        publicIpResolvedAt: nodes.publicIpResolvedAt,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    expect(row?.publicIp).toBeNull();
    expect(row?.publicIpResolvedAt).toBeNull();
    // The reported host survives: it is the node's own configuration, not
    // something the panel worked out, and clearing it would only make the
    // worker wait for the next poll before it could resolve anything.
    expect(row?.publicHost).toBe("vpn.example.com");
  });

  runDatabaseTest(
    "lists each node's public host and resolved IP for admins",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const admin: Actor = { ...actor, role: "admin" };
      const reported = await seedNode("address-reported");
      const unreported = await seedNode("address-unreported");
      await database.db
        .update(nodes)
        .set({ publicHost: "vpn.example.com", publicIp: "203.0.113.10" })
        .where(eq(nodes.id, reported));

      const rows = (await repository.adminList(admin, "nodes")) as Array<{
        id: string;
        publicHost: string | null;
        publicIp: string | null;
      }>;

      expect(rows.find((row) => row.id === reported)).toMatchObject({
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
      });
      expect(rows.find((row) => row.id === unreported)).toMatchObject({
        publicHost: null,
        publicIp: null,
      });
    },
  );

  // Both sides of the gate live in one test on purpose: the "off" branch passes
  // trivially before the feature exists, so only pairing it with the "on"
  // branch keeps the two from drifting apart.
  runDatabaseTest(
    "shows users a node's address only when the policy allows it",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const named = await seedNode("user-address-named");
      await database.db
        .update(nodes)
        .set({
          publicHost: "vpn.example.com",
          publicIp: "203.0.113.10",
          publicIpResolvedAt: new Date("2026-08-20T08:10:00.000Z"),
        })
        .where(eq(nodes.id, named));

      // Default policy: the field is absent entirely, not null and not empty —
      // an absent key is what keeps it out of the JSON the browser receives.
      await database.db.update(portalPolicy).set({ showNodeAddress: false });
      const hidden = (await repository.listNodes(actor)) as Array<
        Record<string, unknown>
      >;
      const hiddenRow = hidden.find((row) => row.id === named);
      expect(hiddenRow).toBeDefined();
      expect("publicAddress" in (hiddenRow ?? {})).toBe(false);
      // The raw pair must never reach a user either, flag or no flag.
      expect("publicHost" in (hiddenRow ?? {})).toBe(false);
      expect("publicIp" in (hiddenRow ?? {})).toBe(false);
      expect("publicIpResolvedAt" in (hiddenRow ?? {})).toBe(false);

      await database.db.update(portalPolicy).set({ showNodeAddress: true });
      const shown = (await repository.listNodes(actor)) as Array<
        Record<string, unknown>
      >;
      const shownRow = shown.find((row) => row.id === named);
      // One string, the resolved IPv4 — not the host, not a pair, no timestamp.
      expect(shownRow).toMatchObject({ publicAddress: "203.0.113.10" });
      expect("publicIpResolvedAt" in (shownRow ?? {})).toBe(false);
      expect("publicHost" in (shownRow ?? {})).toBe(false);
      expect("publicIp" in (shownRow ?? {})).toBe(false);

      // A node whose name has never resolved still has a truthful answer.
      const unresolved = await seedNode("user-address-unresolved");
      await database.db
        .update(nodes)
        .set({ publicHost: "v6.example.com", publicIp: null })
        .where(eq(nodes.id, unresolved));
      const withFallback = (await repository.listNodes(actor)) as Array<
        Record<string, unknown>
      >;
      expect(withFallback.find((row) => row.id === unresolved)).toMatchObject({
        publicAddress: "v6.example.com",
      });

      // A node that reported nothing at all stays silent even with the flag on:
      // there is no "unknown" state on the user side.
      const silent = await seedNode("user-address-silent");
      const withSilent = (await repository.listNodes(actor)) as Array<
        Record<string, unknown>
      >;
      const silentRow = withSilent.find((row) => row.id === silent);
      expect(silentRow).toBeDefined();
      expect("publicAddress" in (silentRow ?? {})).toBe(false);

      // Restore the default so a later test cannot inherit an enabled flag.
      await database.db.update(portalPolicy).set({ showNodeAddress: false });
    },
  );
});

describe("PostgresControlRepository user node order", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let viewer: Actor;
  let admin: Actor;
  const seeded: string[] = [];

  const seedNode = async (name: string, publicName: string | null) => {
    if (!database) throw new Error("no database");
    const encryptedCredentials = encryptSecret("api-key", keyring, 1);
    const encryptedLabel = encryptSecret(
      randomBytes(32).toString("base64"),
      keyring,
      1,
    );
    const [node] = await database.db
      .insert(nodes)
      .values({
        name,
        publicName,
        apiBaseUrl: `http://127.0.0.1:4100/${name}`,
        credentialsCiphertext: encryptedCredentials.ciphertext,
        credentialsNonce: encryptedCredentials.nonce,
        credentialsAuthTag: encryptedCredentials.authTag,
        credentialsKeyVersion: encryptedCredentials.keyVersion,
        labelSecretCiphertext: encryptedLabel.ciphertext,
        labelSecretNonce: encryptedLabel.nonce,
        labelSecretAuthTag: encryptedLabel.authTag,
        labelSecretKeyVersion: encryptedLabel.keyVersion,
      })
      .returning({ id: nodes.id });
    if (!node) throw new Error(`Failed to seed node ${name}`);
    seeded.push(node.id);
    return node.id;
  };

  beforeAll(async () => {
    if (!database) return;
    const [user] = await database.db
      .insert(users)
      .values({ email: "order-viewer@example.com" })
      .returning();
    if (!user) throw new Error("Failed to seed viewer");
    viewer = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "user",
      status: "active",
    };
    const [adminUser] = await database.db
      .insert(users)
      .values({ email: "order-admin@example.com", role: "admin" })
      .returning();
    if (!adminUser) throw new Error("Failed to seed admin");
    admin = {
      id: adminUser.id,
      email: adminUser.email,
      displayName: null,
      role: "admin",
      status: "active",
    };
    // Internal names deliberately sort the other way round from the public
    // names, so a test that passes must be sorting on what the user sees.
    await seedNode("order-c", "Zurich");
    await seedNode("order-b", "amsterdam");
    await seedNode("order-a", null);
  });

  afterAll(async () => {
    if (!database) return;
    for (const id of seeded) {
      await database.db.delete(nodes).where(eq(nodes.id, id));
    }
    await database.db.delete(users).where(eq(users.id, viewer.id));
    await database.db.delete(users).where(eq(users.id, admin.id));
    await database.client.end();
  });

  runDatabaseTest(
    "returns the same name-ordered list before and after a node row is rewritten",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const names = (rows: unknown[]) =>
        rows.map((row) => (row as { name: string }).name);

      // Only this block's nodes: the first describe in this file leaves its own
      // seeded nodes behind, and listNodes returns every enabled node.
      const ours = (rows: unknown[]) =>
        names(rows.filter((row) => seeded.includes((row as { id: string }).id)));
      const first = await repository.listNodes(viewer);
      expect(ours(first)).toEqual(["amsterdam", "order-a", "Zurich"]);

      // The worker touches node rows on every poll; a rewrite must not move
      // the node in the user's list.
      await database.db
        .update(nodes)
        .set({ lastHealthAt: new Date(), updatedAt: new Date() })
        .where(eq(nodes.id, seeded[0]!));
      const second = await repository.listNodes(viewer);
      expect(names(second)).toEqual(names(first));
    },
  );

  // The order is set FIRST, because nothing can be recommended before it has a
  // position: the recommended set must be a prefix of the order.
  runDatabaseTest(
    "stores the node order verbatim, first duplicate wins",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      // Deliberately NOT the name order, and with a duplicate in the middle:
      // the stored value must keep the admin positions, dropping the later copy.
      const wanted = [seeded[2]!, seeded[0]!, seeded[2]!, seeded[1]!];

      const updated = (await repository.adminAction(
        admin,
        "portal-policy",
        "global",
        "update",
        { nodeOrder: wanted },
      )) as { nodeOrder: string[] };
      expect(updated.nodeOrder).toEqual([seeded[2], seeded[0], seeded[1]]);

      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ nodeOrder: string[] }>;
      expect(row?.nodeOrder).toEqual([seeded[2], seeded[0], seeded[1]]);

      const events = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, admin.id),
            eq(auditEvents.action, "admin.portal-policy.update"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      expect(events[0]?.metadata).toMatchObject({
        fields: ["nodeOrder"],
        orderedNodeCount: 3,
      });
    },
  );

  runDatabaseTest(
    "stores a deduplicated recommended list, canonicalized into order sequence",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      // The order is [seeded[2], seeded[0], seeded[1]]; recommend its top two,
      // sent bottom-up and with a duplicate. The check is on the set, the
      // stored form follows the order.
      const updated = (await repository.adminAction(
        admin,
        "portal-policy",
        "global",
        "update",
        { recommendedNodeIds: [seeded[0]!, seeded[2]!, seeded[0]!] },
      )) as { recommendedNodeIds: string[] };
      expect(updated.recommendedNodeIds).toEqual([seeded[2], seeded[0]]);

      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ recommendedNodeIds: string[]; nodeOrder: string[] }>;
      expect(row?.recommendedNodeIds).toEqual([seeded[2], seeded[0]]);
      // The order itself was not touched by a recommended-only write.
      expect(row?.nodeOrder).toEqual([seeded[2], seeded[0], seeded[1]]);

      const events = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, admin.id),
            eq(auditEvents.action, "admin.portal-policy.update"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      expect(events[0]?.metadata).toMatchObject({
        fields: ["recommendedNodeIds"],
        recommendedNodeCount: 2,
      });
    },
  );

  runDatabaseTest(
    "rejects an id that is not a node, in either list",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const ghost = "00000000-0000-4000-8000-000000000000";
      // Existence is checked before the prefix rule, so a ghost id reports the
      // problem the admin can actually act on.
      await expect(
        repository.adminAction(admin, "portal-policy", "global", "update", {
          recommendedNodeIds: [ghost],
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: "NODE_NOT_FOUND" });
      await expect(
        repository.adminAction(admin, "portal-policy", "global", "update", {
          nodeOrder: [seeded[0]!, ghost],
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: "NODE_NOT_FOUND" });
      // The rejected write must not have half-applied.
      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ nodeOrder: string[]; recommendedNodeIds: string[] }>;
      expect(row?.nodeOrder).toEqual([seeded[2], seeded[0], seeded[1]]);
      expect(row?.recommendedNodeIds).toEqual([seeded[2], seeded[0]]);
    },
  );

  runDatabaseTest(
    "refuses to recommend a server that is not at the top of the order",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      // seeded[1] is last in the order and seeded[0] before it would stop being
      // recommended, so this set is not a prefix.
      const failure = await failureOf(
        repository.adminAction(admin, "portal-policy", "global", "update", {
          recommendedNodeIds: [seeded[2]!, seeded[1]!],
        }),
      );
      expect(failure).toMatchObject({
        statusCode: 400,
        code: "RECOMMENDED_NOT_PREFIX",
      });
      // The message names the node the admin has to move or un-recommend.
      expect(failure?.message).toContain(seeded[1]!);

      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ recommendedNodeIds: string[] }>;
      expect(row?.recommendedNodeIds).toEqual([seeded[2], seeded[0]]);
    },
  );

  runDatabaseTest(
    "refuses a reorder that would leave an already recommended server behind",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      // Recommended is [seeded[2], seeded[0]]; moving seeded[1] to the top
      // would push both down. The reorder is REJECTED rather than silently
      // trimming the recommended set.
      const failure = await failureOf(
        repository.adminAction(admin, "portal-policy", "global", "update", {
          nodeOrder: [seeded[1]!, seeded[2]!, seeded[0]!],
        }),
      );
      expect(failure).toMatchObject({
        statusCode: 400,
        code: "RECOMMENDED_NOT_PREFIX",
      });
      expect(failure?.message).toContain(seeded[2]!);
      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ nodeOrder: string[] }>;
      expect(row?.nodeOrder).toEqual([seeded[2], seeded[0], seeded[1]]);

      // The way out: send both fields together. The admin is never stuck.
      const updated = (await repository.adminAction(
        admin,
        "portal-policy",
        "global",
        "update",
        {
          nodeOrder: [seeded[1]!, seeded[2]!, seeded[0]!],
          recommendedNodeIds: [seeded[1]!],
        },
      )) as { nodeOrder: string[]; recommendedNodeIds: string[] };
      expect(updated.nodeOrder).toEqual([seeded[1], seeded[2], seeded[0]]);
      expect(updated.recommendedNodeIds).toEqual([seeded[1]]);

      // Clearing the recommended set is always valid, whatever the order is.
      const cleared = (await repository.adminAction(
        admin,
        "portal-policy",
        "global",
        "update",
        { recommendedNodeIds: [] },
      )) as { recommendedNodeIds: string[] };
      expect(cleared.recommendedNodeIds).toEqual([]);
    },
  );


  runDatabaseTest(
    "lists nodes in the admin order and flags the recommended prefix",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        // Deliberately not the name order: "Zurich" first, "amsterdam" last.
        nodeOrder: [seeded[0]!, seeded[2]!, seeded[1]!],
        recommendedNodeIds: [seeded[0]!],
      });
      const rows = (await repository.listNodes(viewer)) as Array<{
        id: string;
        name: string;
        recommended: boolean;
      }>;
      const ours = rows.filter((row) => seeded.includes(row.id));
      expect(ours.map((row) => [row.name, row.recommended])).toEqual([
        ["Zurich", true],
        ["order-a", false],
        ["amsterdam", false],
      ]);
      // Nothing outside our seed is recommended either.
      expect(
        rows.filter((row) => row.recommended).map((row) => row.id),
      ).toEqual([seeded[0]]);
    },
  );

  runDatabaseTest(
    "un-recommending a server does not move it, and recommending does not either",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const order = [seeded[0]!, seeded[2]!, seeded[1]!];
      const names = async () => {
        const rows = (await repository.listNodes(viewer)) as Array<{
          id: string;
          name: string;
        }>;
        return rows
          .filter((row) => seeded.includes(row.id))
          .map((row) => row.name);
      };

      // Recommend the top two, then none at all. The badge is the only thing
      // that changes: the order is the admin list in both cases.
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        nodeOrder: order,
        recommendedNodeIds: [seeded[0]!, seeded[2]!],
      });
      const withBadges = await names();
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        recommendedNodeIds: [],
      });
      const withoutBadges = await names();

      expect(withBadges).toEqual(["Zurich", "order-a", "amsterdam"]);
      expect(withoutBadges).toEqual(withBadges);
    },
  );

  runDatabaseTest(
    "hides a node excluded by a per-user override and closes the gap",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        nodeOrder: [seeded[1]!, seeded[2]!, seeded[0]!],
        // "amsterdam" is the recommended one, at the top of the order ...
        recommendedNodeIds: [seeded[1]!],
      });
      // ... but this user may only use the other two. Recommending a node must
      // never widen what a user can see, and nothing is substituted for it:
      // the user simply gets the remaining two, in the admin order.
      await database.db
        .update(users)
        .set({ policyOverride: { allowedNodeIds: [seeded[2]!, seeded[0]!] } })
        .where(eq(users.id, viewer.id));

      const rows = (await repository.listNodes(viewer)) as Array<{
        id: string;
        name: string;
        recommended: boolean;
      }>;
      const ours = rows.filter((row) => seeded.includes(row.id));
      expect(ours.map((row) => row.name)).toEqual(["order-a", "Zurich"]);
      expect(ours.some((row) => row.id === seeded[1])).toBe(false);
      // No other node inherits the badge.
      expect(ours.some((row) => row.recommended)).toBe(false);

      // Restore, so the later cases see the unrestricted user again.
      await database.db
        .update(users)
        .set({ policyOverride: null })
        .where(eq(users.id, viewer.id));
    },
  );

});

describe("PostgresControlRepository global policy update", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let admin: Actor;

  beforeAll(async () => {
    if (!database) return;
    const [adminUser] = await database.db
      .insert(users)
      .values({ email: "policy-admin@example.com", role: "admin" })
      .returning();
    if (!adminUser) throw new Error("Failed to seed admin");
    admin = {
      id: adminUser.id,
      email: adminUser.email,
      displayName: null,
      role: "admin",
      status: "active",
    };
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.delete(users).where(eq(users.id, admin.id));
    await database.client.end();
  });

  runDatabaseTest(
    "a single-field update leaves every other policy field alone",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      // Two fields that are NOT sent by the second call, each with a value
      // that differs from its schema default, so a full-replace write is
      // visible as a reset rather than a no-op.
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        showNodeAddress: true,
        keyLimitMode: "global",
      });

      await repository.adminAction(admin, "portal-policy", "global", "update", {
        defaultKeyLimit: 7,
      });

      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{
        showNodeAddress: boolean;
        keyLimitMode: string;
        defaultKeyLimit: number | null;
      }>;
      expect(row?.defaultKeyLimit).toBe(7);
      // `portalPolicySchema.partial()` still applies every `.default()`, so
      // parsing the one-field payload yields sixteen fields. Writing those
      // would put both of these back to false / "per_node".
      expect(row?.showNodeAddress).toBe(true);
      expect(row?.keyLimitMode).toBe("global");

      const [event] = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, admin.id),
            eq(auditEvents.action, "admin.portal-policy.update"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      // The audit trail must name the field the admin actually changed, not
      // every field the schema defaulted on their behalf.
      expect(event?.metadata).toMatchObject({ fields: ["defaultKeyLimit"] });
    },
  );

  // The admin policy page reads this row and posts it straight back, so the
  // read output must always be valid write input. It was not: install_guide_videos
  // was nullable while the contract models an object, so on any panel that had
  // never attached a video the whole form failed with a VALIDATION_ERROR and
  // nothing on the page could be saved. The round trip is asserted over the
  // whole row rather than that one field, so the next column with the same
  // shape is caught here instead of in production.
  runDatabaseTest(
    "accepts its own policy read back unchanged",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<Record<string, unknown>>;
      expect(row).toBeDefined();
      // Exactly what apps/web/app/admin/policy/page.tsx submits.
      const payload = { ...row };
      delete payload.cfApiTokenSet;

      await expect(
        repository.adminAction(
          admin,
          "portal-policy",
          "global",
          "update",
          payload,
        ),
      ).resolves.toBeDefined();
    },
  );

  // The write-side half of the same fix. The column is NOT NULL from migration
  // 0017 on, so a stored null can no longer be produced to test the read-side
  // normalisation against a migrated database - but a CLIENT can still send
  // one (an older panel's row echoed back, a script), and that must save
  // rather than reject the whole request.
  runDatabaseTest(
    "takes a null installGuideVideos as 'no videos' rather than refusing",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await expect(
        repository.adminAction(admin, "portal-policy", "global", "update", {
          installGuideVideos: null,
        }),
      ).resolves.toBeDefined();

      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ installGuideVideos: unknown }>;
      expect(row?.installGuideVideos).toEqual({});
    },
  );

  // The other half of the same guarantee, in a second field. A node id that
  // names no node is inert on every read path (it matches nothing) but the
  // update's existence check rejects it - so a stale id in the stored order
  // made the whole policy page unsaveable, exactly like the null did.
  // deleteNode scrubs both lists, so this state comes from a row removed
  // out-of-band; the read drops the id, and the next save cleans the row.
  runDatabaseTest(
    "survives a node id in the stored order whose node is gone",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      const encryptedCredentials = encryptSecret("api-key", keyring, 1);
      const encryptedLabel = encryptSecret(
        randomBytes(32).toString("base64"),
        keyring,
        1,
      );
      const [doomed] = await database.db
        .insert(nodes)
        .values({
          name: "policy-stale",
          apiBaseUrl: "http://127.0.0.1:4100/policy-stale",
          credentialsCiphertext: encryptedCredentials.ciphertext,
          credentialsNonce: encryptedCredentials.nonce,
          credentialsAuthTag: encryptedCredentials.authTag,
          credentialsKeyVersion: encryptedCredentials.keyVersion,
          labelSecretCiphertext: encryptedLabel.ciphertext,
          labelSecretNonce: encryptedLabel.nonce,
          labelSecretAuthTag: encryptedLabel.authTag,
          labelSecretKeyVersion: encryptedLabel.keyVersion,
        })
        .returning({ id: nodes.id });
      if (!doomed) throw new Error("Failed to seed the node");

      await repository.adminAction(admin, "portal-policy", "global", "update", {
        nodeOrder: [doomed.id],
        recommendedNodeIds: [doomed.id],
      });
      // Deleted around deleteNode, which is what leaves the id behind.
      await database.db.delete(nodes).where(eq(nodes.id, doomed.id));

      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<Record<string, unknown>>;
      expect(row?.nodeOrder).toEqual([]);
      expect(row?.recommendedNodeIds).toEqual([]);

      const payload = { ...row };
      delete payload.cfApiTokenSet;
      await expect(
        repository.adminAction(
          admin,
          "portal-policy",
          "global",
          "update",
          payload,
        ),
      ).resolves.toBeDefined();
    },
  );

  runDatabaseTest(
    "normalises and de-duplicates the domains it stores",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAllowedDomains: ["@Company.TLD", "company.tld", " other.tld "],
      });
      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ cfAccessAllowedDomains: string[] }>;
      expect(row?.cfAccessAllowedDomains).toEqual(["company.tld", "other.tld"]);
    },
  );

  runDatabaseTest(
    "refuses an address in the domain list",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await expect(
        repository.adminAction(admin, "portal-policy", "global", "update", {
          cfAccessAllowedDomains: ["someone@company.tld"],
        }),
      ).rejects.toThrow(/address/i);
    },
  );

  runDatabaseTest(
    "records the domain list itself in the audit event, not just the field name",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAllowedDomains: ["company.tld"],
      });
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAllowedDomains: ["company.tld", "other.tld"],
      });

      const [event] = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, admin.id),
            eq(auditEvents.action, "admin.portal-policy.update"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      // "who let company.tld in" is not reconstructable from `fields` alone —
      // the value, and what it replaced, must be in the same row.
      expect(event?.metadata).toMatchObject({
        fields: ["cfAccessAllowedDomains"],
        cfAccessAllowedDomains: ["company.tld", "other.tld"],
        cfAccessAllowedDomainsBefore: ["company.tld"],
      });
    },
  );

  runDatabaseTest(
    "never puts the API token's value in the audit event",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfApiToken: "cf-api-token-audit-canary",
      });

      const [event] = await database.db
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, admin.id),
            eq(auditEvents.action, "admin.portal-policy.update"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(1);
      // The field NAME is fine to record (it already is, via `fields`); the
      // secret VALUE must never appear anywhere in the row.
      expect(JSON.stringify(event?.metadata)).not.toContain(
        "cf-api-token-audit-canary",
      );
    },
  );

  // Must run with no portal_policy row present, so the row is cleared here
  // rather than relying on suite order to leave the table empty.
  runDatabaseTest(
    "gives a fresh install an empty domain list to round-trip",
    async () => {
      if (!database) return;
      const repository = new PostgresControlRepository({
        db: database.db,
        keyring,
      });
      await database.db.delete(portalPolicy);
      const [row] = (await repository.adminList(
        admin,
        "portal-policy",
      )) as Array<{ cfAccessAllowedDomains: string[] }>;
      expect(row?.cfAccessAllowedDomains).toEqual([]);
    },
  );
});

describe("PostgresControlRepository node agent update", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const repository = database
    ? new PostgresControlRepository({ db: database.db, keyring })
    : null;
  const repositoryName = "ghcr.io/owner/repo/node-agent";
  const digest = `sha256:${"a".repeat(64)}`;
  let admin: Actor;
  let nodeId: string;

  // Other blocks in this file leave rows in job_outbox, so every assertion here
  // is scoped to this job type rather than to the table.
  const agentJobs = async () =>
    database
      ? database.db
          .select()
          .from(jobOutbox)
          .where(eq(jobOutbox.type, "node.agent-update"))
      : [];
  const clearAgentJobs = async () => {
    if (database) {
      await database.db
        .delete(jobOutbox)
        .where(eq(jobOutbox.type, "node.agent-update"));
    }
  };

  beforeAll(async () => {
    if (!database) return;
    const [adminUser] = await database.db
      .insert(users)
      .values({ email: "agent-update-admin@example.com", role: "admin" })
      .returning();
    if (!adminUser) throw new Error("Failed to seed admin");
    admin = {
      id: adminUser.id,
      email: adminUser.email,
      displayName: null,
      role: "admin",
      status: "active",
    };
    const encryptedCredentials = encryptSecret("api-key", keyring, 1);
    const encryptedLabel = encryptSecret(
      randomBytes(32).toString("base64"),
      keyring,
      1,
    );
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: "agent-update-node",
        apiBaseUrl: "http://127.0.0.1:4100/agent-update",
        credentialsCiphertext: encryptedCredentials.ciphertext,
        credentialsNonce: encryptedCredentials.nonce,
        credentialsAuthTag: encryptedCredentials.authTag,
        credentialsKeyVersion: encryptedCredentials.keyVersion,
        labelSecretCiphertext: encryptedLabel.ciphertext,
        labelSecretNonce: encryptedLabel.nonce,
        labelSecretAuthTag: encryptedLabel.authTag,
        labelSecretKeyVersion: encryptedLabel.keyVersion,
      })
      .returning({ id: nodes.id });
    if (!node) throw new Error("Failed to seed node");
    nodeId = node.id;
  });

  afterAll(async () => {
    if (!database) return;
    await clearAgentJobs();
    await database.db.delete(auditEvents).where(eq(auditEvents.targetId, nodeId));
    await database.db.delete(nodes).where(eq(nodes.id, nodeId));
    await database.db.delete(users).where(eq(users.id, admin.id));
    await database.db.delete(nodeAgentReleases);
    await database.client.end();
  });

  runDatabaseTest("refuses until a release has been resolved", async () => {
    if (!database || !repository) return;
    await database.db.delete(nodeAgentReleases);

    // There is deliberately no fall back to a tag: a tag is the mutable
    // reference the node's own preflight refuses, so "not resolved" has to mean
    // "not offered".
    const failure = await failureOf(
      repository.adminAction(admin, "nodes", nodeId, "agent-update", {}),
    );
    expect(failure?.code).toBe("AGENT_IMAGE_UNRESOLVED");
    expect(await agentJobs()).toHaveLength(0);
  });

  runDatabaseTest("enqueues the resolved digest and audits it", async () => {
    if (!database || !repository) return;
    await clearAgentJobs();
    await database.db.insert(nodeAgentReleases).values({
      repository: repositoryName,
      version: "1.1.3",
      digest,
      resolvedAt: new Date(),
    });

    const result = (await repository.adminAction(
      admin,
      "nodes",
      nodeId,
      "agent-update",
      {},
    )) as { image: string; queued: boolean };
    expect(result).toMatchObject({
      image: `${repositoryName}@${digest}`,
      queued: true,
    });

    const [job] = await agentJobs();
    expect(job?.type).toBe("node.agent-update");
    expect(job?.payload).toEqual({
      nodeId,
      image: `${repositoryName}@${digest}`,
    });
    const [event] = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "admin.nodes.agent-update"));
    expect(event?.metadata).toEqual({ image: `${repositoryName}@${digest}` });
  });

  runDatabaseTest("refuses an image outside the published repository", async () => {
    if (!database || !repository) return;
    await clearAgentJobs();

    // The admin may only confirm what the panel resolved. This is checked here,
    // again on the node, and again by the host-side updater.
    const failure = await failureOf(
      repository.adminAction(admin, "nodes", nodeId, "agent-update", {
        image: `ghcr.io/evil/repo/node-agent@${digest}`,
      }),
    );
    expect(failure?.code).toBe("AGENT_IMAGE_INVALID");

    const tagFailure = await failureOf(
      repository.adminAction(admin, "nodes", nodeId, "agent-update", {
        image: `${repositoryName}:1.1.3`,
      }),
    );
    expect(tagFailure?.code).toBe("AGENT_IMAGE_INVALID");
    expect(await agentJobs()).toHaveLength(0);
  });

  runDatabaseTest("refuses an update aimed at a node that is gone", async () => {
    if (!database || !repository) return;
    const failure = await failureOf(
      repository.adminAction(
        admin,
        "nodes",
        "00000000-0000-4000-8000-000000000000",
        "agent-update",
        {},
      ),
    );
    expect(failure?.code).toBe("NODE_NOT_FOUND");
  });
});

describe("PostgresControlRepository service checks", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let admin: Actor;

  const probe = {
    kind: "http" as const,
    url: "https://gemini.google.com/",
    method: "GET" as const,
    timeoutMs: 10_000,
  };

  beforeAll(async () => {
    if (!database) return;
    await database.db.delete(nodeServiceChecks);
    // Deliberately NOT deleting users or audit rows. The suites in this file
    // share one database and run in order, and the one before this leaves keys
    // behind - a blanket `delete from users` here fails on their foreign key
    // and takes this suite down with it. Nothing below needs an empty table:
    // the audit assertion filters by target id.
    const [user] = await database.db
      .insert(users)
      .values({ email: "checks-admin@example.com", role: "admin" })
      .onConflictDoUpdate({
        target: users.email,
        set: { role: "admin" },
      })
      .returning();
    if (!user) throw new Error("Failed to seed admin");
    admin = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "admin",
      status: "active",
    };
  });

  beforeEach(async () => {
    if (!database) return;
    await database.db.delete(nodeServiceChecks);
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  const subject = () =>
    new PostgresControlRepository({ db: database!.db, keyring });

  runDatabaseTest("creates a check and audits it", async () => {
    if (!database) return;
    const created = (await subject().createServiceCheck(admin, {
      name: "Gemini",
      probe,
      assertions: [{ type: "bodyContains", value: "conversation-container" }],
      intervalSec: 43_200,
      enabled: true,
    })) as { id: string; name: string };

    expect(created.name).toBe("Gemini");
    const audit = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, created.id));
    expect(audit).toEqual([
      expect.objectContaining({
        action: "admin.service_check.create",
        targetType: "service_check",
      }),
    ]);
  });

  runDatabaseTest("changes only the field an update names", async () => {
    if (!database) return;
    const repository = subject();
    const created = (await repository.createServiceCheck(admin, {
      name: "Flow",
      probe,
      assertions: [{ type: "statusIn", statuses: [200] }],
      intervalSec: 600,
      enabled: true,
    })) as { id: string };

    await repository.updateServiceCheck(admin, created.id, { enabled: false });

    // The bug this guards against is not hypothetical: a partial built from a
    // DEFAULTED schema materialises every key, so "disable this check" would
    // also have reset the period to twelve hours and replaced the assertions.
    const [stored] = await database.db
      .select()
      .from(nodeServiceChecks)
      .where(eq(nodeServiceChecks.id, created.id));
    expect(stored).toMatchObject({
      enabled: false,
      intervalSec: 600,
      assertions: [{ type: "statusIn", statuses: [200] }],
    });
  });

  runDatabaseTest("answers 409 for a duplicate name, not 500", async () => {
    if (!database) return;
    const repository = subject();
    const definition = {
      name: "Gemini",
      probe,
      assertions: [{ type: "statusIn" as const, statuses: [200] }],
      intervalSec: 43_200,
      enabled: true,
    };
    await repository.createServiceCheck(admin, definition);

    // Two checks named "Gemini" would put two chips with different verdicts in
    // front of a user. Retyping a name is an ordinary mistake and deserves an
    // ordinary answer.
    await expect(
      repository.createServiceCheck(admin, definition),
    ).rejects.toMatchObject({ statusCode: 409, code: "CHECK_NAME_TAKEN" });
  });

  runDatabaseTest("run-now moves the marker rather than running anything", async () => {
    if (!database) return;
    const repository = subject();
    const created = (await repository.createServiceCheck(admin, {
      name: "Flow",
      probe,
      assertions: [{ type: "statusIn", statuses: [200] }],
      intervalSec: 43_200,
      enabled: true,
    })) as { id: string; nextDueAt: Date };

    const before = created.nextDueAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repository.runServiceCheckNow(admin, created.id);

    const [stored] = await database.db
      .select({ nextDueAt: nodeServiceChecks.nextDueAt })
      .from(nodeServiceChecks)
      .where(eq(nodeServiceChecks.id, created.id));
    expect(stored!.nextDueAt.getTime()).toBeGreaterThan(before.getTime());
  });

  runDatabaseTest("refuses to update or delete a check that is not there", async () => {
    if (!database) return;
    const repository = subject();
    const missing = "0b48cc4c-404b-47a6-af28-4cf15f305e30";
    await expect(
      repository.updateServiceCheck(admin, missing, { enabled: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      repository.deleteServiceCheck(admin, missing),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("PostgresControlRepository node status surfaces", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let actor: Actor;
  let nodeId: string;
  let checkId: string;

  const probe = {
    kind: "http" as const,
    url: "https://gemini.google.com/",
    method: "GET" as const,
    timeoutMs: 10_000,
  };

  beforeAll(async () => {
    if (!database) return;
    await database.db.delete(nodeServiceChecks);
    await database.db.delete(portalPolicy);
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret("label-secret", keyring, 1);
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: "status-node",
        apiBaseUrl: "http://127.0.0.1:4001",
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
    if (!node) throw new Error("Failed to seed node");
    nodeId = node.id;

    const [user] = await database.db
      .insert(users)
      .values({ email: "status-viewer@example.com" })
      .onConflictDoUpdate({ target: users.email, set: { status: "active" } })
      .returning();
    if (!user) throw new Error("Failed to seed user");
    actor = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "user",
      status: "active",
    };

    const [check] = await database.db
      .insert(nodeServiceChecks)
      .values({
        name: "Google Gemini",
        probe,
        assertions: [{ type: "statusIn", statuses: [200] }],
      })
      .returning();
    if (!check) throw new Error("Failed to seed check");
    checkId = check.id;
    await database.db.insert(nodeServiceCheckResults).values({
      nodeId,
      checkId,
      status: "failed",
      httpStatus: 200,
      latencyMs: 412,
      detail: 'body does not contain "conversation-container"',
      finalUrl: "https://gemini.google.com/",
      checkedAt: new Date(),
      failingSince: new Date(),
    });
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  const subject = () =>
    new PostgresControlRepository({ db: database!.db, keyring });

  /**
   * The node THIS suite seeded, found by id.
   *
   * `listNodes` returns every enabled node in the database, and the earlier
   * suites in this file leave theirs behind - so taking the first row asserted
   * against whichever name happened to sort first, which is a test that passes
   * or fails on the alphabet.
   */
  const seededNode = <T extends { id: string }>(rows: T[]): T => {
    const row = rows.find((candidate) => candidate.id === nodeId);
    if (!row) throw new Error("the seeded node is missing from the listing");
    return row;
  };

  runDatabaseTest("gives a user a name and a state, and nothing else", async () => {
    if (!database) return;
    const node = seededNode(
      (await subject().listNodes(actor)) as Array<{
        id: string;
        status?: { checks: Array<{ name: string; state: string }> };
        endpoint?: unknown;
      }>,
    );

    // The narrowing, asserted rather than described: `checks` and only `checks`.
    // A `state` key here would be a second vocabulary for node health, which
    // the panel already shows from enabled/lastError/lastHealthAt.
    expect(Object.keys(node.status ?? {})).toEqual(["checks"]);
    expect(node.status?.checks).toEqual([
      { name: "Google Gemini", state: "unavailable" },
    ]);
    // The handshake signal is an admin diagnostic and must not leak here.
    expect(node.endpoint).toBeUndefined();
  });

  runDatabaseTest("shows a user no detail, no URL and no HTTP status", async () => {
    if (!database) return;
    const node = seededNode(
      (await subject().listNodes(actor)) as Array<{
        id: string;
        status?: { checks: Array<Record<string, unknown>> };
      }>,
    );
    const payload = JSON.stringify(node);
    expect(payload).not.toContain("conversation-container");
    expect(payload).not.toContain("gemini.google.com");
    // Asserted on the chip's own KEYS rather than by searching the payload for
    // "412": a random uuid contains three-digit runs, so that search failed on
    // a node id and said nothing about latency.
    for (const chip of node.status?.checks ?? []) {
      expect(Object.keys(chip).sort()).toEqual(["name", "state"]);
    }
  });

  runDatabaseTest("omits status entirely when the policy says so", async () => {
    if (!database) return;
    await database.db.insert(portalPolicy).values({ showNodeStatus: false });
    const node = seededNode(
      (await subject().listNodes(actor)) as Array<{
        id: string;
        status?: unknown;
      }>,
    );
    // Absent, not empty: an empty array would render as a node with no checks,
    // which is a different statement from "this panel does not show them".
    expect("status" in node).toBe(false);
    await database.db.delete(portalPolicy);
  });

  runDatabaseTest("gives an admin the metrics row and the handshake signal", async () => {
    if (!database) return;
    await database.db.insert(nodeMetricsCurrent).values({
      nodeId,
      observedAt: new Date(),
      agentLatencyMs: 12,
      uptimeSec: 3_600,
      cpuCores: 2,
      memAvailableBytes: 361_267_200n,
    });

    const node = seededNode(
      (await subject().adminList({ ...actor, role: "admin" }, "nodes")) as Array<{
        id: string;
        metrics: { memAvailableBytes: unknown } | null;
        endpoint: { status: string; lastHandshakeAt: Date | null };
      }>,
    );

    // A STRING, and asserted as one. The previous version of this test wrote
    // String(...) around it, so it passed with a BigInt - and a BigInt is what
    // shipped, where JSON.stringify refuses it and the whole page 500s.
    expect(node.metrics?.memAvailableBytes).toBe("361267200");
    expect(typeof node.metrics?.memAvailableBytes).toBe("string");
    // The real test is that the payload can leave the process at all.
    expect(() => JSON.stringify(node)).not.toThrow();
    // No peer has ever handshaked on this node, so the honest answer is
    // "unknown" - not "stale", which would claim we once saw one.
    expect(node.endpoint).toEqual({
      status: "unknown",
      lastHandshakeAt: null,
    });
    await database.db.delete(nodeMetricsCurrent);
  });

  runDatabaseTest("persists the per-node service-check policy", async () => {
    if (!database) return;
    // The patch is built field by field in updateNode, so a field the schema
    // accepts and that block does not know is dropped in silence: the API
    // answers 200 and the CLI prints "updated" for a change that never
    // happened. Asserted against the ROW, not the response.
    const repository = subject();
    await repository.updateNode({ ...actor, role: "admin" }, nodeId, {
      checksEnabled: false,
      disabledCheckIds: ["11111111-1111-4111-8111-111111111111"],
    });
    const [stored] = await database.db
      .select({
        checksEnabled: nodes.checksEnabled,
        disabledCheckIds: nodes.disabledCheckIds,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    expect(stored).toEqual({
      checksEnabled: false,
      disabledCheckIds: ["11111111-1111-4111-8111-111111111111"],
    });

    // And back, so neither direction is one-way.
    await repository.updateNode({ ...actor, role: "admin" }, nodeId, {
      checksEnabled: true,
      disabledCheckIds: [],
    });
    const [restored] = await database.db
      .select({ checksEnabled: nodes.checksEnabled })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    expect(restored?.checksEnabled).toBe(true);
  });

  runDatabaseTest(
    "reads the handshake age on a node that actually has a peer",
    async () => {
      if (!database) return;
      // The case the other endpoint test could not reach: its node has no
      // peers, so `max(latest_handshake_at)` came back NULL and the branch that
      // reads the value was never taken. It threw in production the first time
      // an admin opened the page - a raw `sql` fragment gets no type parser, so
      // postgres-js returns a STRING and .getTime() is not a function on it.
      const [user] = await database.db
        .insert(users)
        .values({ email: "handshake-owner@example.com" })
        .onConflictDoUpdate({ target: users.email, set: { status: "active" } })
        .returning();
      if (!user) throw new Error("Failed to seed the key owner");
      const credentials = encryptSecret("cfg", keyring, 1);
      const [key] = await database.db
        .insert(vpnKeys)
        .values({
          ownerId: user.id,
          nodeId,
          nodeLabel: "handshake_probe",
          protocol: "awg3",
          state: "active",
          routeProfile: "full_tunnel",
          configCiphertext: credentials.ciphertext,
          configNonce: credentials.nonce,
          configAuthTag: credentials.authTag,
          configKeyVersion: credentials.keyVersion,
        })
        .returning();
      if (!key) throw new Error("Failed to seed the key");
      const handshake = new Date(Date.now() - 30_000);
      await database.db.insert(peerCurrent).values({
        keyId: key.id,
        online: true,
        latestHandshakeAt: handshake,
        receivedBytes: 0n,
        sentBytes: 0n,
        observedAt: new Date(),
      });

      const node = seededNode(
        (await subject().adminList({ ...actor, role: "admin" }, "nodes")) as Array<{
          id: string;
          endpoint: { status: string; lastHandshakeAt: Date | string | null };
        }>,
      );

      // 30 seconds is inside the 180-second window the node-agent's own
      // contract calls online.
      expect(node.endpoint.status).toBe("reachable");
      expect(node.endpoint.lastHandshakeAt).not.toBeNull();
      expect(new Date(node.endpoint.lastHandshakeAt!).getTime()).toBeCloseTo(
        handshake.getTime(),
        -3,
      );

      await database.db.delete(peerCurrent);
      await database.db.delete(vpnKeys);
    },
  );

  runDatabaseTest("calls a handshake older than the window stale", async () => {
    if (!database) return;
    const [user] = await database.db
      .insert(users)
      .values({ email: "handshake-owner@example.com" })
      .onConflictDoUpdate({ target: users.email, set: { status: "active" } })
      .returning();
    if (!user) throw new Error("Failed to seed the key owner");
    const credentials = encryptSecret("cfg", keyring, 1);
    const [key] = await database.db
      .insert(vpnKeys)
      .values({
        ownerId: user.id,
        nodeId,
        nodeLabel: "handshake_stale",
        protocol: "awg3",
        state: "active",
        routeProfile: "full_tunnel",
        configCiphertext: credentials.ciphertext,
        configNonce: credentials.nonce,
        configAuthTag: credentials.authTag,
        configKeyVersion: credentials.keyVersion,
      })
      .returning();
    if (!key) throw new Error("Failed to seed the key");
    await database.db.insert(peerCurrent).values({
      keyId: key.id,
      online: false,
      latestHandshakeAt: new Date(Date.now() - 10 * 60_000),
      receivedBytes: 0n,
      sentBytes: 0n,
      observedAt: new Date(),
    });

    const node = seededNode(
      (await subject().adminList({ ...actor, role: "admin" }, "nodes")) as Array<{
        id: string;
        endpoint: { status: string };
      }>,
    );
    // Stale, not unknown: we HAVE seen a handshake, it is simply old. Reporting
    // "unknown" there would throw away the one reachability fact we hold.
    expect(node.endpoint.status).toBe("stale");

    await database.db.delete(peerCurrent);
    await database.db.delete(vpnKeys);
  });

  runDatabaseTest("reports no metrics for a node that has never been polled", async () => {
    if (!database) return;
    const node = seededNode(
      (await subject().adminList({ ...actor, role: "admin" }, "nodes")) as Array<{
        id: string;
        metrics: unknown;
      }>,
    );
    // null, not an object of nulls: "we have never heard from this node" and
    // "this node reports nothing" are different, and the card says so.
    expect(node.metrics).toBeNull();
  });
});

describe("PostgresControlRepository revoke retries", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let nodeId: string;

  beforeAll(async () => {
    if (!database) return;
    await database.db.delete(portalPolicy);
    await database.db.insert(portalPolicy).values({});
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret("label-secret", keyring, 1);
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: "revoke-retry-node",
        apiBaseUrl: "http://127.0.0.1:4001",
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
    if (!node) throw new Error("Failed to seed node");
    nodeId = node.id;
  });

  beforeEach(async () => {
    if (!database) return;
    await database.db.delete(jobOutbox);
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  const subject = (): PostgresControlRepository => {
    if (!database) throw new Error("No database");
    return new PostgresControlRepository({ db: database.db, keyring });
  };

  /** An owner and one key of theirs, in the state under test. */
  const seedOwnedKey = async (
    state: "active" | "revoking",
  ): Promise<{ owner: Actor; keyId: string }> => {
    if (!database) throw new Error("No database");
    const suffix = randomBytes(6).toString("hex");
    const [user] = await database.db
      .insert(users)
      .values({ email: `revoke-retry-${suffix}@example.com` })
      .returning();
    if (!user) throw new Error("Failed to seed owner");
    const [key] = await database.db
      .insert(vpnKeys)
      .values({
        ownerId: user.id,
        nodeId,
        publicKey: `pk-${suffix}`,
        nodeLabel: `ap_retry_${suffix}`,
        protocol: "awg2",
        state,
        routeProfile: "full_tunnel",
      })
      .returning({ id: vpnKeys.id });
    if (!key) throw new Error("Failed to seed key");
    return {
      owner: {
        id: user.id,
        email: user.email,
        displayName: null,
        role: "user",
        status: "active",
      },
      keyId: key.id,
    };
  };

  const revokeJobsFor = async (keyId: string): Promise<number> => {
    if (!database) throw new Error("No database");
    const rows = await database.db
      .select({ payload: jobOutbox.payload })
      .from(jobOutbox)
      .where(eq(jobOutbox.type, "vpn-key.revoke"));
    return rows.filter((row) => row.payload.keyId === keyId).length;
  };

  runDatabaseTest(
    "lets the owner retry a revoke that is still stuck in revoking",
    async () => {
      if (!database) return;
      const { owner, keyId } = await seedOwnedKey("revoking");

      await subject().enqueueOwnRevoke(owner, keyId);

      expect(await revokeJobsFor(keyId)).toBe(1);
    },
  );

  runDatabaseTest(
    "queues a fresh job when the previous revoke attempt already failed",
    async () => {
      if (!database) return;
      const { owner, keyId } = await seedOwnedKey("active");

      await subject().enqueueOwnRevoke(owner, keyId);
      // The worker gave up on the first attempt: the row stays behind, failed.
      await database.db
        .update(jobOutbox)
        .set({ status: "failed", lastError: "node unreachable" });
      await subject().enqueueOwnRevoke(owner, keyId);

      // A deduplication key that never changed made the second insert a no-op,
      // so the user's retry was accepted and then did nothing at all.
      const pending = await database.db
        .select({ id: jobOutbox.id })
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.type, "vpn-key.revoke"),
            eq(jobOutbox.status, "pending"),
          ),
        );
      expect(pending).toHaveLength(1);
    },
  );

  runDatabaseTest(
    "lets an admin retry a revoke that is still stuck in revoking",
    async () => {
      if (!database) return;
      const { owner, keyId } = await seedOwnedKey("revoking");
      const admin: Actor = { ...owner, role: "admin" };

      await subject().adminAction(admin, "keys", keyId, "revoke", {});

      expect(await revokeJobsFor(keyId)).toBe(1);
    },
  );

  runDatabaseTest("still refuses to revoke an already revoked key", async () => {
    if (!database) return;
    const { owner, keyId } = await seedOwnedKey("active");
    await database.db
      .update(vpnKeys)
      .set({ state: "revoked" })
      .where(eq(vpnKeys.id, keyId));

    const failure = await failureOf(subject().enqueueOwnRevoke(owner, keyId));

    expect(failure?.code).toBe("KEY_NOT_FOUND");
    expect(await revokeJobsFor(keyId)).toBe(0);
  });
});

describe("PostgresControlRepository internal key name", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  // Distinctive enough that a substring search over a whole response body is a
  // real assertion rather than a coincidence.
  const internalName = "kochkina, replaced 04.09";
  let nodeId: string;
  let owner: Actor;
  let admin: Actor;
  let keyId: string;

  beforeAll(async () => {
    if (!database) return;
    await database.db.delete(portalPolicy);
    await database.db.insert(portalPolicy).values({});
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret("label-secret", keyring, 1);
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: "internal-name-node",
        publicName: "Internal Name Node",
        apiBaseUrl: "http://127.0.0.1:4001",
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
    if (!node) throw new Error("Failed to seed node");
    nodeId = node.id;
  });

  beforeEach(async () => {
    if (!database) return;
    const suffix = randomBytes(6).toString("hex");
    const [user] = await database.db
      .insert(users)
      .values({ email: `internal-name-${suffix}@example.com` })
      .returning();
    if (!user) throw new Error("Failed to seed owner");
    owner = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "user",
      status: "active",
    };
    admin = { ...owner, role: "admin" };
    const config = encryptSecret("vpn://stored-config", keyring, 1);
    const [key] = await database.db
      .insert(vpnKeys)
      .values({
        ownerId: user.id,
        nodeId,
        publicKey: `pk-${suffix}`,
        nodeLabel: `ap_internal_${suffix}`,
        protocol: "awg2",
        state: "active",
        routeProfile: "full_tunnel",
        deviceLabel: "Laptop",
        configCiphertext: config.ciphertext,
        configNonce: config.nonce,
        configAuthTag: config.authTag,
        configKeyVersion: config.keyVersion,
      })
      .returning({ id: vpnKeys.id });
    if (!key) throw new Error("Failed to seed key");
    keyId = key.id;
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  const subject = (): PostgresControlRepository => {
    if (!database) throw new Error("No database");
    return new PostgresControlRepository({ db: database.db, keyring });
  };

  const storedInternalName = async (): Promise<string | null> => {
    if (!database) throw new Error("No database");
    const [row] = await database.db
      .select({ internalName: vpnKeys.internalName })
      .from(vpnKeys)
      .where(eq(vpnKeys.id, keyId));
    return row?.internalName ?? null;
  };

  runDatabaseTest(
    "persists the internal name and never leaks it to the owner",
    async () => {
      if (!database) return;
      await subject().adminAction(admin, "keys", keyId, "set-internal-name", {
        internalName,
      });

      // Asserted against the ROW, not the response. An update path built field
      // by field answers 200 for a column it silently drops, and a test that
      // read the response body would have passed with that bug (see PR #49).
      expect(await storedInternalName()).toBe(internalName);

      const ownerView = await subject().listKeys(owner);
      expect(JSON.stringify(ownerView)).not.toContain("kochkina");
    },
  );

  runDatabaseTest("shows the internal name to admins", async () => {
    if (!database) return;
    await subject().adminAction(admin, "keys", keyId, "set-internal-name", {
      internalName,
    });

    const rows = (await subject().adminList(admin, "keys")) as Array<{
      id: string;
      internalName?: string | null;
    }>;
    expect(rows.find((row) => row.id === keyId)?.internalName).toBe(
      internalName,
    );
  });

  runDatabaseTest("clears the internal name when given an empty one", async () => {
    if (!database) return;
    await subject().adminAction(admin, "keys", keyId, "set-internal-name", {
      internalName,
    });

    await subject().adminAction(admin, "keys", keyId, "set-internal-name", {
      internalName: "",
    });

    expect(await storedInternalName()).toBeNull();
  });

  runDatabaseTest(
    "deletes a revoked key from the panel, row and pending jobs alike",
    async () => {
      if (!database) return;
      await database.db
        .update(vpnKeys)
        .set({ state: "revoked", revokedAt: new Date() })
        .where(eq(vpnKeys.id, keyId));
      // A job the worker never got to. job_outbox does not reference vpn_keys,
      // so nothing cascades it away, and a leftover row makes the worker retry
      // for a key that no longer exists.
      await database.db.insert(jobOutbox).values({
        type: "vpn-key.revoke",
        deduplicationKey: `vpn-key.revoke:${keyId}:purge-test`,
        payload: { keyId },
      });

      await subject().adminAction(admin, "keys", keyId, "purge", {});

      const rows = await database.db
        .select({ id: vpnKeys.id })
        .from(vpnKeys)
        .where(eq(vpnKeys.id, keyId));
      expect(rows).toHaveLength(0);
      const jobs = await database.db
        .select({ id: jobOutbox.id })
        .from(jobOutbox)
        .where(sql`${jobOutbox.payload} ->> 'keyId' = ${keyId}`);
      expect(jobs).toHaveLength(0);
    },
  );

  // The row is the only thing that remembers the peer's label, and reconcile
  // finds an orphan by that label. Deleting it while the node may still carry
  // the peer strands the peer for good.
  runDatabaseTest(
    "refuses every state where the node may still carry the peer",
    async () => {
      if (!database) return;
      const states = [
        "provisioning",
        "active",
        "disabled",
        "revoking",
        "failed",
      ] as const;

      for (const state of states) {
        await database.db
          .update(vpnKeys)
          .set({ state })
          .where(eq(vpnKeys.id, keyId));

        await expect(
          subject().adminAction(admin, "keys", keyId, "purge", {}),
        ).rejects.toMatchObject({ statusCode: 409, code: "KEY_NOT_PURGEABLE" });

        const rows = await database.db
          .select({ id: vpnKeys.id })
          .from(vpnKeys)
          .where(eq(vpnKeys.id, keyId));
        expect(rows, `a ${state} key must survive`).toHaveLength(1);
      }
    },
  );

  runDatabaseTest("records what the key was, since the row will not exist", async () => {
    if (!database) return;
    await database.db
      .update(vpnKeys)
      .set({ state: "revoked", internalName: internalName })
      .where(eq(vpnKeys.id, keyId));

    await subject().adminAction(admin, "keys", keyId, "purge", {});

    const [event] = await database.db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "admin.keys.purge"),
          eq(auditEvents.targetId, keyId),
        ),
      );
    expect(event?.metadata).toMatchObject({
      nodeId,
      deviceLabel: "Laptop",
      internalName,
    });
  });

  runDatabaseTest("keeps the internal name out of config generation", async () => {
    if (!database) return;
    await subject().adminAction(admin, "keys", keyId, "set-internal-name", {
      internalName,
    });

    // Everything the config path is given about a key. The name the client
    // shows is built from `deviceLabel` and the node's name; the operator's
    // note must not be reachable from here at all.
    const stored = await subject().findKeyConfig(keyId);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("kochkina");
  });

  runDatabaseTest("refuses a name longer than the column", async () => {
    if (!database) return;
    const failure = await failureOf(
      subject().adminAction(admin, "keys", keyId, "set-internal-name", {
        internalName: "x".repeat(81),
      }),
    );

    expect(failure).not.toBeNull();
    expect(await storedInternalName()).toBeNull();
  });

  runDatabaseTest("records who renamed the key", async () => {
    if (!database) return;
    await subject().adminAction(admin, "keys", keyId, "set-internal-name", {
      internalName,
    });

    const events = await database.db
      .select({ action: auditEvents.action, actorUserId: auditEvents.actorUserId })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, keyId));
    expect(events).toContainEqual({
      action: "admin.keys.set-internal-name",
      actorUserId: admin.id,
    });
  });
});

describe("PostgresControlRepository Access sync arming", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  let admin: Actor;

  beforeAll(async () => {
    if (!database) return;
    await database.db.delete(portalPolicy);
    await database.db.insert(portalPolicy).values({});
  });

  beforeEach(async () => {
    if (!database) return;
    await database.db
      .delete(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, "access.sync"));
    const suffix = randomBytes(6).toString("hex");
    const [user] = await database.db
      .insert(users)
      .values({ email: `access-sync-admin-${suffix}@example.com`, role: "admin" })
      .returning();
    if (!user) throw new Error("Failed to seed admin");
    admin = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "admin",
      status: "active",
    };
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  const subject = (): PostgresControlRepository => {
    if (!database) throw new Error("No database");
    return new PostgresControlRepository({ db: database.db, keyring });
  };

  const readAccessSyncRow = async () => {
    if (!database) throw new Error("No database");
    const [row] = await database.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, "access.sync"));
    return row;
  };

  runDatabaseTest(
    "arms the Access sync when an admin creates, offboards or reinstates a user",
    async () => {
      if (!database) return;
      const repository = subject();
      const created = (await repository.createUser(admin, {
        email: `access-sync-user-${randomBytes(6).toString("hex")}@example.com`,
        role: "user",
      })) as { id: string };

      const afterCreate = await readAccessSyncRow();
      expect(afterCreate).not.toBeUndefined();

      const beforeOffboard = afterCreate!.payload.armId;
      await repository.adminAction(admin, "users", created.id, "offboard", {});
      const afterOffboard = await readAccessSyncRow();
      expect(afterOffboard!.payload.armId).not.toBe(beforeOffboard);

      const beforeReinstate = afterOffboard!.payload.armId;
      await repository.adminAction(admin, "users", created.id, "reinstate", {});
      const afterReinstate = await readAccessSyncRow();
      expect(afterReinstate!.payload.armId).not.toBe(beforeReinstate);
    },
  );

  runDatabaseTest(
    "does not arm the Access sync for changes the policy cannot see",
    async () => {
      if (!database) return;
      const repository = subject();
      const created = (await repository.createUser(admin, {
        email: `access-sync-user-${randomBytes(6).toString("hex")}@example.com`,
        role: "user",
      })) as { id: string };
      // The row exists because the create above armed it -- control-api has no
      // public arm method, the helper is private and joins a transaction.
      const before = (await readAccessSyncRow())!.payload.armId;
      await repository.adminAction(admin, "users", created.id, "set-role", {
        role: "admin",
      });
      const after = (await readAccessSyncRow())!.payload.armId;
      expect(after).toBe(before);
    },
  );

  // The field set is the business rule at the centre of this gate: exercising
  // two of its members (not just one) is what would catch a future edit that
  // drops a field from CF_ACCESS_CONFIG_FIELDS without anyone noticing.
  runDatabaseTest(
    "arms the Access sync when a portal-policy update names a Cloudflare configuration field",
    async () => {
      if (!database) return;
      const repository = subject();
      expect(await readAccessSyncRow()).toBeUndefined();

      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAccountId: "cf-account-placeholder",
      });
      const afterAccountId = await readAccessSyncRow();
      expect(afterAccountId).not.toBeUndefined();

      const beforeToken = afterAccountId!.payload.armId;
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfApiToken: "cf-api-token-placeholder",
      });
      const afterToken = await readAccessSyncRow();
      expect(afterToken!.payload.armId).not.toBe(beforeToken);
    },
  );

  runDatabaseTest(
    "arms the Access sync when the domain list is named",
    async () => {
      if (!database) return;
      const repository = subject();
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAccountId: "cf-account-placeholder",
      });
      const before = (await readAccessSyncRow())!.payload.armId;

      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAllowedDomains: ["company.tld"],
      });
      const after = (await readAccessSyncRow())!.payload.armId;
      expect(after).not.toBe(before);
    },
  );

  runDatabaseTest(
    "does not arm the Access sync for a portal-policy update that names no Cloudflare configuration field",
    async () => {
      if (!database) return;
      const repository = subject();
      // Arm a baseline row first so the marker has something to stay equal
      // to -- comparing against "no row" would make this assertion vacuous.
      await repository.adminAction(admin, "portal-policy", "global", "update", {
        cfAccessAccountId: "cf-account-placeholder",
      });
      const before = (await readAccessSyncRow())!.payload.armId;

      await repository.adminAction(admin, "portal-policy", "global", "update", {
        defaultKeyLimit: 9,
      });
      const after = (await readAccessSyncRow())!.payload.armId;
      expect(after).toBe(before);
    },
  );

  const latestRunAudit = async () => {
    if (!database) throw new Error("No database");
    const [event] = await database.db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, admin.id),
          eq(auditEvents.action, "admin.access-sync.run"),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    return event;
  };

  runDatabaseTest(
    "the run action arms with the operator reason and reports whether a run was already under way",
    async () => {
      if (!database) return;
      const repository = subject();
      expect(await readAccessSyncRow()).toBeUndefined();

      // Idle (no row at all) -> not already running.
      await repository.adminAction(admin, "access-sync", "global", "run", {});
      const armed = await readAccessSyncRow();
      expect(armed!.payload.reason).toBe("operator");
      expect((await latestRunAudit())?.metadata).toMatchObject({
        alreadyRunning: false,
      });

      // The arm above leaves the row "pending" -> a second click coalesces
      // into the run already on its way.
      await repository.adminAction(admin, "access-sync", "global", "run", {});
      expect((await latestRunAudit())?.metadata).toMatchObject({
        alreadyRunning: true,
      });

      // Simulate the worker having finished the run.
      await database.db
        .update(jobOutbox)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(jobOutbox.deduplicationKey, "access.sync"));
      await repository.adminAction(admin, "access-sync", "global", "run", {});
      expect((await latestRunAudit())?.metadata).toMatchObject({
        alreadyRunning: false,
      });

      // Simulate a run that is already mid-flight (locked by the poller).
      await database.db
        .update(jobOutbox)
        .set({ status: "processing" })
        .where(eq(jobOutbox.deduplicationKey, "access.sync"));
      await repository.adminAction(admin, "access-sync", "global", "run", {});
      expect((await latestRunAudit())?.metadata).toMatchObject({
        alreadyRunning: true,
      });
    },
  );

  runDatabaseTest(
    "getAccessSyncStatus reports idle with no row and maps a real row's fields",
    async () => {
      if (!database) return;
      const repository = subject();
      expect(await repository.getAccessSyncStatus()).toEqual(idleAccessSyncStatus);

      const requestedAt = new Date("2026-01-01T00:00:00.000Z");
      const completedAt = new Date("2026-01-01T00:05:00.000Z");
      await database.db.insert(jobOutbox).values({
        type: "access.sync",
        deduplicationKey: "access.sync",
        payload: {
          requestedAt: requestedAt.toISOString(),
          armId: "status-read-test-arm-id",
          reason: "operator",
        },
        status: "failed",
        availableAt: requestedAt,
        completedAt,
        lastError: "Cloudflare API request timed out",
      });

      expect(await repository.getAccessSyncStatus()).toEqual({
        status: "failed",
        queuedAt: requestedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        lastError: "Cloudflare API request timed out",
      });
    },
  );
});
