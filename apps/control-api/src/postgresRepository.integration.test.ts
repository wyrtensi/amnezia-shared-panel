import { randomBytes } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultKeyNameDisplay } from "@amnezia/contracts";
import type { KeyLimitMode } from "@amnezia/contracts";
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
});
