import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bridgeFrpProxyName,
  type ProbeRunRequest,
  type ProbeRunState,
} from "@amnezia/contracts";
import {
  createDatabase,
  encryptSecret,
  ENDPOINT_CHANGED_DETAIL,
  jobOutbox,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodes,
  reachabilityProbe,
  resetNodeEndpointEvidence,
  SERVICE_ACCOUNT_EMAIL,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
} from "@amnezia/db";
import { inspectAwgVpnLink } from "@amnezia/vpn-config";

import { awgServiceLink } from "./awgArtifact.fixture.js";
import type { ProbeClient } from "./probeAgent.js";
import { ingestRun, OBSOLETE_DETAIL } from "./reachability.js";
import {
  BRIDGE_UNRENDERABLE_REASON,
  BRIDGE_UNSUPPORTED_REASON,
  PostgresReachabilityRepository,
} from "./reachabilityRepository.js";
import { createReachabilityTask } from "./reachabilityTask.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type SentTarget = ProbeRunRequest["targets"][number];
type Verdict = { handshake: boolean; http: boolean; egressIp?: string | null };

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
};

const level = (ok: boolean) => ({ ok, detail: ok ? null : "timeout", latencyMs: ok ? 30 : null });

describe("reachability of bridged nodes (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  const createdNodeIds: string[] = [];
  const createdBridgeIds: string[] = [];
  const createdUserIds: string[] = [];
  let repository: PostgresReachabilityRepository;
  let serviceAccountId: string;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  beforeAll(async () => {
    if (!database) return;
    repository = new PostgresReachabilityRepository({ db: database.db, keyring });
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
        .values({ email: SERVICE_ACCOUNT_EMAIL, role: "user", serviceAccount: true })
        .returning({ id: users.id });
      if (!created) throw new Error("Failed to seed the service account");
      serviceAccountId = created.id;
      createdUserIds.push(created.id);
    }
  });

  afterEach(async () => {
    if (!database) return;
    await database.db.delete(reachabilityProbe);
    await database.db.delete(jobOutbox).where(like(jobOutbox.type, "notify.reachability%"));
    if (createdNodeIds.length > 0) {
      await database.db
        .delete(vpnBridgeRoutes)
        .where(inArray(vpnBridgeRoutes.nodeId, createdNodeIds));
    }
    if (createdBridgeIds.length > 0) {
      await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, createdBridgeIds));
    }
    if (createdNodeIds.length > 0) {
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.nodeId, createdNodeIds));
      // Results, state and history cascade with the node.
      await database.db.delete(nodes).where(inArray(nodes.id, createdNodeIds));
    }
    createdNodeIds.length = 0;
    createdBridgeIds.length = 0;
  });

  afterAll(async () => {
    if (!database) return;
    if (createdUserIds.length > 0) {
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.ownerId, createdUserIds));
      await database.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await database.client.end();
  });

  /** A node serving AWG 3.1 and AWG 2, with both probe keys active. */
  const seedNode = async (options: { publicIp?: string | null; awg3Link?: string } = {}) => {
    const credentials = encryptSecret("k".repeat(32), keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `bridged-${runTag}-${createdNodeIds.length}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        protocol: "awg3",
        capabilities: { awg3: true, awg2: true },
        publicIp: options.publicIp === undefined ? "192.0.2.10" : options.publicIp,
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
    const links = {
      awg3: options.awg3Link ?? awgServiceLink(),
      awg2: awgServiceLink({ protocolVersion: "2" }),
    };
    for (const protocol of ["awg3", "awg2"] as const) {
      const config = encryptSecret(links[protocol], keyring, 1);
      await db().insert(vpnKeys).values({
        ownerId: serviceAccountId,
        nodeId: node.id,
        nodeLabel: `bridged_${runTag}_${randomBytes(3).toString("hex")}`,
        protocol,
        state: "active",
        deviceType: "unspecified",
        deviceLabel: "probe",
        routeProfile: "full_tunnel",
        configCiphertext: config.ciphertext,
        configNonce: config.nonce,
        configAuthTag: config.authTag,
        configKeyVersion: config.keyVersion,
      });
    }
    return node;
  };

  const seedBridge = async (name: string) => {
    const seed = parseInt(runTag, 16);
    const [bridge] = await db()
      .insert(vpnBridges)
      .values({
        name,
        publicIpv4: `46.${(seed >> 8) & 0xff}.${seed & 0xff}.${createdBridgeIds.length + 1}`,
        managementStatus: "ok",
        lastObservedAt: new Date(),
      })
      .returning();
    if (!bridge) throw new Error("Failed to seed bridge");
    createdBridgeIds.push(bridge.id);
    return bridge;
  };

  const seedRoute = async (
    nodeId: string,
    bridgeId: string,
    state: "draft" | "active" = "draft",
    publicUdpPort = 41000,
  ) => {
    const id = randomUUID();
    await db().insert(vpnBridgeRoutes).values({
      id,
      nodeId,
      bridgeId,
      publicUdpPort,
      state,
      frpProxyName: bridgeFrpProxyName(id),
      ...(state === "active" ? { activatedAt: new Date() } : {}),
    });
    if (state === "active") {
      await db().update(nodes).set({ vpnEndpointRevision: 1 }).where(eq(nodes.id, nodeId));
    }
    return id;
  };

  /**
   * The persistence steps of the Control API's endpoint change
   * (`changeNodeEndpoint`), guards left out: node row `FOR NO KEY UPDATE`
   * first, then the routes, the revision bump and the real shared evidence
   * reset.
   */
  const switchEndpoint = async (tx: Tx, nodeId: string, routeId: string | null) => {
    const [node] = await tx
      .select({ revision: nodes.vpnEndpointRevision })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .for("no key update");
    if (!node) throw new Error("No node");
    const now = new Date();
    await tx
      .update(vpnBridgeRoutes)
      .set({ state: "retiring", retiringSince: now })
      .where(and(eq(vpnBridgeRoutes.nodeId, nodeId), eq(vpnBridgeRoutes.state, "active")));
    if (routeId) {
      await tx
        .update(vpnBridgeRoutes)
        .set({ state: "active", activatedAt: now, retiringSince: null })
        .where(eq(vpnBridgeRoutes.id, routeId));
    }
    await tx
      .update(nodes)
      .set({ vpnEndpointRevision: node.revision + 1 })
      .where(eq(nodes.id, nodeId));
    await resetNodeEndpointEvidence(tx, nodeId, now);
  };

  const seedProbe = async (
    options: { capabilities?: string[] | null; failThreshold?: number } = {},
  ) => {
    await db().delete(reachabilityProbe);
    const credentials = encryptSecret("k".repeat(32), keyring, 1);
    await db()
      .insert(reachabilityProbe)
      .values({
        label: "Testland",
        apiBaseUrl: "http://probe.test",
        credentialsCiphertext: credentials.ciphertext,
        credentialsNonce: credentials.nonce,
        credentialsAuthTag: credentials.authTag,
        credentialsKeyVersion: credentials.keyVersion,
        controlUrl: "https://example.com/",
        failThreshold: options.failThreshold ?? 1,
        capabilities:
          options.capabilities === undefined ? ["bridge-measurement"] : options.capabilities,
        capabilitiesCheckedAt: new Date(),
      });
  };

  /**
   * A probe that answers each target of the last run it was asked for with
   * `verdict`, and a task driven by a hand-moved clock.
   */
  const harness = (verdict: (target: SentTarget) => Verdict) => {
    const sent: ProbeRunRequest[] = [];
    let at = new Date();
    const client: ProbeClient = {
      capabilities: vi.fn(() =>
        Promise.resolve({ apiVersion: 1, capabilities: ["bridge-measurement"] }),
      ),
      startRun: vi.fn((request: ProbeRunRequest) => {
        sent.push(request);
        return Promise.resolve({ runId: request.runId });
      }),
      latestRun: vi.fn((): Promise<ProbeRunState | null> => {
        const request = sent.at(-1);
        if (!request) return Promise.resolve(null);
        return Promise.resolve({
          runId: request.runId,
          startedAt: at.toISOString(),
          finishedAt: at.toISOString(),
          control: level(true),
          results: request.targets.map((target) => {
            const outcome = verdict(target);
            return {
              targetId: target.targetId,
              protocol: target.protocol,
              status: "done" as const,
              detail: null,
              endpointHost: null,
              egressIp: outcome.http ? (outcome.egressIp ?? "192.0.2.10") : null,
              levels: {
                // Diagnostics only: a bridge does not answer ping or SSH.
                ping: level(false),
                tcp: level(false),
                handshake: level(outcome.handshake),
                http: level(outcome.http),
              },
            };
          }),
        });
      }),
    };
    const task = createReachabilityTask({
      repository,
      createProbeClient: () => client,
      now: () => at,
    });
    return {
      sent,
      client,
      /** One tick, `minutes` after the previous one. */
      tick: async (minutes = 1) => {
        at = new Date(at.getTime() + minutes * 60_000);
        await task();
      },
    };
  };

  const resultsOf = async (nodeId: string) =>
    new Map(
      (
        await db()
          .select()
          .from(nodeReachabilityResults)
          .where(eq(nodeReachabilityResults.nodeId, nodeId))
      ).map((row) => [row.protocol, row]),
    );
  const stateOf = async (nodeId: string) =>
    (
      await db()
        .select()
        .from(nodeReachabilityState)
        .where(eq(nodeReachabilityState.nodeId, nodeId))
    )[0];
  const alerts = async () =>
    db().select().from(jobOutbox).where(eq(jobOutbox.type, "notify.reachability"));
  const revisionOf = async (nodeId: string) =>
    (
      await db()
        .select({ revision: nodes.vpnEndpointRevision })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
    )[0]?.revision;
  const sentFor = (request: ProbeRunRequest | undefined, nodeId: string) =>
    new Map(
      (request?.targets ?? [])
        .filter((target) => target.targetId.startsWith(`${nodeId}:`))
        .map((target) => [target.protocol, target]),
    );

  /** Resolves once another session waits for a row lock (files run one at a time). */
  const waitForLockWait = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await db().execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("No session started waiting for a lock");
  };

  runDatabaseTest(
    "measures a bridged node's AWG 3.1 through the bridge, AWG 2 directly, and reports the bridge's failure for that path",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active", 41007);
      await seedProbe();
      // The bridge is down; the node itself answers directly.
      const probe = harness((target) =>
        target.protocol === "awg3"
          ? { handshake: false, http: false }
          : { handshake: true, http: true },
      );

      await probe.tick();
      const sent = sentFor(probe.sent[0], node.id);
      const bridged = sent.get("awg3");
      expect(bridged?.targetId).toBe(`${node.id}:awg3:r1`);
      expect(inspectAwgVpnLink(bridged?.config ?? "").endpoint).toEqual({
        host: bridge.publicIpv4,
        port: 41007,
      });
      // The node's origin exit IP is the comparison target.
      expect(bridged?.expectedEgressIp).toBe("192.0.2.10");
      const direct = sent.get("awg2");
      expect(direct?.targetId).toBe(`${node.id}:awg2`);
      expect(direct?.config).toBe(awgServiceLink({ protocolVersion: "2" }));

      await probe.tick();
      const results = await resultsOf(node.id);
      expect(results.get("awg3")).toMatchObject({ status: "failed", detail: "no handshake" });
      expect(results.get("awg2")).toMatchObject({ status: "ok" });
      // The server badge follows the bridged path, not the working AWG 2.
      expect(await stateOf(node.id)).toMatchObject({ status: "failed" });
      const [alert] = await alerts();
      expect((alert?.payload as { text: string }).text.split("\n")[0]).toBe(
        `${node.name} (192.0.2.10) через мост ${bridge.name} (${bridge.publicIpv4}:41007) недоступен из Testland`,
      );
      // The widget shows the levels the verdict came from.
      const snapshot = await repository.loadWidgetSnapshot(new Date());
      const shown = snapshot?.input.nodes.find((entry) => entry.name === node.name);
      expect(shown?.status).toBe("failed");
      expect(shown?.levels?.handshake.ok).toBe(false);
      // A failing bridge never changes the assignment exports use.
      expect(await revisionOf(node.id)).toBe(1);
      const [route] = await db()
        .select({ state: vpnBridgeRoutes.state })
        .from(vpnBridgeRoutes)
        .where(eq(vpnBridgeRoutes.nodeId, node.id));
      expect(route?.state).toBe("active");
    },
  );

  runDatabaseTest("reuses a port number across different bridges without mixing endpoints", async () => {
    const first = await seedNode();
    const second = await seedNode();
    const bridgeA = await seedBridge(`A ${runTag}`);
    const bridgeB = await seedBridge(`B ${runTag}`);
    await seedRoute(first.id, bridgeA.id, "active", 41000);
    await seedRoute(second.id, bridgeB.id, "active", 41000);
    const targets = await repository.listTargets({ bridgeMeasurement: true });
    const endpointOf = (nodeId: string) => {
      const target = targets.find((t) => t.nodeId === nodeId && t.protocol === "awg3");
      return inspectAwgVpnLink(target?.config ?? "").endpoint;
    };
    expect(endpointOf(first.id)).toEqual({ host: bridgeA.publicIpv4, port: 41000 });
    expect(endpointOf(second.id)).toEqual({ host: bridgeB.publicIpv4, port: 41000 });
  });

  runDatabaseTest(
    "a bridged node without a known origin IP is sent an explicit null and its observed egress is stored",
    async () => {
      const node = await seedNode({ publicIp: null });
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active");
      await seedProbe();
      const probe = harness(() => ({ handshake: true, http: true, egressIp: "198.51.100.7" }));

      await probe.tick();
      const sent = sentFor(probe.sent[0], node.id);
      const bridged = sent.get("awg3");
      expect(bridged && "expectedEgressIp" in bridged).toBe(true);
      expect(bridged?.expectedEgressIp).toBeNull();
      // AWG 2 keeps the direct path's endpoint-host fallback: omitted.
      const direct = sent.get("awg2");
      expect(direct && "expectedEgressIp" in direct).toBe(false);

      await probe.tick();
      expect((await resultsOf(node.id)).get("awg3")).toMatchObject({
        status: "ok",
        egressIp: "198.51.100.7",
      });
      expect(await stateOf(node.id)).toMatchObject({ status: "ok" });
    },
  );

  runDatabaseTest(
    "a legacy probe leaves the bridged path unknown without an alert and keeps measuring AWG 2 directly",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active");
      await seedProbe({ capabilities: [] });
      const probe = harness(() => ({ handshake: false, http: false }));

      await probe.tick();
      expect([...sentFor(probe.sent[0], node.id).keys()]).toEqual(["awg2"]);

      await probe.tick();
      const results = await resultsOf(node.id);
      expect(results.get("awg3")).toMatchObject({
        status: "error",
        detail: BRIDGE_UNSUPPORTED_REASON,
      });
      expect(results.get("awg2")).toMatchObject({ status: "failed" });
      expect(await stateOf(node.id)).toMatchObject({ status: "error", consecutiveFailures: 0 });
      expect(await alerts()).toEqual([]);
    },
  );

  runDatabaseTest("never sends the direct config under the bridged identity", async () => {
    // An AWG 3 service key without the 3.1 marker: the bridge endpoint does
    // not apply to it.
    const node = await seedNode({ awg3Link: awgServiceLink({ protocolVersion: null }) });
    const bridge = await seedBridge(`Bridge ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    const targets = await repository.listTargets({ bridgeMeasurement: true });
    expect(targets.find((t) => t.nodeId === node.id && t.protocol === "awg3")).toMatchObject({
      targetId: `${node.id}:awg3:r1`,
      config: null,
      unavailableReason: BRIDGE_UNRENDERABLE_REASON,
    });
  });

  runDatabaseTest(
    "a result returning after reassignment to another bridge is unknown and the next run uses the new bridge",
    async () => {
      const node = await seedNode();
      const bridgeA = await seedBridge(`A ${runTag}`);
      const bridgeB = await seedBridge(`B ${runTag}`);
      await seedRoute(node.id, bridgeA.id, "active", 41000);
      const toB = await seedRoute(node.id, bridgeB.id, "draft", 41000);
      await seedProbe();
      const probe = harness((target) => ({
        handshake: target.protocol === "awg2",
        http: target.protocol === "awg2",
      }));

      await probe.tick();
      expect(sentFor(probe.sent[0], node.id).get("awg3")?.targetId).toBe(`${node.id}:awg3:r1`);
      await db().transaction((tx) => switchEndpoint(tx, node.id, toB));

      await probe.tick();
      const results = await resultsOf(node.id);
      expect(results.has("awg3")).toBe(false);
      expect(results.get("awg2")).toMatchObject({ status: "ok" });
      expect(await stateOf(node.id)).toMatchObject({ status: "error", detail: OBSOLETE_DETAIL });
      expect(await alerts()).toEqual([]);

      // The next run goes through bridge B under the new revision.
      await probe.tick(61);
      const next = sentFor(probe.sent[1], node.id).get("awg3");
      expect(next?.targetId).toBe(`${node.id}:awg3:r2`);
      expect(inspectAwgVpnLink(next?.config ?? "").endpoint?.host).toBe(bridgeB.publicIpv4);
    },
  );

  runDatabaseTest(
    "a result returning after the bridge was switched off (Direct) is unknown, AWG 2 stays measured",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active");
      await seedProbe();
      const probe = harness(() => ({ handshake: false, http: false }));

      await probe.tick();
      await db().transaction((tx) => switchEndpoint(tx, node.id, null));
      await probe.tick();

      const results = await resultsOf(node.id);
      expect(results.has("awg3")).toBe(false);
      expect(results.get("awg2")).toMatchObject({ status: "failed" });
      // Direct again: the obsolete AWG 3.1 counts as unknown, so a failed
      // AWG 2 alone does not make the node unreachable.
      expect(await stateOf(node.id)).toMatchObject({ status: "error", consecutiveFailures: 0 });
      expect(await alerts()).toEqual([]);
      expect(
        await db()
          .select()
          .from(nodeReachabilityHistory)
          .where(
            and(
              eq(nodeReachabilityHistory.nodeId, node.id),
              eq(nodeReachabilityHistory.status, "failed"),
            ),
          ),
      ).toEqual([]);
    },
  );

  runDatabaseTest(
    "an endpoint change committed while the ingest waits on the node lock leaves no obsolete outcome or Telegram alert",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active");
      await seedProbe({ failThreshold: 1 });
      // Both paths fail: at threshold 1 the ingest would alert at once.
      const probe = harness(() => ({ handshake: false, http: false }));
      await probe.tick();

      // The run's results are in, and the panel has read them. Now an admin
      // selects Direct, and the change is still uncommitted when the ingest
      // reaches the node rows.
      const held = deferred();
      const lockTaken = deferred();
      const change = db().transaction(async (tx) => {
        await switchEndpoint(tx, node.id, null);
        lockTaken.resolve();
        await held.promise;
      });
      await lockTaken.promise;
      let ingestDone = false;
      const ingest = probe.tick().then(() => {
        ingestDone = true;
      });
      try {
        await waitForLockWait();
        expect(ingestDone).toBe(false);
      } finally {
        // Never leave the change open: it would block every later test.
        held.resolve();
        await change;
        await ingest;
      }

      const results = await resultsOf(node.id);
      expect(results.has("awg3")).toBe(false);
      expect(await stateOf(node.id)).toMatchObject({
        status: "error",
        consecutiveFailures: 0,
        alertedAt: null,
      });
      expect(await alerts()).toEqual([]);
      const [probeRow] = await db().select().from(reachabilityProbe);
      expect(probeRow?.currentRunId).toBeNull();
      expect(probeRow?.lastIngestedRunId).toBe(probe.sent[0]?.runId);
    },
  );

  runDatabaseTest(
    "an endpoint change that starts while the ingest holds the node lock waits, then resets what was ingested",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active");
      await seedProbe();
      const runId = randomUUID();
      await db().update(reachabilityProbe).set({ currentRunId: runId, currentRunStartedAt: new Date() });
      const now = new Date();
      const changes: Promise<void>[] = [];
      let changeDone = false;
      await repository.ingest({ runId, now }, async ({ targets, previous }) => {
        // Classification input read; the change must wait for this commit.
        changes.push(
          db()
            .transaction((tx) => switchEndpoint(tx, node.id, null))
            .then(() => {
              changeDone = true;
            }),
        );
        await waitForLockWait();
        expect(changeDone).toBe(false);
        const out = ingestRun({
          runId,
          now,
          label: "Testland",
          failThreshold: 1,
          controlOk: true,
          targets,
          results: targets.map((target) => ({
            targetId: target.targetId,
            protocol: target.protocol,
            status: "done" as const,
            detail: null,
            endpointHost: null,
            egressIp: "192.0.2.10",
            levels: { ping: level(true), tcp: level(true), handshake: level(true), http: level(true) },
          })),
          previous,
        });
        return {
          outcomes: out.outcomes,
          states: out.states,
          notices: out.notices,
          staleAlertedAt: null,
          mass: false,
        };
      });
      await Promise.all(changes);
      expect(changes).toHaveLength(1);
      expect(changeDone).toBe(true);
      expect(await revisionOf(node.id)).toBe(2);
      // The ingest committed revision-1 evidence; the change then reset it.
      expect((await resultsOf(node.id)).has("awg3")).toBe(false);
      expect((await resultsOf(node.id)).get("awg2")).toMatchObject({ status: "ok" });
      expect(await stateOf(node.id)).toMatchObject({
        status: "error",
        detail: ENDPOINT_CHANGED_DETAIL,
      });
    },
  );

  runDatabaseTest(
    "an open incident survives an endpoint change and closes with exactly one recovery",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      const route = await seedRoute(node.id, bridge.id, "draft");
      await seedProbe();
      const alertedAt = new Date(Date.now() - 3_600_000);
      await db().insert(nodeReachabilityState).values({
        nodeId: node.id,
        status: "failed",
        consecutiveFailures: 4,
        failingSince: new Date(Date.now() - 7_200_000),
        alertedAt,
        alertKind: "node",
        checkedAt: alertedAt,
      });
      // Direct is blocked; the admin moves the node onto the bridge.
      await db().transaction((tx) => switchEndpoint(tx, node.id, route));
      expect(await stateOf(node.id)).toMatchObject({
        status: "error",
        consecutiveFailures: 0,
        failingSince: null,
        alertedAt,
        alertKind: "node",
      });

      const probe = harness((target) => ({
        handshake: target.protocol === "awg3",
        http: target.protocol === "awg3",
      }));
      await probe.tick();
      await probe.tick();
      await probe.tick(61);
      await probe.tick();
      const sentAlerts = await alerts();
      expect(sentAlerts).toHaveLength(1);
      expect((sentAlerts[0]?.payload as { text: string }).text).toContain("снова доступен");
      expect(sentAlerts[0]?.deduplicationKey).toBe(
        `notify.reachability:up:${node.id}:${alertedAt.toISOString()}`,
      );
      expect(await stateOf(node.id)).toMatchObject({ status: "ok", alertedAt: null });
    },
  );

  runDatabaseTest(
    "a failure streak of the old endpoint cannot open an alert on the new one below the threshold",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      const route = await seedRoute(node.id, bridge.id, "draft");
      await seedProbe({ failThreshold: 2 });
      await db().insert(nodeReachabilityState).values({
        nodeId: node.id,
        status: "failed",
        consecutiveFailures: 1,
        failingSince: new Date(Date.now() - 3_600_000),
        checkedAt: new Date(),
      });
      await db().transaction((tx) => switchEndpoint(tx, node.id, route));

      // One failure through the bridge: the first of the new path's streak.
      const probe = harness(() => ({ handshake: false, http: false }));
      await probe.tick();
      await probe.tick();
      expect(await stateOf(node.id)).toMatchObject({ status: "failed", consecutiveFailures: 1 });
      expect(await alerts()).toEqual([]);
    },
  );
});
