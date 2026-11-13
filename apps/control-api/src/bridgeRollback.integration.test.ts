import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BRIDGE_AGENT_POLL_JOB_TYPE,
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  bridgeRollbackPreflightSchema,
} from "@amnezia/contracts";
import {
  auditEvents,
  bridgeAgentReleases,
  createDatabase,
  encryptSecret,
  jobOutbox,
  nodes,
  users,
  vpnBridgeAgentUpdates,
  vpnBridgeRoutes,
  vpnBridges,
} from "@amnezia/db";

import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const runTag = randomBytes(3).toString("hex");
const APPROVED = `ghcr.io/example-${runTag}/repo/bridge-agent`;

describe("bridge rollback preflight (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const bridgeIds: string[] = [];
  const nodeIds: string[] = [];
  const userIds: string[] = [];
  const jobKeys: string[] = [];
  let admin: Actor;
  let counter = 0;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };
  const repository = (jobsEnabled: boolean) =>
    new PostgresControlRepository({
      db: db(),
      keyring,
      activeKeyVersion: 1,
      bridgeAgentImageRepository: APPROVED,
      bridgeJobsEnabled: jobsEnabled,
    });

  const seedBridge = async () => {
    counter += 1;
    const credential = encryptSecret("k".repeat(40), keyring, 1);
    const [bridge] = await db()
      .insert(vpnBridges)
      .values({
        name: `Rollback ${runTag} ${counter}`,
        publicIpv4: `48.${parseInt(runTag, 16) & 0xff}.${counter}.9`,
        managementStatus: "ok",
        managementApiUrl: "http://host.docker.internal:7605",
        managementCredentialCiphertext: credential.ciphertext,
        managementCredentialNonce: credential.nonce,
        managementCredentialAuthTag: credential.authTag,
        managementCredentialKeyVersion: credential.keyVersion,
        managementEnrolledAt: new Date(),
        agentVersion: "0.1.0",
        agentCapabilities: ["status.v1", "update.v1"],
      })
      .returning();
    if (!bridge) throw new Error("Failed to seed bridge");
    bridgeIds.push(bridge.id);
    return bridge;
  };

  const seedNode = async () => {
    counter += 1;
    const credentials = encryptSecret("api-key", keyring, 1);
    const labelSecret = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `rollback-${runTag}-${counter}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        protocol: "awg3",
        capabilities: {},
        credentialsCiphertext: credentials.ciphertext,
        credentialsNonce: credentials.nonce,
        credentialsAuthTag: credentials.authTag,
        credentialsKeyVersion: credentials.keyVersion,
        labelSecretCiphertext: labelSecret.ciphertext,
        labelSecretNonce: labelSecret.nonce,
        labelSecretAuthTag: labelSecret.authTag,
        labelSecretKeyVersion: labelSecret.keyVersion,
      })
      .returning();
    if (!node) throw new Error("Failed to seed node");
    nodeIds.push(node.id);
    return node.id;
  };

  const seedRoute = async (
    bridgeId: string,
    nodeId: string,
    state: "draft" | "active",
    publicUdpPort: number,
  ) => {
    const id = randomUUID();
    await db()
      .insert(vpnBridgeRoutes)
      .values({ id, nodeId, bridgeId, publicUdpPort, state, frpProxyName: `awg-route-${id}` });
    return id;
  };

  const seedJob = async (type: string, status: "pending" | "processing" | "completed") => {
    const key = `${type}:${runTag}:${randomUUID()}`;
    jobKeys.push(key);
    await db().insert(jobOutbox).values({ type, deduplicationKey: key, payload: {}, status });
  };

  beforeAll(async () => {
    if (!database) return;
    const [user] = await database.db
      .insert(users)
      .values({ email: `bridge-rollback-${runTag}@example.com`, role: "admin" })
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
      for (const row of rows) jobKeys.push(`bridge_agent.update:${row.id}`);
      await db().delete(vpnBridgeRoutes).where(inArray(vpnBridgeRoutes.bridgeId, bridgeIds));
    }
    if (jobKeys.length > 0) {
      await db().delete(jobOutbox).where(inArray(jobOutbox.deduplicationKey, jobKeys));
    }
    jobKeys.length = 0;
    if (bridgeIds.length > 0) await db().delete(vpnBridges).where(inArray(vpnBridges.id, bridgeIds));
    if (nodeIds.length > 0) await db().delete(nodes).where(inArray(nodes.id, nodeIds));
    bridgeIds.length = 0;
    nodeIds.length = 0;
    await db().delete(bridgeAgentReleases).where(eq(bridgeAgentReleases.repository, APPROVED));
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.delete(auditEvents).where(inArray(auditEvents.actorUserId, userIds));
    await database.db.delete(users).where(inArray(users.id, userIds));
    await database.client.end();
  });

  runDatabaseTest("counts only what blocks a rollback and matches the contract", async () => {
    const repo = repository(true);
    const baseline = await repo.getBridgeRollbackPreflight(admin);
    expect(bridgeRollbackPreflightSchema.parse(baseline)).toEqual(baseline);
    expect(baseline.jobsEnabled).toBe(true);

    const bridge = await seedBridge();
    const activeNode = await seedNode();
    const draftNode = await seedNode();
    await seedRoute(bridge.id, activeNode, "active", 41000);
    // A draft holds a port but serves nobody: not an assignment.
    await seedRoute(bridge.id, draftNode, "draft", 41001);
    await seedJob(BRIDGE_AGENT_POLL_JOB_TYPE, "pending");
    await seedJob(BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE, "processing");
    // Finished and unrelated jobs never block.
    await seedJob(BRIDGE_AGENT_POLL_JOB_TYPE, "completed");
    await seedJob("node.agent-update", "pending");

    const result = await repo.getBridgeRollbackPreflight(admin);
    expect(result.activeAssignments.nodeIds).toContain(activeNode);
    expect(result.activeAssignments.nodeIds).not.toContain(draftNode);
    expect(result.activeAssignments.count).toBe(baseline.activeAssignments.count + 1);
    expect(result.pendingJobs.count).toBe(baseline.pendingJobs.count + 2);
    expect(result.pendingJobs.byType[BRIDGE_AGENT_POLL_JOB_TYPE]).toBe(
      (baseline.pendingJobs.byType[BRIDGE_AGENT_POLL_JOB_TYPE] ?? 0) + 1,
    );
    expect(result.pendingJobs.byType["node.agent-update"]).toBeUndefined();
    expect(result.readyForPreBridgeRollback).toBe(false);
  });

  runDatabaseTest("an outstanding bridge-agent update blocks until it is terminal", async () => {
    const repo = repository(true);
    const baseline = await repo.getBridgeRollbackPreflight(admin);
    const bridge = await seedBridge();
    const digest = `sha256:${"b".repeat(64)}`;
    await db()
      .insert(bridgeAgentReleases)
      .values({ repository: APPROVED, version: "0.2.0", digest, resolvedAt: new Date() });
    const { operation } = await repo.requestBridgeAgentUpdate(admin, bridge.id, {
      imageDigest: digest,
    });

    const blocked = await repo.getBridgeRollbackPreflight(admin);
    expect(blocked.outstandingAgentUpdates.bridgeIds).toContain(bridge.id);
    expect(blocked.outstandingAgentUpdates.count).toBe(baseline.outstandingAgentUpdates.count + 1);
    // The queued update job counts too.
    expect(blocked.pendingJobs.byType["bridge_agent.update"]).toBe(
      (baseline.pendingJobs.byType["bridge_agent.update"] ?? 0) + 1,
    );
    expect(blocked.readyForPreBridgeRollback).toBe(false);

    await db()
      .update(vpnBridgeAgentUpdates)
      .set({ state: "succeeded" })
      .where(eq(vpnBridgeAgentUpdates.id, operation.operationId));
    await db()
      .update(jobOutbox)
      .set({ status: "completed" })
      .where(eq(jobOutbox.deduplicationKey, `bridge_agent.update:${operation.operationId}`));
    const cleared = await repo.getBridgeRollbackPreflight(admin);
    expect(cleared.outstandingAgentUpdates).toEqual(baseline.outstandingAgentUpdates);
    expect(cleared.pendingJobs.count).toBe(baseline.pendingJobs.count);
    expect(cleared.readyForPreBridgeRollback).toBe(baseline.readyForPreBridgeRollback);
  });
});
