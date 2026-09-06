import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_SYNC_DEDUPLICATION_KEY,
  RULES_REFRESH_DEDUPLICATION_KEY,
  type KeyState,
} from "@amnezia/contracts";
import {
  createDatabase,
  auditEvents,
  encryptSecret,
  jobOutbox,
  nodeMetricsCurrent,
  nodeMetricsSamples,
  nodeServiceCheckResults,
  nodeServiceChecks,
  nodes,
  peerCurrent,
  peerSamples,
  portalPolicy,
  routeRuleVersions,
  trafficRollups,
  users,
  vpnKeys,
} from "@amnezia/db";
import { and, eq, sql } from "drizzle-orm";
import { aggregateTrafficSamples } from "./maintenance.js";
import {
  PostgresWorkerRepository,
  REARM_STUCK_REVOKES_LIMIT,
} from "./postgresRepository.js";

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
    await database.db.delete(portalPolicy);
    await database.db.delete(trafficRollups);
    await database.db.delete(peerSamples);
    await database.db.delete(peerCurrent);
    await database.db.delete(nodeServiceCheckResults);
    await database.db.delete(nodeServiceChecks);
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

  const readAccessSyncRow = async () => {
    if (!database) throw new Error("Database test is disabled");
    const [row] = await database.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, ACCESS_SYNC_DEDUPLICATION_KEY));
    if (!row) throw new Error("access.sync row not found");
    return row;
  };

  const markAccessSyncRow = async (patch: {
    status?: "pending" | "processing" | "completed" | "failed";
    attempts?: number;
    lastError?: string | null;
    availableAt?: Date;
  }) => {
    if (!database) throw new Error("Database test is disabled");
    await database.db
      .update(jobOutbox)
      .set(patch)
      .where(eq(jobOutbox.deduplicationKey, ACCESS_SYNC_DEDUPLICATION_KEY));
  };

  runDatabaseTest(
    "arms one row, refreshes the marker on every arm, and restarts only a finished row",
    async () => {
      if (!database || !repository) return;
      await repository.armAccessSync("timer");
      const first = await readAccessSyncRow();
      expect(first.status).toBe("pending");

      // A second arm while the row is still pending keeps the row and its
      // lifecycle but replaces the marker, so a change cannot be swallowed by
      // a run in flight.
      await repository.armAccessSync("user-change");
      const second = await readAccessSyncRow();
      expect(second.id).toBe(first.id);
      expect(second.payload.armId).not.toBe(first.payload.armId);
      expect(second.status).toBe("pending");

      // A finished row restarts.
      await markAccessSyncRow({ status: "completed", attempts: 3, lastError: "x" });
      await repository.armAccessSync("timer");
      const third = await readAccessSyncRow();
      expect(third.status).toBe("pending");
      expect(third.attempts).toBe(0);
      expect(third.lastError).toBeNull();
    },
  );

  runDatabaseTest(
    "completes the job only when the marker still matches, and re-arms it otherwise",
    async () => {
      if (!database || !repository) return;
      await repository.armAccessSync("timer");
      // armAccessSync debounces the row (ACCESS_SYNC_DEBOUNCE_MS) so a burst of
      // changes coalesces into one run; claimJob only picks up a pending row
      // once `availableAt` has passed. Simulate that window having elapsed —
      // the way it would in production once the debounce expires — so this
      // test can exercise the claim/finish path instead of racing a real
      // 10-second wait.
      await markAccessSyncRow({ availableAt: new Date() });
      const claimed = await repository.claimJob();
      // A change lands mid-run: the marker moves on.
      await repository.armAccessSync("user-change");

      await repository.finishAccessSync(
        claimed!.id,
        claimed!.payload.armId as string,
      );

      const row = await readAccessSyncRow();
      expect(row.status).toBe("pending"); // one more run, not a lost hour
    },
  );

  runDatabaseTest(
    "completes the job when the marker still matches -- the branch every successful run takes",
    async () => {
      if (!database || !repository) return;
      await repository.armAccessSync("timer");
      // Same debounce note as the mismatched-marker test above: fast-forward
      // past ACCESS_SYNC_DEBOUNCE_MS so claimJob can pick the row up.
      await markAccessSyncRow({ availableAt: new Date() });
      const claimed = await repository.claimJob();

      // Nothing re-arms the row this time, so the marker claimJob() read is
      // still the current one -- this is the healthy path every successful
      // sync takes, as opposed to the mismatch case above.
      await repository.finishAccessSync(
        claimed!.id,
        claimed!.payload.armId as string,
      );

      const row = await readAccessSyncRow();
      expect(row.status).toBe("completed");
      expect(row.completedAt).not.toBeNull();
      expect(row.lastError).toBeNull();
    },
  );

  runDatabaseTest(
    "reads the domain baseline and writes both baselines in one UPDATE",
    async () => {
      if (!database || !repository) return;
      await database.db.insert(portalPolicy).values({});
      await database.db
        .update(portalPolicy)
        .set({ cfAccessAllowedDomains: ["x.io", "y.io"] })
        .where(eq(portalPolicy.id, true));

      await expect(repository.getAccessSyncDesiredDomains()).resolves.toEqual([
        "x.io",
        "y.io",
      ]);
      // Null until the first domain sync -- the mirror of the email baseline.
      await expect(repository.getAccessSyncBaselineDomains()).resolves.toEqual([]);

      await repository.setAccessSyncBaseline(["a@x.io"], ["x.io"]);

      const [row] = await database.db
        .select({
          emails: portalPolicy.cfAccessSyncedEmails,
          domains: portalPolicy.cfAccessSyncedDomains,
        })
        .from(portalPolicy)
        .where(eq(portalPolicy.id, true));
      // Both columns landed from the SAME statement -- there is no window in
      // which one baseline could be observed ahead of the other.
      expect(row).toEqual({ emails: ["a@x.io"], domains: ["x.io"] });
      await expect(repository.getAccessSyncBaselineDomains()).resolves.toEqual([
        "x.io",
      ]);
    },
  );

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

  runDatabaseTest(
    "reads check definitions and each node's last result in one pass",
    async () => {
      if (!database || !repository) return;
      const { node } = await seedTelemetryKey();
      const [check] = await database.db
        .insert(nodeServiceChecks)
        .values({
          name: "Gemini",
          probe: {
            kind: "http" as const,
            url: "https://gemini.google.com/",
            method: "GET" as const,
            timeoutMs: 10_000,
          },
          assertions: [{ type: "statusIn", statuses: [200] }],
        })
        .returning();
      if (!check) throw new Error("Failed to seed a service check");

      const first = await repository.listServiceChecks();
      expect(first.checks).toHaveLength(1);
      expect(first.checks[0]).toMatchObject({
        name: "Gemini",
        intervalSec: 43_200,
        enabled: true,
        assertions: [{ type: "statusIn", statuses: [200] }],
      });
      // Never run anywhere yet, so no node has a previous result - which is
      // exactly what makes every check due on a new node's next tick.
      expect(first.previousByNode.size).toBe(0);

      const checkedAt = new Date("2026-09-02T09:00:00.000Z");
      await repository.recordServiceCheckResults([
        {
          nodeId: node.id,
          checkId: check.id,
          status: "failed",
          httpStatus: 200,
          latencyMs: 412,
          detail: 'body does not contain "conversation-container"',
          finalUrl: "https://gemini.google.com/",
          checkedAt,
          failingSince: checkedAt,
        },
      ]);

      const second = await repository.listServiceChecks();
      expect(second.previousByNode.get(node.id)?.get(check.id)).toEqual({
        status: "failed",
        checkedAt,
        failingSince: checkedAt,
      });
    },
  );

  runDatabaseTest("keeps one result row per node and check", async () => {
    if (!database || !repository) return;
    const { node } = await seedTelemetryKey();
    const [check] = await database.db
      .insert(nodeServiceChecks)
      .values({
        name: "Flow",
        probe: {
          kind: "http" as const,
          url: "https://labs.google/fx/tools/flow/",
          method: "GET" as const,
          timeoutMs: 10_000,
        },
        assertions: [{ type: "finalUrlOmits", value: "unsupported-country" }],
      })
      .returning();
    if (!check) throw new Error("Failed to seed a service check");

    const row = {
      nodeId: node.id,
      checkId: check.id,
      httpStatus: 200,
      latencyMs: 100,
      detail: null,
      finalUrl: null,
      failingSince: null,
    };
    await repository.recordServiceCheckResults([
      { ...row, status: "failed", checkedAt: new Date("2026-09-02T09:00:00.000Z") },
    ]);
    await repository.recordServiceCheckResults([
      { ...row, status: "ok", checkedAt: new Date("2026-09-02T21:00:00.000Z") },
    ]);

    // The latest result IS the schedule, so a second run must replace the row
    // rather than accumulate: an insert-only table here would grow forever and
    // make "what does this node say now" a query with an ORDER BY.
    const stored = await database.db.select().from(nodeServiceCheckResults);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "ok",
      checkedAt: new Date("2026-09-02T21:00:00.000Z"),
    });
  });

  runDatabaseTest("refuses a check with no assertions at the table", async () => {
    if (!database) return;
    // The contract refuses this too. Both, because a check that asserts nothing
    // is always green and looks exactly like a check that is passing.
    await expect(
      database.db.insert(nodeServiceChecks).values({
        name: "Empty",
        probe: {
          kind: "http" as const,
          url: "https://example.com/",
          method: "GET" as const,
          timeoutMs: 10_000,
        },
        assertions: [],
      }),
    ).rejects.toThrow();
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

    // The agent starts reporting a NEW host and the lookup fails: the stored
    // IP answers for the previous host and must not survive, or the next poll
    // would see a known IP and skip the lookup forever (telemetry.ts:285).
    await repository.recordNodeSnapshot({
      nodeId: node.id,
      observedAt: new Date("2026-08-20T08:14:00.000Z"),
      agentLatencyMs: 12,
      server: { ...server, publicHost: "new.example.com" },
      load,
      peers: [],
      publicHost: "new.example.com",
      publicIp: null,
    });
    const [hostChanged] = await database.db
      .select({
        publicHost: nodes.publicHost,
        publicIp: nodes.publicIp,
        publicIpResolvedAt: nodes.publicIpResolvedAt,
      })
      .from(nodes)
      .where(eq(nodes.id, node.id));
    expect(hostChanged).toEqual({
      publicHost: "new.example.com",
      publicIp: null,
      publicIpResolvedAt: null,
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
      revokingKeyCount: 0,
      strandedRevokingPeerCount: 0,
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
          revokingKeyCount: 0,
          strandedRevokingPeerCount: 0,
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

  runDatabaseTest(
    "returns each key's state, and keeps upserting peer_current for a revoking key",
    async () => {
      if (!database || !repository) return;
      const credentials = encryptSecret("api-key", keyring, 1);
      const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
      const [user] = await database.db
        .insert(users)
        .values({ email: "worker-revoking@example.com" })
        .returning();
      const [node] = await database.db
        .insert(nodes)
        .values({
          name: "worker-revoking-node",
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
      if (!user || !node) throw new Error("Failed to seed revoking-key context");
      const [key] = await database.db
        .insert(vpnKeys)
        .values({
          ownerId: user.id,
          nodeId: node.id,
          publicKey: "stuck-public-key",
          nodeLabel: "ap_worker_revoking",
          protocol: "awg2",
          state: "revoking",
          routeProfile: "full_tunnel",
        })
        .returning();
      if (!key) throw new Error("Failed to seed revoking key");

      const context = await repository.loadNodeReconcileContext(node.id);
      expect(context?.keys).toEqual([
        expect.objectContaining({ keyId: key.id, state: "revoking" }),
      ]);

      const [job] = await database.db
        .insert(jobOutbox)
        .values({
          type: "node.reconcile",
          deduplicationKey: "node.reconcile:revoking",
          payload: { nodeId: node.id },
          status: "processing",
          lockedAt: new Date(),
        })
        .returning();
      if (!job) throw new Error("Failed to seed reconciliation job");
      const observedAt = new Date("2026-08-20T11:00:00.000Z");

      // The peer never got deleted -- the revoke permanently failed -- so
      // reconcile still observes it online, and this write must still land:
      // dropping `revoking` from `managedKeyIds` would freeze this row
      // instead of refreshing it.
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
            latestHandshakeAt: new Date("2026-08-20T10:59:00.000Z"),
            receivedBytes: 10n,
            sentBytes: 5n,
            observedAt,
          },
        ],
        summary: {
          managedKeyCount: 1,
          observedPeerCount: 1,
          matchedPeerCount: 1,
          missingManagedPeerCount: 0,
          orphanNodePeerCount: 0,
          revokingKeyCount: 1,
          strandedRevokingPeerCount: 1,
        },
      });

      const [storedCurrent] = await database.db
        .select()
        .from(peerCurrent)
        .where(eq(peerCurrent.keyId, key.id));
      expect(storedCurrent).toMatchObject({
        online: true,
        receivedBytes: 10n,
        sentBytes: 5n,
      });
    },
  );

  /**
   * A key plus a job of `type` that carries its id, so `failJob` has something
   * to act on. Returns both ids.
   */
  const seedKeyWithJob = async (
    state: "provisioning" | "revoking",
    type: string,
  ): Promise<{ keyId: string; jobId: string }> => {
    if (!database) throw new Error("Database test is disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [user] = await database.db
      .insert(users)
      .values({ email: `fail-job-${randomBytes(6).toString("hex")}@example.com` })
      .returning();
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: `fail-job-node-${randomBytes(6).toString("hex")}`,
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
    if (!user || !node) throw new Error("Failed to seed fail-job context");
    const [key] = await database.db
      .insert(vpnKeys)
      .values({
        ownerId: user.id,
        nodeId: node.id,
        publicKey: `public-key-${randomBytes(6).toString("hex")}`,
        nodeLabel: `ap_fail_${randomBytes(6).toString("hex")}`,
        protocol: "awg2",
        state,
        routeProfile: "full_tunnel",
      })
      .returning();
    if (!key) throw new Error("Failed to seed fail-job key");
    const [job] = await database.db
      .insert(jobOutbox)
      .values({
        type,
        deduplicationKey: `${type}:${key.id}`,
        payload: { keyId: key.id },
        status: "processing",
        attempts: 5,
        lockedAt: new Date(),
      })
      .returning();
    if (!job) throw new Error("Failed to seed fail-job outbox row");
    return { keyId: key.id, jobId: job.id };
  };

  runDatabaseTest(
    "keeps a failed revoke in revoking, so the user does not see a deleted key",
    async () => {
      if (!database || !repository) return;
      const { keyId, jobId } = await seedKeyWithJob(
        "revoking",
        "vpn-key.revoke",
      );

      await repository.failJob(jobId, "node unreachable");

      const [row] = await database.db
        .select()
        .from(vpnKeys)
        .where(eq(vpnKeys.id, keyId));
      expect(row?.state).toBe("revoking");
      expect(row?.failureReason).toContain("node unreachable");
    },
  );

  runDatabaseTest(
    "marks a key whose provisioning failed as failed",
    async () => {
      if (!database || !repository) return;
      const { keyId, jobId } = await seedKeyWithJob(
        "provisioning",
        "vpn-key.provision",
      );

      await repository.failJob(jobId, "node rejected the peer");

      const [row] = await database.db
        .select()
        .from(vpnKeys)
        .where(eq(vpnKeys.id, keyId));
      expect(row?.state).toBe("failed");
      expect(row?.failureReason).toContain("node rejected the peer");
    },
  );

  const DAY_MS = 24 * 60 * 60 * 1_000;

  /**
   * A disabled user with one or more keys, each in a given state. Reused by
   * the purgeOffboardedUsers tests below, which each need a different
   * combination of `disabledAt` and key state.
   */
  const seedDisabledUser = async (options: {
    disabledAt: Date | null;
    keyStates: Array<
      "provisioning" | "active" | "disabled" | "revoking" | "revoked" | "failed"
    >;
  }): Promise<{ userId: string; email: string }> => {
    if (!database) throw new Error("Database test is disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const email = `purge-${randomBytes(6).toString("hex")}@example.com`;
    const [user] = await database.db
      .insert(users)
      .values({
        email,
        status: "disabled",
        disabledAt: options.disabledAt,
        deactivationReason: "admin_offboard",
      })
      .returning();
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: `purge-node-${randomBytes(6).toString("hex")}`,
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
    if (!user || !node) throw new Error("Failed to seed purge-test context");
    for (const [index, state] of options.keyStates.entries()) {
      await database.db.insert(vpnKeys).values({
        ownerId: user.id,
        nodeId: node.id,
        nodeLabel: `ap_purge_${index}_${randomBytes(6).toString("hex")}`,
        protocol: "awg2",
        state,
        routeProfile: "full_tunnel",
      });
    }
    return { userId: user.id, email };
  };

  const stillExists = async (userId: string): Promise<boolean> => {
    if (!database) throw new Error("Database test is disabled");
    const [row] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    return row !== undefined;
  };

  runDatabaseTest("keeps a recently disabled user", async () => {
    if (!database || !repository) return;
    const now = new Date();
    const { userId } = await seedDisabledUser({
      disabledAt: new Date(now.getTime() - 1 * DAY_MS),
      keyStates: ["revoked"],
    });

    // 30-day window: a user disabled yesterday is nowhere near the cutoff.
    await repository.purgeOffboardedUsers(new Date(now.getTime() - 30 * DAY_MS));

    expect(await stillExists(userId)).toBe(true);
  });

  runDatabaseTest("purges a user disabled past the window", async () => {
    if (!database || !repository) return;
    const now = new Date();
    const { userId, email } = await seedDisabledUser({
      disabledAt: new Date(now.getTime() - 40 * DAY_MS),
      keyStates: ["revoked"],
    });

    const result = await repository.purgeOffboardedUsers(
      new Date(now.getTime() - 30 * DAY_MS),
    );

    expect(result.deleted).toEqual([email]);
    expect(await stillExists(userId)).toBe(false);
    const [event] = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, userId));
    expect(event).toMatchObject({
      actorType: "system",
      action: "user.deleted",
      targetType: "user",
    });
  });

  runDatabaseTest("never purges a user with no disabled_at", async () => {
    if (!database || !repository) return;
    const now = new Date();
    // Disabled (status = "disabled") but disabled_at is null -- a row from
    // before that column existed, or from a bug that skipped setting it.
    // There is no timestamp to measure a retention window from, so it must
    // never be purged, no matter how long ago it was disabled.
    const { userId } = await seedDisabledUser({
      disabledAt: null,
      keyStates: ["revoked"],
    });

    await repository.purgeOffboardedUsers(new Date(now.getTime() - 30 * DAY_MS));

    expect(await stillExists(userId)).toBe(true);
  });

  runDatabaseTest("still refuses to purge while a key is live", async () => {
    if (!database || !repository) return;
    const now = new Date();
    // Past the retention window, but one key is still "revoking" -- the
    // pre-existing guard (purge refuses while any key is not yet revoked)
    // must keep working alongside the new retention-window check.
    const { userId } = await seedDisabledUser({
      disabledAt: new Date(now.getTime() - 40 * DAY_MS),
      keyStates: ["revoked", "revoking"],
    });

    await repository.purgeOffboardedUsers(new Date(now.getTime() - 30 * DAY_MS));

    expect(await stillExists(userId)).toBe(true);
  });

  const MINUTE_MS = 60_000;

  /**
   * A key in `revoking` (or another state, see `state` below) on a node with a
   * controllable `enabled`/`lastSyncAt`, for the `rearmStuckRevokes` bound
   * tests below. Defaults to a fresh, enabled, `revoking` node/key -- the
   * shape every bound test starts from before it breaks exactly one condition.
   */
  const seedStuckRevokingKey = async (options: {
    nodeEnabled?: boolean;
    lastSyncAt?: Date | null;
    state?: KeyState;
  } = {}): Promise<{ keyId: string }> => {
    if (!database) throw new Error("Database test is disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [user] = await database.db
      .insert(users)
      .values({ email: `rearm-${randomBytes(6).toString("hex")}@example.com` })
      .returning();
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: `rearm-node-${randomBytes(6).toString("hex")}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        maxPeers: 500,
        enabled: options.nodeEnabled ?? true,
        lastSyncAt:
          options.lastSyncAt === undefined ? new Date() : options.lastSyncAt,
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
    if (!user || !node) throw new Error("Failed to seed rearm-test context");
    const [key] = await database.db
      .insert(vpnKeys)
      .values({
        ownerId: user.id,
        nodeId: node.id,
        nodeLabel: `ap_rearm_${randomBytes(6).toString("hex")}`,
        protocol: "awg2",
        state: options.state ?? "revoking",
        routeProfile: "full_tunnel",
      })
      .returning();
    if (!key) throw new Error("Failed to seed rearm-test key");
    return { keyId: key.id };
  };

  /** An extra `vpn-key.revoke` outbox row for `keyId`, in a given status. */
  const seedRevokeJob = async (
    keyId: string,
    status: "pending" | "processing" | "failed" | "completed",
  ): Promise<void> => {
    if (!database) throw new Error("Database test is disabled");
    await database.db.insert(jobOutbox).values({
      type: "vpn-key.revoke",
      deduplicationKey: `vpn-key.revoke:${keyId}:${randomBytes(6).toString("hex")}`,
      payload: { keyId },
      status,
      completedAt: status === "completed" ? new Date() : null,
    });
  };

  const revokeJobsFor = async (keyId: string) => {
    if (!database) throw new Error("Database test is disabled");
    return database.db
      .select()
      .from(jobOutbox)
      .where(
        and(
          eq(jobOutbox.type, "vpn-key.revoke"),
          sql`${jobOutbox.payload} ->> 'keyId' = ${keyId}`,
        ),
      );
  };

  runDatabaseTest(
    "re-arms a revoking key on a fresh, enabled node with no live job",
    async () => {
      if (!database || !repository) return;
      const { keyId } = await seedStuckRevokingKey();

      const result = await repository.rearmStuckRevokes();

      expect(result).toEqual({ rearmed: 1 });
      const jobs = await revokeJobsFor(keyId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: "pending", payload: { keyId } });
      const [event] = await database.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "vpn_key.revoke_rearmed"));
      expect(event).toMatchObject({ actorType: "system" });
    },
  );

  runDatabaseTest(
    "bound: a key whose node has a stale last_sync_at gets none",
    async () => {
      if (!database || !repository) return;
      // 40 minutes ago -- past the 30-minute freshness floor. Without this
      // bound a node that is genuinely gone would have its keys retried
      // forever.
      const { keyId } = await seedStuckRevokingKey({
        lastSyncAt: new Date(Date.now() - 40 * MINUTE_MS),
      });

      const result = await repository.rearmStuckRevokes();

      expect(result).toEqual({ rearmed: 0 });
      expect(await revokeJobsFor(keyId)).toHaveLength(0);
    },
  );

  runDatabaseTest("bound: a key on a disabled node gets none", async () => {
    if (!database || !repository) return;
    const { keyId } = await seedStuckRevokingKey({ nodeEnabled: false });

    const result = await repository.rearmStuckRevokes();

    expect(result).toEqual({ rearmed: 0 });
    expect(await revokeJobsFor(keyId)).toHaveLength(0);
  });

  // Both "pending" and "processing" are in the query's inArray -- a job
  // mid-flight is just as live as one still queued, so either must block a
  // second one from stacking on top of it.
  for (const liveStatus of ["pending", "processing"] as const) {
    runDatabaseTest(
      `bound: a key with a ${liveStatus} revoke job already in flight gets none`,
      async () => {
        if (!database || !repository) return;
        const { keyId } = await seedStuckRevokingKey();
        await seedRevokeJob(keyId, liveStatus);

        const result = await repository.rearmStuckRevokes();

        // Without this bound a second job would stack on the one already live.
        expect(result).toEqual({ rearmed: 0 });
        expect(await revokeJobsFor(keyId)).toHaveLength(1);
      },
    );
  }

  runDatabaseTest(
    "bound: a key with 5 failed revoke jobs gets none, with 4 gets one",
    async () => {
      if (!database || !repository) return;
      const { keyId: exhaustedKeyId } = await seedStuckRevokingKey();
      for (let i = 0; i < 5; i += 1) await seedRevokeJob(exhaustedKeyId, "failed");

      const { keyId: retryableKeyId } = await seedStuckRevokingKey();
      for (let i = 0; i < 4; i += 1) await seedRevokeJob(retryableKeyId, "failed");

      const result = await repository.rearmStuckRevokes();

      // The permanent stop: `failed` rows are never pruned, so this count is
      // monotonic and survives any future retention change.
      expect(result).toEqual({ rearmed: 1 });
      expect(await revokeJobsFor(exhaustedKeyId)).toHaveLength(5);
      const retryableJobs = await revokeJobsFor(retryableKeyId);
      expect(retryableJobs).toHaveLength(5);
      expect(retryableJobs.filter((job) => job.status === "pending")).toHaveLength(1);
    },
  );

  runDatabaseTest(
    "bound: only a revoking key is re-armed -- active and revoked keys on the same qualifying node are not",
    async () => {
      if (!database || !repository) return;
      // Every key seeded elsewhere in this file is hardcoded state: "revoking",
      // so nothing would fail here if `eq(vpnKeys.state, "revoking")` were
      // dropped from the query. Prove the bound by seeding states that must
      // NEVER be re-armed on a node that otherwise fully qualifies (enabled,
      // fresh last_sync_at, no live job), alongside a revoking key in the SAME
      // run -- having both in one test is what proves the clause rather than
      // the setup.
      const { keyId: activeKeyId } = await seedStuckRevokingKey({
        state: "active",
      });
      const { keyId: revokedKeyId } = await seedStuckRevokingKey({
        state: "revoked",
      });
      const { keyId: revokingKeyId } = await seedStuckRevokingKey();

      const result = await repository.rearmStuckRevokes();

      expect(result).toEqual({ rearmed: 1 });
      expect(await revokeJobsFor(activeKeyId)).toHaveLength(0);
      expect(await revokeJobsFor(revokedKeyId)).toHaveLength(0);
      expect(await revokeJobsFor(revokingKeyId)).toHaveLength(1);
    },
  );

  /**
   * `count` stuck-revoking keys sharing one qualifying node, for the cap bound
   * test below -- a single batched insert rather than `count` calls to
   * `seedStuckRevokingKey`, which would each open their own user/node.
   */
  const seedManyStuckRevokingKeys = async (count: number): Promise<string[]> => {
    if (!database) throw new Error("Database test is disabled");
    const credentials = encryptSecret("api-key", keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [user] = await database.db
      .insert(users)
      .values({ email: `rearm-cap-${randomBytes(6).toString("hex")}@example.com` })
      .returning();
    const [node] = await database.db
      .insert(nodes)
      .values({
        name: `rearm-cap-node-${randomBytes(6).toString("hex")}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        maxPeers: 500,
        enabled: true,
        lastSyncAt: new Date(),
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
    if (!user || !node) throw new Error("Failed to seed cap-test context");
    const rows = await database.db
      .insert(vpnKeys)
      .values(
        Array.from({ length: count }, () => ({
          ownerId: user.id,
          nodeId: node.id,
          nodeLabel: `ap_rearm_cap_${randomBytes(6).toString("hex")}`,
          protocol: "awg2" as const,
          state: "revoking" as const,
          routeProfile: "full_tunnel" as const,
        })),
      )
      .returning({ id: vpnKeys.id });
    return rows.map((row) => row.id);
  };

  runDatabaseTest(
    "bound: caps one sweep at REARM_STUCK_REVOKES_LIMIT, and a second sweep picks up the remainder",
    async () => {
      if (!database || !repository) return;
      const overflow = 5;
      await seedManyStuckRevokingKeys(REARM_STUCK_REVOKES_LIMIT + overflow);

      const armedKeyIds = async (): Promise<Set<string>> => {
        if (!database) throw new Error("Database test is disabled");
        const rows = await database.db
          .select({ keyId: sql<string>`${jobOutbox.payload} ->> 'keyId'` })
          .from(jobOutbox)
          .where(eq(jobOutbox.type, "vpn-key.revoke"));
        return new Set(rows.map((row) => row.keyId));
      };

      const first = await repository.rearmStuckRevokes();
      // Asserted against the named constant, not the literal 25, so this test
      // cannot silently drift from the query if the cap ever changes.
      expect(first).toEqual({ rearmed: REARM_STUCK_REVOKES_LIMIT });
      expect((await armedKeyIds()).size).toBe(REARM_STUCK_REVOKES_LIMIT);

      // The keys armed above each now have a live "pending" job, so the
      // "no live job" bound excludes them from a second sweep -- this proves
      // the cap limits one PASS's work rather than permanently blocking the
      // remainder, which a bare arithmetic check on the count would not show.
      const second = await repository.rearmStuckRevokes();
      expect(second).toEqual({ rearmed: overflow });
      expect((await armedKeyIds()).size).toBe(REARM_STUCK_REVOKES_LIMIT + overflow);
    },
  );

  runDatabaseTest(
    "deleteCompletedJobsBefore prunes only old completed rows, sparing failed rows and both singletons",
    async () => {
      if (!database || !repository) return;
      const now = new Date();
      const oldCutoff = new Date(now.getTime() - 30 * DAY_MS);
      const veryOld = new Date(now.getTime() - 40 * DAY_MS);

      const [completedOld] = await database.db
        .insert(jobOutbox)
        .values({
          type: "vpn-key.revoke",
          deduplicationKey: `vpn-key.revoke:completed-old:${randomBytes(6).toString("hex")}`,
          payload: {},
          status: "completed",
          completedAt: veryOld,
        })
        .returning();
      const [failedOld] = await database.db
        .insert(jobOutbox)
        .values({
          type: "vpn-key.revoke",
          deduplicationKey: `vpn-key.revoke:failed-old:${randomBytes(6).toString("hex")}`,
          payload: {},
          status: "failed",
          completedAt: veryOld,
        })
        .returning();
      await database.db.insert(jobOutbox).values([
        {
          type: "rules.refresh",
          deduplicationKey: RULES_REFRESH_DEDUPLICATION_KEY,
          payload: {},
          status: "completed",
          completedAt: veryOld,
        },
        {
          type: "access.sync",
          deduplicationKey: ACCESS_SYNC_DEDUPLICATION_KEY,
          payload: {},
          status: "completed",
          completedAt: veryOld,
        },
      ]);
      if (!completedOld || !failedOld) {
        throw new Error("Failed to seed deleteCompletedJobsBefore rows");
      }

      await repository.deleteCompletedJobsBefore(oldCutoff);

      const remainingIds = (await database.db.select({ id: jobOutbox.id }).from(jobOutbox)).map(
        (row) => row.id,
      );
      expect(remainingIds).not.toContain(completedOld.id);
      expect(remainingIds).toContain(failedOld.id);
      const [rulesRefreshRow] = await database.db
        .select()
        .from(jobOutbox)
        .where(eq(jobOutbox.deduplicationKey, RULES_REFRESH_DEDUPLICATION_KEY));
      const [accessSyncRow] = await database.db
        .select()
        .from(jobOutbox)
        .where(eq(jobOutbox.deduplicationKey, ACCESS_SYNC_DEDUPLICATION_KEY));
      expect(rulesRefreshRow).toBeDefined();
      expect(accessSyncRow).toBeDefined();
    },
  );
});

describe("PostgresWorkerRepository rule pinning", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const repository = database
    ? new PostgresWorkerRepository({
        db: database.db,
        keyring,
        activeKeyVersion: 1,
      })
    : null;

  const storedInput = (version: string) => ({
    profile: "ru_blacklist" as const,
    version,
    sourceUrl: "https://iplist.opencck.org/?format=text&data=cidr4",
    etag: null,
    checksum: version,
    payload: { cidrs: ["203.0.113.0/24"], domains: ["example.ru"] },
    validationReport: { cidrCount: 1, domainCount: 1 },
    fetchedAt: new Date(),
  });

  beforeEach(async () => {
    if (!database) return;
    await database.db.delete(routeRuleVersions);
  });

  afterAll(async () => {
    if (database) await database.client.end();
  });

  runDatabaseTest("reports whether the live version is pinned", async () => {
    if (!database || !repository) return;
    await repository.activateRuleVersion(storedInput("v1"));
    expect(await repository.getLastKnownGoodRule("ru_blacklist")).toMatchObject({
      version: "v1",
      pinned: false,
    });

    await database.db
      .update(routeRuleVersions)
      .set({ pinnedAt: new Date() })
      .where(eq(routeRuleVersions.version, "v1"));

    expect(await repository.getLastKnownGoodRule("ru_blacklist")).toMatchObject({
      version: "v1",
      pinned: true,
    });
  });

  runDatabaseTest(
    "stores a held-back version as superseded and never published",
    async () => {
      if (!database || !repository) return;
      await repository.storeUnpublishedRule(storedInput("v2"));

      const [row] = await database.db
        .select()
        .from(routeRuleVersions)
        .where(eq(routeRuleVersions.version, "v2"));
      expect(row?.status).toBe("superseded");
      expect(row?.publishedAt).toBeNull();
      expect(row?.pinnedAt).toBeNull();

      // The fetcher re-derives the same version on every tick while the pin
      // holds, so the second store has to be a no-op rather than a conflict.
      await expect(
        repository.storeUnpublishedRule(storedInput("v2")),
      ).resolves.toBeUndefined();
    },
  );

  runDatabaseTest("refuses to publish over a pin it finds mid-flight", async () => {
    if (!database || !repository) return;
    // The race the fetcher's own check cannot close: an admin pins between the
    // fetcher reading getLastKnownGoodRule and this write landing.
    await repository.activateRuleVersion(storedInput("v1"));
    await database.db
      .update(routeRuleVersions)
      .set({ pinnedAt: new Date() })
      .where(eq(routeRuleVersions.version, "v1"));

    await repository.activateRuleVersion(storedInput("v2"));

    const rows = await database.db.select().from(routeRuleVersions);
    // v2 was dropped rather than published; the pinned version is untouched
    // and still the only active one.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe("v1");
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.pinnedAt).not.toBeNull();
  });
});
