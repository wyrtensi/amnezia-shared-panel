import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BRIDGE_AGENT_UPDATE_JOB_TYPE,
  bridgeAgentUpdateDeduplicationKey,
} from "@amnezia/contracts";
import {
  auditEvents,
  bridgeAgentReleases,
  createDatabase,
  encryptSecret,
  jobOutbox,
  users,
  vpnBridgeAgentUpdates,
  vpnBridges,
} from "@amnezia/db";

import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const runTag = randomBytes(3).toString("hex");
const APPROVED = `ghcr.io/example-${runTag}/repo/bridge-agent`;
const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe("bridge-agent update requests (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const bridgeIds: string[] = [];
  const userIds: string[] = [];
  let admin: Actor;
  let ipCounter = 0;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  const repositoryFor = (jobsEnabled: boolean, repository: string | undefined = APPROVED) =>
    new PostgresControlRepository({
      db: db(),
      keyring,
      activeKeyVersion: 1,
      bridgeAgentImageRepository: repository,
      bridgeJobsEnabled: jobsEnabled,
    });

  /** A bridge, enrolled with an agent that reports the given capabilities. */
  const addBridge = async (
    options: { enrolled?: boolean; capabilities?: string[] } = {},
  ) => {
    ipCounter += 1;
    const [bridge] = await db()
      .insert(vpnBridges)
      .values({
        name: `Update ${runTag} ${ipCounter}`,
        publicIpv4: `47.${parseInt(runTag, 16) & 0xff}.${ipCounter}.9`,
        managementStatus: "ok",
        ...(options.enrolled === false
          ? {}
          : (() => {
              const credential = encryptSecret("k".repeat(40), keyring, 1);
              return {
                managementApiUrl: "http://host.docker.internal:7605",
                managementCredentialCiphertext: credential.ciphertext,
                managementCredentialNonce: credential.nonce,
                managementCredentialAuthTag: credential.authTag,
                managementCredentialKeyVersion: credential.keyVersion,
                managementEnrolledAt: new Date(),
                agentVersion: "0.1.0",
                agentCapabilities: options.capabilities ?? ["status.v1", "update.v1"],
              };
            })()),
      })
      .returning();
    if (!bridge) throw new Error("Failed to seed bridge");
    bridgeIds.push(bridge.id);
    return bridge;
  };

  const release = async (digestValue: string, repository = APPROVED) => {
    await db()
      .insert(bridgeAgentReleases)
      .values({ repository, version: "0.2.0", digest: digestValue, resolvedAt: new Date() })
      .onConflictDoUpdate({
        target: bridgeAgentReleases.repository,
        set: { digest: digestValue },
      });
  };

  const operations = (bridgeId: string) =>
    db().select().from(vpnBridgeAgentUpdates).where(eq(vpnBridgeAgentUpdates.bridgeId, bridgeId));
  const jobsOf = async (operationIds: string[]) =>
    operationIds.length === 0
      ? []
      : db()
          .select()
          .from(jobOutbox)
          .where(
            inArray(
              jobOutbox.deduplicationKey,
              operationIds.map((id) => bridgeAgentUpdateDeduplicationKey(id)),
            ),
          );

  beforeAll(async () => {
    if (!database) return;
    const [user] = await database.db
      .insert(users)
      .values({ email: `bridge-update-${runTag}@example.com`, role: "admin" })
      .returning();
    if (!user) throw new Error("Failed to seed admin");
    userIds.push(user.id);
    admin = { id: user.id, email: user.email, displayName: null, role: "admin", status: "active" };
  });

  afterEach(async () => {
    if (!database) return;
    if (bridgeIds.length > 0) {
      const rows = await db()
        .select({ id: vpnBridgeAgentUpdates.id })
        .from(vpnBridgeAgentUpdates)
        .where(inArray(vpnBridgeAgentUpdates.bridgeId, bridgeIds));
      if (rows.length > 0) {
        await db()
          .delete(jobOutbox)
          .where(
            inArray(
              jobOutbox.deduplicationKey,
              rows.map((row) => bridgeAgentUpdateDeduplicationKey(row.id)),
            ),
          );
      }
      await db().delete(vpnBridges).where(inArray(vpnBridges.id, bridgeIds));
    }
    bridgeIds.length = 0;
    await db().delete(bridgeAgentReleases).where(eq(bridgeAgentReleases.repository, APPROVED));
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.delete(auditEvents).where(inArray(auditEvents.actorUserId, userIds));
    await database.db.delete(users).where(inArray(users.id, userIds));
    await database.client.end();
  });

  runDatabaseTest("previews the installed version, the offered image and no operation", async () => {
    await release(digest("a"));
    const bridge = await addBridge();
    const view = await repositoryFor(true).getBridgeAgentUpdate(admin, bridge.id);
    expect(view).toEqual({
      bridgeId: bridge.id,
      enrolled: true,
      installedVersion: "0.1.0",
      updateSupported: true,
      jobsEnabled: true,
      offered: [
        { image: `${APPROVED}@${digest("a")}`, repository: APPROVED, version: "0.2.0", digest: digest("a") },
      ],
      operation: null,
      history: [],
    });
    const listed = (await repositoryFor(true).listBridges(admin)).find((item) => item.id === bridge.id);
    expect(listed?.agentUpdate).toMatchObject({ updateSupported: true, operation: null });
    expect(listed?.agentUpdate?.offered?.digest).toBe(digest("a"));
  });

  runDatabaseTest("an unknown bridge is a 404 for both routes", async () => {
    await expect(repositoryFor(true).getBridgeAgentUpdate(admin, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
      code: "BRIDGE_NOT_FOUND",
    });
    await expect(
      repositoryFor(true).requestBridgeAgentUpdate(admin, randomUUID(), { imageDigest: digest("a") }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BRIDGE_NOT_FOUND" });
  });

  runDatabaseTest("a closed VPN_BRIDGE_JOBS_ENABLED gate queues nothing", async () => {
    await release(digest("a"));
    const bridge = await addBridge();
    await expect(
      repositoryFor(false).requestBridgeAgentUpdate(admin, bridge.id, { imageDigest: digest("a") }),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRIDGE_JOBS_DISABLED" });
    expect(await operations(bridge.id)).toHaveLength(0);
    const view = await repositoryFor(false).getBridgeAgentUpdate(admin, bridge.id);
    expect(view.jobsEnabled).toBe(false);
  });

  runDatabaseTest("refuses a digest the panel does not offer", async () => {
    await release(digest("a"));
    const bridge = await addBridge();
    for (const imageDigest of [digest("b"), digest("0")]) {
      await expect(
        repositoryFor(true).requestBridgeAgentUpdate(admin, bridge.id, { imageDigest }),
      ).rejects.toMatchObject({ statusCode: 400, code: "BRIDGE_UPDATE_NOT_OFFERED" });
    }
    // Nothing resolved, or another repository configured: nothing is offered.
    await expect(
      repositoryFor(true, `ghcr.io/example-${runTag}/other/bridge-agent`).requestBridgeAgentUpdate(
        admin,
        bridge.id,
        { imageDigest: digest("a") },
      ),
    ).rejects.toMatchObject({ code: "BRIDGE_UPDATE_NOT_OFFERED" });
    expect(await operations(bridge.id)).toHaveLength(0);
  });

  runDatabaseTest("needs an enrolled bridge whose agent reports update.v1", async () => {
    await release(digest("a"));
    const pending = await addBridge({ enrolled: false });
    await expect(
      repositoryFor(true).requestBridgeAgentUpdate(admin, pending.id, { imageDigest: digest("a") }),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRIDGE_UPDATE_NOT_ENROLLED" });
    const legacy = await addBridge({ capabilities: ["status.v1"] });
    await expect(
      repositoryFor(true).requestBridgeAgentUpdate(admin, legacy.id, { imageDigest: digest("a") }),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRIDGE_UNSUPPORTED_CAPABILITY" });
    const view = await repositoryFor(true).getBridgeAgentUpdate(admin, legacy.id);
    expect(view.updateSupported).toBe(false);
    expect(await operations(pending.id)).toHaveLength(0);
    expect(await operations(legacy.id)).toHaveLength(0);
  });

  runDatabaseTest(
    "queues one operation with a stable id in the outbox and an audit event",
    async () => {
      await release(digest("a"));
      const bridge = await addBridge();
      const repository = repositoryFor(true);
      const result = await repository.requestBridgeAgentUpdate(admin, bridge.id, {
        imageDigest: digest("a"),
      });
      expect(result.created).toBe(true);
      expect(result.operation).toMatchObject({
        state: "queued",
        requestedDigest: digest("a"),
        requestedVersion: "0.2.0",
        fromVersion: "0.1.0",
        result: null,
        contactLostSince: null,
      });
      const operationId = result.operation.operationId;
      const [job] = await jobsOf([operationId]);
      expect(job).toMatchObject({
        type: BRIDGE_AGENT_UPDATE_JOB_TYPE,
        deduplicationKey: `bridge_agent.update:${operationId}`,
        status: "pending",
        payload: { bridgeId: bridge.id, operationId },
      });
      const audit = await db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.targetId, bridge.id));
      const requested = audit.find((event) => event.action === "vpn_bridge.agent_update_requested");
      expect(requested).toMatchObject({
        actorUserId: admin.id,
        metadata: {
          operationId,
          imageRepository: APPROVED,
          imageDigest: digest("a"),
          fromVersion: "0.1.0",
        },
      });
      // Not the credential, not the management URL.
      expect(JSON.stringify(requested?.metadata)).not.toMatch(/host\.docker|key/i);

      const view = await repository.getBridgeAgentUpdate(admin, bridge.id);
      expect(view.operation?.operationId).toBe(operationId);
      const listed = (await repository.listBridges(admin)).find((item) => item.id === bridge.id);
      expect(listed?.agentUpdate?.operation?.operationId).toBe(operationId);
    },
  );

  runDatabaseTest(
    "repeating the outstanding request returns it; another digest meanwhile is a 409; two at once make one",
    async () => {
      await release(digest("a"));
      const bridge = await addBridge();
      const repository = repositoryFor(true);
      const [first, second] = await Promise.all([
        repository.requestBridgeAgentUpdate(admin, bridge.id, { imageDigest: digest("a") }),
        repository.requestBridgeAgentUpdate(admin, bridge.id, { imageDigest: digest("a") }),
      ]);
      expect(first.operation.operationId).toBe(second.operation.operationId);
      expect([first.created, second.created].sort()).toEqual([false, true]);

      const again = await repository.requestBridgeAgentUpdate(admin, bridge.id, {
        imageDigest: digest("a"),
      });
      expect(again).toMatchObject({ created: false });
      expect(again.operation.operationId).toBe(first.operation.operationId);

      await expect(
        repository.requestBridgeAgentUpdate(admin, bridge.id, { imageDigest: digest("b") }),
      ).rejects.toMatchObject({ statusCode: 409, code: "BRIDGE_UPDATE_IN_PROGRESS" });

      const rows = await operations(bridge.id);
      expect(rows).toHaveLength(1);
      expect(await jobsOf(rows.map((row) => row.id))).toHaveLength(1);
      const audit = await db().select().from(auditEvents).where(eq(auditEvents.targetId, bridge.id));
      expect(audit.filter((event) => event.action === "vpn_bridge.agent_update_requested")).toHaveLength(1);
    },
  );

  runDatabaseTest(
    "PostgreSQL itself allows one outstanding operation per bridge, and a finished one frees the slot",
    async () => {
      await release(digest("a"));
      const bridge = await addBridge();
      const base = {
        bridgeId: bridge.id,
        imageRepository: APPROVED,
        imageDigest: digest("a"),
      };
      await db().insert(vpnBridgeAgentUpdates).values({ id: randomUUID(), ...base, state: "running" });
      await expect(
        db().insert(vpnBridgeAgentUpdates).values({ id: randomUUID(), ...base }),
      ).rejects.toThrow();
      // History is unlimited: terminal rows do not hold the slot.
      await db().update(vpnBridgeAgentUpdates).set({ state: "rolled_back", finishedAt: new Date() }).where(eq(vpnBridgeAgentUpdates.bridgeId, bridge.id));
      await db().insert(vpnBridgeAgentUpdates).values({ id: randomUUID(), ...base, state: "pickup_timeout" });
      await db().insert(vpnBridgeAgentUpdates).values({ id: randomUUID(), ...base });
      await expect(db().insert(vpnBridgeAgentUpdates).values({ id: randomUUID(), ...base })).rejects.toThrow();
    },
  );

  runDatabaseTest("after a finished or timed-out operation a new request is a new operation", async () => {
    await release(digest("a"));
    const bridge = await addBridge();
    const repository = repositoryFor(true);
    const first = await repository.requestBridgeAgentUpdate(admin, bridge.id, { imageDigest: digest("a") });
    await db()
      .update(vpnBridgeAgentUpdates)
      .set({ state: "pickup_timeout", errorCode: "UPDATE_NOT_ACKNOWLEDGED", finishedAt: new Date() })
      .where(eq(vpnBridgeAgentUpdates.id, first.operation.operationId));
    const view = await repository.getBridgeAgentUpdate(admin, bridge.id);
    expect(view.operation).toMatchObject({
      state: "pickup_timeout",
      errorCode: "UPDATE_NOT_ACKNOWLEDGED",
      result: { errorCode: "UPDATE_NOT_ACKNOWLEDGED" },
    });
    const second = await repository.requestBridgeAgentUpdate(admin, bridge.id, { imageDigest: digest("a") });
    expect(second.created).toBe(true);
    expect(second.operation.operationId).not.toBe(first.operation.operationId);
    const after = await repository.getBridgeAgentUpdate(admin, bridge.id);
    expect(after.operation?.operationId).toBe(second.operation.operationId);
    expect(after.history.map((item) => item.operationId)).toEqual([first.operation.operationId]);
  });
});
