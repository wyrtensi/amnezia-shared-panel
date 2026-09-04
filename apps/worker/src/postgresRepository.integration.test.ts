import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  auditEvents,
  encryptSecret,
  jobOutbox,
  nodeMetricsCurrent,
  nodeMetricsSamples,
  nodes,
  peerCurrent,
  peerSamples,
  trafficRollups,
  users,
  vpnKeys,
} from "@amnezia/db";
import { eq } from "drizzle-orm";
import { aggregateTrafficSamples } from "./maintenance.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

describe("PostgresWorkerRepository outbox leases", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  // One keyring for the repository AND for anything the tests seed. They used
  // to generate their own, which worked only for as long as no test decrypted
  // what a helper had encrypted -- the first one that did failed with
  // "unable to authenticate data", which reads like corruption rather than two
  // different keys.
  const keyring = { 1: randomBytes(32) };
  const repository = database
    ? new PostgresWorkerRepository({
        db: database.db,
        keyring,
        activeKeyVersion: 1,
      })
    : null;

  beforeEach(async () => {
    if (!database) return;
    await database.db.delete(auditEvents);
    await database.db.delete(trafficRollups);
    await database.db.delete(peerSamples);
    await database.db.delete(peerCurrent);
    await database.db.delete(nodeMetricsSamples);
    await database.db.delete(nodeMetricsCurrent);
    await database.db.delete(jobOutbox);
    await database.db.delete(vpnKeys);
    await database.db.delete(nodes);
    await database.db.delete(users);
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  runDatabaseTest("reclaims a processing job after its lease expires", async () => {
    if (!database || !repository) return;
    const [inserted] = await database.db
      .insert(jobOutbox)
      .values({
        type: "test.stale",
        deduplicationKey: "test.stale:1",
        payload: {},
        status: "processing",
        attempts: 1,
        lockedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();

    await expect(repository.claimJob()).resolves.toMatchObject({
      id: inserted?.id,
      type: "test.stale",
      attempts: 2,
    });
    const [claimed] = await database.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.id, inserted?.id ?? ""));
    expect(claimed?.status).toBe("processing");
    expect(claimed?.lockedAt?.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  runDatabaseTest("does not reclaim a processing job with a live lease", async () => {
    if (!database || !repository) return;
    await database.db.insert(jobOutbox).values({
      type: "test.live",
      deduplicationKey: "test.live:1",
      payload: {},
      status: "processing",
      attempts: 1,
      lockedAt: new Date(),
    });

    await expect(repository.claimJob()).resolves.toBeNull();
  });

  // Same database, a sample period stated explicitly rather than inherited:
  // the cadence is the thing under test, so it must not depend on a default.
  const sampledRepository = database
    ? new PostgresWorkerRepository({
        db: database.db,
        keyring,
        activeKeyVersion: 1,
        metricsSampleSec: 300,
      })
    : null;

  const seedTelemetryKey = async () => {
    if (!database) throw new Error("Database test is disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [user] = await database.db
      .insert(users)
      .values({ email: "worker-telemetry@example.com" })
      .returning();
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: "worker-telemetry-node",
        apiBaseUrl: "http://127.0.0.1:4001",
        maxPeers: 500,
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
    if (!user || !node) throw new Error("Failed to seed telemetry context");
    const [key] = await database.db
      .insert(vpnKeys)
      .values({
        ownerId: user.id,
        nodeId: node.id,
        publicKey: "public-key",
        nodeLabel: "ap_worker_telemetry",
        protocol: "awg2",
        state: "active",
        routeProfile: "full_tunnel",
      })
      .returning();
    if (!key) throw new Error("Failed to seed telemetry key");
    return { key, node };
  };

  const metricsSnapshot = (nodeId: string, observedAt: Date, load1: number) => ({
    nodeId,
    observedAt,
    agentLatencyMs: 12,
    server: {
      id: "agent-node",
      region: "NL",
      weight: 100,
      maxPeers: 100,
      totalPeers: 0,
      protocols: ["amneziawg3"],
      listenPorts: [51890],
    },
    load: {
      timestamp: observedAt.toISOString(),
      uptimeSec: 60,
      loadavg: [load1, 0, 0] as [number, number, number],
      cpu: { cores: 2 },
      memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512, availableBytes: 361_267_200 },
      disk: null,
      network: null,
      docker: null,
    },
    peers: [],
    publicHost: null,
    publicIp: null,
  });

  runDatabaseTest(
    "keeps one current row per node and a sample only once per period",
    async () => {
      if (!database || !sampledRepository) return;
      const { node } = await seedTelemetryKey();
      const first = new Date("2026-08-20T08:00:00.000Z");

      await sampledRepository.recordNodeSnapshot(metricsSnapshot(node.id, first, 0.1));
      // 60 s later: inside the 300 s window, so the current row moves and the
      // history does not. This is the whole point of two tables.
      await sampledRepository.recordNodeSnapshot(
        metricsSnapshot(node.id, new Date("2026-08-20T08:01:00.000Z"), 0.2),
      );

      const afterTwoPolls = await database.db
        .select()
        .from(nodeMetricsCurrent)
        .where(eq(nodeMetricsCurrent.nodeId, node.id));
      expect(afterTwoPolls).toHaveLength(1);
      expect(afterTwoPolls[0]).toMatchObject({
        load1: 0.2,
        memAvailableBytes: 361_267_200n,
        observedAt: new Date("2026-08-20T08:01:00.000Z"),
        listenPorts: [51890],
      });
      await expect(
        database.db.select().from(nodeMetricsSamples),
      ).resolves.toHaveLength(1);

      // Exactly one period later the next sample is due.
      await sampledRepository.recordNodeSnapshot(
        metricsSnapshot(node.id, new Date("2026-08-20T08:05:00.000Z"), 0.3),
      );
      const samples = await database.db
        .select({ sampledAt: nodeMetricsSamples.sampledAt, load1: nodeMetricsSamples.load1 })
        .from(nodeMetricsSamples)
        .orderBy(nodeMetricsSamples.sampledAt);
      expect(samples).toEqual([
        { sampledAt: first, load1: 0.1 },
        { sampledAt: new Date("2026-08-20T08:05:00.000Z"), load1: 0.3 },
      ]);
    },
  );

  runDatabaseTest("prunes host-metric history past the retention cutoff", async () => {
    if (!database || !repository) return;
    const { node } = await seedTelemetryKey();
    await database.db.insert(nodeMetricsSamples).values([
      { nodeId: node.id, sampledAt: new Date("2026-08-10T12:00:00.000Z"), load1: 0.1 },
      { nodeId: node.id, sampledAt: new Date("2026-08-20T12:00:00.000Z"), load1: 0.2 },
    ]);

    await repository.deleteNodeMetricsSamplesBefore(
      new Date("2026-08-13T12:00:00.000Z"),
    );

    const remaining = await database.db
      .select({ sampledAt: nodeMetricsSamples.sampledAt })
      .from(nodeMetricsSamples);
    expect(remaining).toEqual([{ sampledAt: new Date("2026-08-20T12:00:00.000Z") }]);
  });

  runDatabaseTest("keeps the pre-cutoff sample as the rollup baseline", async () => {
    if (!database || !repository) return;
    const { key } = await seedTelemetryKey();
    const cutoff = new Date("2026-08-20T08:00:00.000Z");
    await database.db.insert(peerSamples).values([
      {
        keyId: key.id,
        online: true,
        receivedBytes: 100n,
        sentBytes: 200n,
        sampledAt: new Date("2026-08-20T07:55:00.000Z"),
      },
      {
        keyId: key.id,
        online: true,
        receivedBytes: 130n,
        sentBytes: 240n,
        sampledAt: new Date("2026-08-20T08:05:00.000Z"),
      },
    ]);

    const samples = await repository.loadSamplesSince(cutoff);

    expect(samples.map((sample) => sample.sampledAt)).toEqual([
      new Date("2026-08-20T07:55:00.000Z"),
      new Date("2026-08-20T08:05:00.000Z"),
    ]);
    expect(aggregateTrafficSamples(samples, "hour")).toEqual([
      {
        keyId: key.id,
        period: "hour",
        bucketStart: cutoff,
        receivedBytes: 30n,
        sentBytes: 40n,
      },
    ]);
  });

  runDatabaseTest("stores reported capacity without changing the business limit", async () => {
    if (!database || !repository) return;
    const { node } = await seedTelemetryKey();
    const observedAt = new Date("2026-08-20T08:00:00.000Z");

    await repository.recordNodeSnapshot({
      nodeId: node.id,
      observedAt,
      agentLatencyMs: 12,
      server: {
        id: "agent-node",
        region: "NL",
        weight: 100,
        maxPeers: 100,
        totalPeers: 12,
        protocols: ["amneziawg2"],
      },
      load: {
        timestamp: observedAt.toISOString(),
        uptimeSec: 60,
        loadavg: [0, 0, 0],
        cpu: { cores: 2 },
        memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512 },
        disk: null,
        network: null,
        docker: null,
      },
      peers: [],
      publicHost: null,
      publicIp: null,
    });

    const [stored] = await database.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(stored?.maxPeers).toBe(500);
    expect(stored?.capabilities).toMatchObject({
      reportedMaxPeers: 100,
      reportedTotalPeers: 12,
    });
  });

  runDatabaseTest("stores the reported public host and its resolved IP", async () => {
    if (!database || !repository) return;
    const { node } = await seedTelemetryKey();
    const observedAt = new Date("2026-08-20T08:10:00.000Z");
    const load = {
      timestamp: observedAt.toISOString(),
      uptimeSec: 60,
      loadavg: [0, 0, 0] as [number, number, number],
      cpu: { cores: 2 },
      memory: { totalBytes: 1024, freeBytes: 512, usedBytes: 512 },
      disk: null,
      network: null,
      docker: null,
    };
    const server = {
      id: "agent-node",
      region: "NL",
      weight: 100,
      maxPeers: 100,
      totalPeers: 0,
      protocols: ["amneziawg3"],
      publicHost: "vpn.example.com",
    };

    await repository.recordNodeSnapshot({
      nodeId: node.id,
      observedAt,
      agentLatencyMs: 12,
      server,
      load,
      peers: [],
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.10",
    });
    const [resolved] = await database.db
      .select({ publicHost: nodes.publicHost, publicIp: nodes.publicIp })
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(resolved).toEqual({
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.10",
    });

    // A later poll with no new answer — the address is already known, so no
    // lookup was made — must KEEP the last known IP and must not move its
    // timestamp: that timestamp records when the address was learned.
    await repository.recordNodeSnapshot({
      nodeId: node.id,
      observedAt: new Date("2026-08-20T08:11:00.000Z"),
      agentLatencyMs: 12,
      server,
      load,
      peers: [],
      publicHost: "vpn.example.com",
      publicIp: null,
    });
    const [afterFailure] = await database.db
      .select({
        publicHost: nodes.publicHost,
        publicIp: nodes.publicIp,
        publicIpResolvedAt: nodes.publicIpResolvedAt,
      })
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(afterFailure).toEqual({
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.10",
      publicIpResolvedAt: new Date("2026-08-20T08:10:00.000Z"),
    });

    // A successful lookup with a NEW address overwrites both.
    await repository.recordNodeSnapshot({
      nodeId: node.id,
      observedAt: new Date("2026-08-20T08:12:00.000Z"),
      agentLatencyMs: 12,
      server,
      load,
      peers: [],
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.11",
    });
    const [moved] = await database.db
      .select({
        publicIp: nodes.publicIp,
        publicIpResolvedAt: nodes.publicIpResolvedAt,
      })
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(moved).toEqual({
      publicIp: "203.0.113.11",
      publicIpResolvedAt: new Date("2026-08-20T08:12:00.000Z"),
    });

    // An agent that stops reporting a host clears the host but keeps the IP:
    // the host is an observation of this poll, the IP is the last good answer.
    await repository.recordNodeSnapshot({
      nodeId: node.id,
      observedAt: new Date("2026-08-20T08:13:00.000Z"),
      agentLatencyMs: 12,
      server: { ...server, publicHost: undefined },
      load,
      peers: [],
      publicHost: null,
      publicIp: null,
    });
    const [unreported] = await database.db
      .select({ publicHost: nodes.publicHost, publicIp: nodes.publicIp })
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(unreported).toEqual({
      publicHost: null,
      publicIp: "203.0.113.11",
    });
  });

  runDatabaseTest("reports the stored address so the poll can skip the lookup", async () => {
    if (!database || !repository) return;
    const { node } = await seedTelemetryKey();
    await database.db
      .update(nodes)
      .set({
        publicHost: "vpn.example.com",
        publicIp: "203.0.113.10",
        publicIpResolvedAt: new Date("2026-08-20T08:10:00.000Z"),
      })
      .where(eq(nodes.id, node.id));

    const telemetryNodes = await repository.listTelemetryNodes();

    expect(telemetryNodes).toHaveLength(1);
    expect(telemetryNodes[0]).toMatchObject({
      publicHost: "vpn.example.com",
      publicIp: "203.0.113.10",
    });
  });

  runDatabaseTest("atomically stores read-only reconciliation state and summary", async () => {
    if (!database || !repository) return;
    const { key, node } = await seedTelemetryKey();
    const [job] = await database.db
      .insert(jobOutbox)
      .values({
        type: "node.reconcile",
        deduplicationKey: "node.reconcile:success",
        payload: { nodeId: node.id },
        status: "processing",
        lockedAt: new Date(),
      })
      .returning();
    if (!job) throw new Error("Failed to seed reconciliation job");
    const observedAt = new Date("2026-08-20T09:00:00.000Z");
    const summary = {
      managedKeyCount: 1,
      observedPeerCount: 2,
      matchedPeerCount: 1,
      missingManagedPeerCount: 0,
      orphanNodePeerCount: 1,
    };

    await repository.completeNodeReconcile({
      jobId: job.id,
      nodeId: node.id,
      observedAt,
      managedKeyIds: [key.id],
      peers: [
        {
          keyId: key.id,
          online: true,
          endpoint: "203.0.113.1:51889",
          latestHandshakeAt: new Date("2026-08-20T08:59:30.000Z"),
          receivedBytes: 120n,
          sentBytes: 80n,
          observedAt,
        },
      ],
      summary,
    });

    const [storedJob] = await database.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.id, job.id));
    const [storedNode] = await database.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, node.id));
    const [storedCurrent] = await database.db
      .select()
      .from(peerCurrent)
      .where(eq(peerCurrent.keyId, key.id));
    const [storedKey] = await database.db
      .select()
      .from(vpnKeys)
      .where(eq(vpnKeys.id, key.id));
    const [event] = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, node.id));
    expect(storedJob?.status).toBe("completed");
    expect(storedNode?.lastSyncAt).toEqual(observedAt);
    expect(storedNode?.lastError).toBe("Reconcile mismatch: missing=0 orphan=1");
    expect(storedCurrent).toMatchObject({
      online: true,
      receivedBytes: 120n,
      sentBytes: 80n,
    });
    expect(storedKey?.state).toBe("active");
    expect(event).toMatchObject({
      actorType: "system",
      action: "node.reconcile",
      targetType: "node",
      targetId: node.id,
      metadata: { jobId: job.id, ...summary },
    });
  });

  runDatabaseTest("does not complete reconciliation when state refresh fails", async () => {
    if (!database || !repository) return;
    const { node } = await seedTelemetryKey();
    const [job] = await database.db
      .insert(jobOutbox)
      .values({
        type: "node.reconcile",
        deduplicationKey: "node.reconcile:rollback",
        payload: { nodeId: node.id },
        status: "processing",
        lockedAt: new Date(),
      })
      .returning();
    if (!job) throw new Error("Failed to seed reconciliation job");
    const observedAt = new Date("2026-08-20T10:00:00.000Z");

    await expect(
      repository.completeNodeReconcile({
        jobId: job.id,
        nodeId: node.id,
        observedAt,
        managedKeyIds: ["00000000-0000-4000-8000-000000000001"],
        peers: [
          {
            keyId: "00000000-0000-4000-8000-000000000001",
            online: false,
            endpoint: null,
            latestHandshakeAt: null,
            receivedBytes: 0n,
            sentBytes: 0n,
            observedAt,
          },
        ],
        summary: {
          managedKeyCount: 1,
          observedPeerCount: 0,
          matchedPeerCount: 0,
          missingManagedPeerCount: 1,
          orphanNodePeerCount: 0,
        },
      }),
    ).rejects.toThrow();

    const [storedJob] = await database.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.id, job.id));
    const [storedNode] = await database.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(storedJob?.status).toBe("processing");
    expect(storedNode?.lastSyncAt).toBeNull();
  });
});
