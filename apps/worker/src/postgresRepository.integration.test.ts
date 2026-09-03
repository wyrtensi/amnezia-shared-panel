import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  auditEvents,
  encryptSecret,
  jobOutbox,
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
  const repository = database
    ? new PostgresWorkerRepository({
        db: database.db,
        keyring: { 1: randomBytes(32) },
        activeKeyVersion: 1,
      })
    : null;

  beforeEach(async () => {
    if (!database) return;
    await database.db.delete(auditEvents);
    await database.db.delete(trafficRollups);
    await database.db.delete(peerSamples);
    await database.db.delete(peerCurrent);
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

  const seedTelemetryKey = async () => {
    if (!database) throw new Error("Database test is disabled");
    const keyring = { 1: randomBytes(32) };
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
