import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
  bridgeFrpProxyName,
  type ProbeLevel,
  type ProbeRunRequest,
  type ProbeRunState,
} from "@amnezia/contracts";
import {
  createDatabase,
  encryptSecret,
  jobOutbox,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodes,
  reachabilityProbe,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
} from "@amnezia/db";
import { inspectAwgVpnLink } from "@amnezia/vpn-config";

import { awgServiceLink } from "./awgArtifact.fixture.js";
import { createBridgeCandidateCheck } from "./bridgeCandidateCheck.js";
import { PostgresBridgeCandidateRepository } from "./bridgeCandidateRepository.js";
import type { ProbeClient } from "./probeAgent.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";
import { PostgresReachabilityRepository } from "./reachabilityRepository.js";
import { createReachabilityTask } from "./reachabilityTask.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const level: ProbeLevel = { ok: true, detail: null, latencyMs: 5 };

describe("bridge candidate check end to end (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  const createdNodeIds: string[] = [];
  const createdBridgeIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdJobIds: string[] = [];
  let candidates: PostgresBridgeCandidateRepository;
  let reachability: PostgresReachabilityRepository;
  let worker: PostgresWorkerRepository;
  let serviceAccountId: string;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  beforeAll(async () => {
    if (!database) return;
    candidates = new PostgresBridgeCandidateRepository({ db: database.db, keyring });
    reachability = new PostgresReachabilityRepository({ db: database.db, keyring });
    worker = new PostgresWorkerRepository({ db: database.db, keyring, activeKeyVersion: 1 });
    const [existing] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.serviceAccount, true))
      .limit(1);
    if (existing) {
      serviceAccountId = existing.id;
    } else {
      const [created] = await database.db
        .insert(users)
        .values({
          email: `probe-${runTag}@service.invalid`,
          role: "user",
          serviceAccount: true,
        })
        .returning({ id: users.id });
      if (!created) throw new Error("Failed to seed the service account");
      serviceAccountId = created.id;
      createdUserIds.push(created.id);
    }
  });

  afterEach(async () => {
    if (!database) return;
    await database.db.delete(reachabilityProbe);
    if (createdJobIds.length > 0) {
      await database.db.delete(jobOutbox).where(inArray(jobOutbox.id, createdJobIds));
      createdJobIds.length = 0;
    }
    if (createdNodeIds.length > 0) {
      await database.db.delete(vpnBridgeRoutes).where(inArray(vpnBridgeRoutes.nodeId, createdNodeIds));
    }
    if (createdBridgeIds.length > 0) {
      await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, createdBridgeIds));
    }
    if (createdNodeIds.length > 0) {
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.nodeId, createdNodeIds));
      await database.db
        .delete(nodeReachabilityHistory)
        .where(inArray(nodeReachabilityHistory.nodeId, createdNodeIds));
      await database.db
        .delete(nodeReachabilityResults)
        .where(inArray(nodeReachabilityResults.nodeId, createdNodeIds));
      await database.db
        .delete(nodeReachabilityState)
        .where(inArray(nodeReachabilityState.nodeId, createdNodeIds));
      await database.db.delete(nodes).where(inArray(nodes.id, createdNodeIds));
    }
    createdBridgeIds.length = 0;
    createdNodeIds.length = 0;
  });

  afterAll(async () => {
    if (!database) return;
    if (createdUserIds.length > 0) {
      await database.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await database.client.end();
  });

  /** A node with a draft route observed online and an active AWG 3 service key. */
  const seedRoute = async () => {
    const credentials = encryptSecret("k".repeat(32), keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `candidate-${runTag}-${randomBytes(2).toString("hex")}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        protocol: "awg3",
        publicIp: "192.0.2.10",
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
    createdNodeIds.push(node.id);
    const seed = parseInt(runTag, 16);
    const [bridge] = await db()
      .insert(vpnBridges)
      .values({
        name: `Bridge ${runTag}`,
        publicIpv4: `47.${(seed >> 8) & 0xff}.${seed & 0xff}.${createdBridgeIds.length + 1}`,
        managementStatus: "ok",
        lastObservedAt: new Date(),
      })
      .returning();
    if (!bridge) throw new Error("Failed to seed bridge");
    createdBridgeIds.push(bridge.id);
    const routeId = randomUUID();
    await db().insert(vpnBridgeRoutes).values({
      id: routeId,
      nodeId: node.id,
      bridgeId: bridge.id,
      publicUdpPort: 41004,
      state: "draft",
      frpProxyName: bridgeFrpProxyName(routeId),
      observedOnline: true,
      observedRegistrationMarker: "m-1",
      observedAt: new Date(),
    });
    const config = encryptSecret(awgServiceLink(), keyring, 1);
    await db().insert(vpnKeys).values({
      ownerId: serviceAccountId,
      nodeId: node.id,
      nodeLabel: `candidate_${runTag}_${randomBytes(3).toString("hex")}`,
      protocol: "awg3",
      state: "active",
      deviceType: "unspecified",
      deviceLabel: "probe",
      routeProfile: "full_tunnel",
      configCiphertext: config.ciphertext,
      configNonce: config.nonce,
      configAuthTag: config.authTag,
      configKeyVersion: config.keyVersion,
    });
    return { nodeId: node.id, bridge, routeId };
  };

  const seedProbe = async (currentRunId: string | null = null) => {
    await db().delete(reachabilityProbe);
    const credentials = encryptSecret("k".repeat(32), keyring, 1);
    await db().insert(reachabilityProbe).values({
      label: "Testland",
      apiBaseUrl: "http://probe.test",
      credentialsCiphertext: credentials.ciphertext,
      credentialsNonce: credentials.nonce,
      credentialsAuthTag: credentials.authTag,
      credentialsKeyVersion: credentials.keyVersion,
      controlUrl: "https://example.com/",
      currentRunId,
      currentRunStartedAt: currentRunId ? new Date() : null,
    });
  };

  const queueJob = async (routeId: string, nodeId: string, requestedAt = new Date()) => {
    const [job] = await db()
      .insert(jobOutbox)
      .values({
        type: BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE,
        deduplicationKey: `${BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE}:${routeId}:${randomUUID()}`,
        payload: {
          routeId,
          nodeId,
          registrationMarker: "m-1",
          requestedAt: requestedAt.toISOString(),
        },
      })
      .returning();
    if (!job) throw new Error("Failed to queue job");
    createdJobIds.push(job.id);
    return { id: job.id, type: job.type, attempts: 1, payload: job.payload };
  };

  /** A probe that keeps the runs it was given and reports the newest one. */
  const fakeProbe = () => {
    const runs: ProbeRunRequest[] = [];
    let latest: ProbeRunState | null = null;
    const client: ProbeClient = {
      startRun: vi.fn((request: ProbeRunRequest) => {
        runs.push(request);
        latest = {
          runId: request.runId,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          control: level,
          results: [],
        };
        return Promise.resolve({ runId: request.runId });
      }),
      latestRun: vi.fn(() => Promise.resolve(latest)),
      capabilities: vi.fn(() =>
        Promise.resolve({ apiVersion: 1, capabilities: ["bridge-measurement"] }),
      ),
    };
    const finish = (handshake = level, http = level) => {
      if (!latest) throw new Error("No run");
      latest = {
        ...latest,
        finishedAt: new Date().toISOString(),
        results: runs.at(-1)!.targets.map((target) => ({
          targetId: target.targetId,
          protocol: target.protocol,
          status: "done" as const,
          detail: null,
          endpointHost: null,
          egressIp: "192.0.2.10",
          levels: {
            ping: { ok: false, detail: "no reply", latencyMs: null },
            tcp: { ok: false, detail: "refused", latencyMs: null },
            handshake,
            http,
          },
        })),
      };
      return latest;
    };
    return { client, runs, finish };
  };

  const handlerFor = (client: ProbeClient) =>
    createBridgeCandidateCheck({
      candidates,
      loadProbe: () => reachability.loadProbe(),
      jobs: worker,
      createProbeClient: () => client,
      jobsEnabled: true,
      // Task 4a supplies the real capability; forced here.
      supportsBridgeMeasurement: () => true,
    });

  const tickWith = (client: ProbeClient) =>
    createReachabilityTask({ repository: reachability, createProbeClient: () => client })();

  const probeRow = async () => {
    const [row] = await db().select().from(reachabilityProbe);
    return row;
  };
  const routeRow = async (routeId: string) => {
    const [row] = await db().select().from(vpnBridgeRoutes).where(eq(vpnBridgeRoutes.id, routeId));
    return row;
  };

  runDatabaseTest("populates the stored probe capabilities from the probe, legacy included", async () => {
    await seedProbe();
    const legacy = fakeProbe();
    vi.mocked(legacy.client.capabilities).mockResolvedValue("legacy");
    await tickWith(legacy.client);
    const first = await probeRow();
    expect(first?.capabilities).toEqual([]);
    expect(first?.capabilitiesCheckedAt).toBeInstanceOf(Date);
    // Fresh: the next tick does not ask again.
    await tickWith(legacy.client);
    expect(legacy.client.capabilities).toHaveBeenCalledTimes(1);

    await db()
      .update(reachabilityProbe)
      .set({ capabilitiesCheckedAt: new Date(Date.now() - 60 * 60_000) });
    const upgraded = fakeProbe();
    await tickWith(upgraded.client);
    const second = await probeRow();
    expect(second?.capabilities).toEqual(["bridge-measurement"]);
    expect(second?.capabilitiesCheckedAt?.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );

    // A failed refresh keeps the record and the tick goes on.
    await db()
      .update(reachabilityProbe)
      .set({ capabilitiesCheckedAt: new Date(Date.now() - 60 * 60_000) });
    const down = fakeProbe();
    vi.mocked(down.client.capabilities).mockRejectedValue(new Error("fetch failed"));
    await tickWith(down.client);
    expect((await probeRow())?.capabilities).toEqual(["bridge-measurement"]);

    // The job uses the stored record through the shared lookup (no injection).
    const { nodeId, routeId } = await seedRoute();
    await db()
      .update(reachabilityProbe)
      .set({ capabilitiesCheckedAt: new Date() });
    const probe = fakeProbe();
    await createBridgeCandidateCheck({
      candidates,
      loadProbe: () => reachability.loadProbe(),
      jobs: worker,
      createProbeClient: () => probe.client,
      jobsEnabled: true,
    })(await queueJob(routeId, nodeId));
    expect(probe.runs).toHaveLength(1);
  });

  runDatabaseTest("verifies a draft through the probe and feeds only the route", async () => {
    const { nodeId, bridge, routeId } = await seedRoute();
    await seedProbe();
    const probe = fakeProbe();
    const job = await queueJob(routeId, nodeId);

    await handlerFor(probe.client)(job);
    const [jobRow] = await db().select().from(jobOutbox).where(eq(jobOutbox.id, job.id));
    expect(jobRow?.status).toBe("completed");
    // The run went out with the draft endpoint; the probe slot is the candidate's.
    expect(probe.runs).toHaveLength(1);
    const target = probe.runs[0]!.targets[0]!;
    expect(inspectAwgVpnLink(target.config)).toMatchObject({
      kind: "awg31",
      endpoint: { host: bridge.publicIpv4, port: 41004 },
    });
    const held = await probeRow();
    expect(held).toMatchObject({
      currentRunId: null,
      candidateRunId: probe.runs[0]!.runId,
      candidateRouteId: routeId,
      candidateRegistrationMarker: "m-1",
    });

    // While it runs, the regular tick starts nothing (same service peer).
    await tickWith(probe.client);
    expect(probe.runs).toHaveLength(1);
    expect((await routeRow(routeId))?.verificationResult).toBeNull();

    // Finished: the tick settles it on the route.
    probe.finish();
    await tickWith(probe.client);
    const route = await routeRow(routeId);
    expect(route).toMatchObject({
      verificationMethod: "probe",
      verifiedRegistrationMarker: "m-1",
      verificationResult: "success",
      verificationError: null,
      state: "draft",
    });
    // Exactly what the activation guard reads: same marker as observed,
    // fresh, successful.
    expect(route?.verifiedRegistrationMarker).toBe(route?.observedRegistrationMarker);
    // The panel-clock claim time: never later than the measurement.
    expect(route?.verifiedAt).toEqual(held?.candidateRunStartedAt);
    const after = await probeRow();
    expect(after?.candidateRunId).toBeNull();
    expect(after?.lastIngestedRunId).toBeNull();
    expect(after?.lastResultAt).toBeNull();
    // Nothing reached node status, history or alerts.
    expect(
      await db().select().from(nodeReachabilityState).where(eq(nodeReachabilityState.nodeId, nodeId)),
    ).toHaveLength(0);
    expect(
      await db().select().from(nodeReachabilityResults).where(eq(nodeReachabilityResults.nodeId, nodeId)),
    ).toHaveLength(0);
    expect(
      await db().select().from(nodeReachabilityHistory).where(eq(nodeReachabilityHistory.nodeId, nodeId)),
    ).toHaveLength(0);
    const outbox = await db()
      .select({ type: jobOutbox.type })
      .from(jobOutbox)
      .where(inArray(jobOutbox.type, ["notify.reachability", "notify.reachability-widget"]));
    expect(outbox).toHaveLength(0);
    // With the probe free again, the same tick started the regular run.
    expect(probe.runs).toHaveLength(2);
    expect(probe.runs[1]!.targets.every((t) => !t.targetId.startsWith("bridge-route:"))).toBe(true);
    expect((await probeRow())?.currentRunId).toBe(probe.runs[1]!.runId);
    await db().update(reachabilityProbe).set({ currentRunId: null });
  });

  runDatabaseTest("records a failed handshake on the route only", async () => {
    const { nodeId, routeId } = await seedRoute();
    await seedProbe();
    const probe = fakeProbe();
    await handlerFor(probe.client)(await queueJob(routeId, nodeId));
    probe.finish({ ok: false, detail: "no handshake", latencyMs: null });
    await tickWith(probe.client);
    expect(await routeRow(routeId)).toMatchObject({
      verificationMethod: "probe",
      verificationResult: "failure",
      verificationError: "AWG_HANDSHAKE_FAILED",
    });
    expect(
      await db().select().from(nodeReachabilityState).where(eq(nodeReachabilityState.nodeId, nodeId)),
    ).toHaveLength(0);
    await db().update(reachabilityProbe).set({ currentRunId: null });
  });

  runDatabaseTest("never takes the probe from a regular run", async () => {
    const { nodeId, routeId } = await seedRoute();
    const regularRunId = randomUUID();
    await seedProbe(regularRunId);
    const probe = fakeProbe();
    const job = await queueJob(routeId, nodeId);
    await expect(handlerFor(probe.client)(job)).rejects.toThrow("PROBE_BUSY");
    expect(probe.runs).toHaveLength(0);
    expect(await probeRow()).toMatchObject({ currentRunId: regularRunId, candidateRunId: null });
    // And the claim itself refuses while either slot is taken.
    const run = {
      runId: randomUUID(),
      routeId,
      registrationMarker: "m-1",
      requestedAt: new Date(),
      startedAt: new Date(),
    };
    expect(await candidates.claimCandidateRun(run)).toBe(false);
    await db().update(reachabilityProbe).set({ currentRunId: null });
    expect(await candidates.claimCandidateRun(run)).toBe(true);
    expect(await candidates.claimCandidateRun({ ...run, runId: randomUUID() })).toBe(false);
    await candidates.releaseCandidateRun(run.runId);
    expect((await probeRow())?.candidateRunId).toBeNull();
  });

  runDatabaseTest("a late result does not restore a verification cleared by demotion", async () => {
    const { nodeId, routeId } = await seedRoute();
    await seedProbe();
    const probe = fakeProbe();
    await handlerFor(probe.client)(await queueJob(routeId, nodeId, new Date(Date.now() - 60_000)));
    // Activated and demoted again while the run was out (R11 cleared it).
    await db()
      .update(vpnBridgeRoutes)
      .set({ state: "retiring", retiringSince: new Date() })
      .where(eq(vpnBridgeRoutes.id, routeId));
    probe.finish();
    await tickWith(probe.client);
    expect(await routeRow(routeId)).toMatchObject({
      state: "retiring",
      verificationMethod: null,
      verificationResult: null,
    });
    expect((await probeRow())?.candidateRunId).toBeNull();
    await db().update(reachabilityProbe).set({ currentRunId: null });
  });

  runDatabaseTest("a late result does not replace a verification recorded after the request", async () => {
    const { nodeId, routeId } = await seedRoute();
    await seedProbe();
    const probe = fakeProbe();
    await handlerFor(probe.client)(await queueJob(routeId, nodeId, new Date(Date.now() - 60_000)));
    // The operator verified manually while the probe run was out.
    const operatorAt = new Date();
    await db()
      .update(vpnBridgeRoutes)
      .set({
        verificationMethod: "operator",
        verifiedRegistrationMarker: "m-1",
        verifiedAt: operatorAt,
        verificationResult: "success",
      })
      .where(eq(vpnBridgeRoutes.id, routeId));
    probe.finish({ ok: false, detail: "no handshake", latencyMs: null });
    await tickWith(probe.client);
    expect(await routeRow(routeId)).toMatchObject({
      verificationMethod: "operator",
      verificationResult: "success",
      verificationError: null,
      verifiedAt: operatorAt,
    });
    expect((await probeRow())?.candidateRunId).toBeNull();
    await db().update(reachabilityProbe).set({ currentRunId: null });
  });

  runDatabaseTest("a finished run settled long after its claim cannot pass activation", async () => {
    const { nodeId, routeId } = await seedRoute();
    await seedProbe();
    const probe = fakeProbe();
    await handlerFor(probe.client)(await queueJob(routeId, nodeId, new Date(Date.now() - 4 * 3_600_000)));
    // The run finished, but the worker only gets to settle it hours later.
    const claimedAt = new Date(Date.now() - 3 * 3_600_000);
    await db().update(reachabilityProbe).set({ candidateRunStartedAt: claimedAt });
    probe.finish();
    await tickWith(probe.client);
    const route = await routeRow(routeId);
    expect(route).toMatchObject({
      verificationMethod: "probe",
      verificationResult: "failure",
      verificationError: "PROBE_RESULT_STALE",
      verifiedAt: claimedAt,
    });
    // The activation guard needs a successful verification under 30 minutes
    // old for the observed marker; this route has neither.
    const fresh =
      route?.verificationResult === "success" &&
      route.verifiedAt !== null &&
      Date.now() - route.verifiedAt.getTime() <= 30 * 60_000;
    expect(fresh).toBe(false);
    expect((await probeRow())?.candidateRunId).toBeNull();
    await db().update(reachabilityProbe).set({ currentRunId: null });
  });
});
