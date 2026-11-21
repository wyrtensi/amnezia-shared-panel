import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  awgGeneratorPresets,
  bridgeFrpProxyName,
  type ProbeRunRequest,
  type ProbeRunState,
} from "@amnezia/contracts";
import {
  bridgeReachabilityState,
  createDatabase,
  encryptSecret,
  ENDPOINT_CHANGED_DETAIL,
  jobOutbox,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodeVpnEndpoints,
  nodes,
  portalPolicy,
  reachabilityProbe,
  resetNodeEndpointEvidence,
  SERVICE_ACCOUNT_EMAIL,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
} from "@amnezia/db";
import { decodeVpnLink, inspectAwgVpnLink, readAwgLastConfig } from "@amnezia/vpn-config";

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
    await database.db.delete(portalPolicy);
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

  const seedPortalPolicy = async (useBridge: boolean) => {
    await db().delete(portalPolicy);
    await db().insert(portalPolicy).values({ useBridge });
  };

  const seedProbe = async (
    options: { capabilities?: string[] | null; failThreshold?: number; probeDirectWhenBridged?: boolean } = {},
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
        probeDirectWhenBridged: options.probeDirectWhenBridged ?? false,
        capabilities:
          options.capabilities === undefined ? ["bridge-measurement"] : options.capabilities,
        capabilitiesCheckedAt: new Date(),
      });
  };

  /**
   * A probe that answers each target of the last run it was asked for with
   * `verdict`, and a task driven by a hand-moved clock.
   */
  const harness = (verdict: (target: SentTarget) => Verdict, bridgeOnline = () => true) => {
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
          bridgeResults: request.bridgeTargets?.map(({ targetId, host, httpsHostname }) => ({
            targetId,
            host,
            status: "done" as const,
            detail: null,
            levels: {
              ping: level(bridgeOnline()),
              tcp: level(bridgeOnline()),
              ...(httpsHostname ? { https: level(bridgeOnline()) } : {}),
            },
          })),
          results: request.targets.map((target) => {
            const outcome = verdict(target);
            return {
              targetId: target.targetId,
              protocol: target.protocol,
              status: "done" as const,
              detail: null,
              endpointHost: inspectAwgVpnLink(target.config).endpoint?.host ?? null,
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
  const directEndpointsOf = (nodeId: string) =>
    db().select().from(nodeVpnEndpoints)
      .where(eq(nodeVpnEndpoints.nodeId, nodeId))
      .orderBy(nodeVpnEndpoints.ordinal);

  const seedDirectEndpoints = (nodeId: string) =>
    db().insert(nodeVpnEndpoints).values([
      { nodeId, ordinal: 1, address: "192.0.2.10", name: "Primary" },
      { nodeId, ordinal: 2, address: "192.0.2.20", name: "Backup" },
      { nodeId, ordinal: 3, address: "192.0.2.30", name: "Disabled", enabled: false },
    ]).returning();
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

  const preset = (id: "issued" | "dns_response") => {
    const found = awgGeneratorPresets().find((entry) => entry.id === id);
    if (!found) throw new Error("Missing generator preset");
    return found.settings;
  };

  const clientFields = (link: string) => {
    const lastConfig = decodeVpnLink(link).containers?.[0]?.awg?.last_config;
    const conf = readAwgLastConfig(lastConfig)?.lastConfig.config;
    if (typeof conf !== "string") throw new Error("Missing embedded service config");
    return {
      mtu: /^MTU = (\d+)$/m.exec(conf)?.[1],
      jc: /^Jc = (\d+)$/m.exec(conf)?.[1],
    };
  };

  runDatabaseTest("applies inherited and overridden generator profiles to the direct IP targets", async () => {
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10" }) });
    const [, backup] = await seedDirectEndpoints(node.id);
    if (!backup) throw new Error("Missing backup endpoint");
    await db().update(nodes).set({ awgGenerator: { ...preset("dns_response"), mtu: 1300 } })
      .where(eq(nodes.id, node.id));
    await db().update(nodeVpnEndpoints).set({ awgGenerator: { ...preset("issued"), mtu: 1380 } })
      .where(eq(nodeVpnEndpoints.id, backup.id));
    await db().update(vpnKeys).set({
      awgClientProfile: { version: 1, revision: 3, jc: 6, jmin: 41, jmax: 100, cpsOrder: 0 },
    }).where(and(eq(vpnKeys.nodeId, node.id), eq(vpnKeys.protocol, "awg3")));

    const targets = await repository.listTargets({ bridgeMeasurement: true });
    const awg31 = targets.filter((target) => target.protocol === "awg3" && target.config !== null);
    expect(awg31.map((target) => {
      const link = target.config ?? "";
      return { endpoint: inspectAwgVpnLink(link).endpoint?.host, ...clientFields(link) };
    })).toEqual([
      { endpoint: "192.0.2.10", mtu: "1300", jc: "4" },
      { endpoint: "192.0.2.20", mtu: "1380", jc: "6" },
    ]);
  });

  runDatabaseTest("keeps other nodes measurable when one service profile is unusable", async () => {
    const invalid = await seedNode();
    const valid = await seedNode();
    await db().update(vpnKeys).set({ awgClientProfile: { version: 99 } })
      .where(and(eq(vpnKeys.nodeId, invalid.id), eq(vpnKeys.protocol, "awg3")));

    const targets = await repository.listTargets({ bridgeMeasurement: true });
    expect(targets.find((target) => target.nodeId === invalid.id && target.protocol === "awg3"))
      .toMatchObject({ config: null, unavailableReason: "service key client settings could not be applied" });
    expect(typeof targets.find((target) => target.nodeId === valid.id && target.protocol === "awg3")?.config)
      .toBe("string");
  });

  runDatabaseTest("records bridged IP variants separately and discards a result for a changed profile", async () => {
    await seedProbe();
    await seedPortalPolicy(true);
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10" }) });
    const [, backup] = await seedDirectEndpoints(node.id);
    if (!backup) throw new Error("Missing backup endpoint");
    const bridge = await seedBridge(`Variants ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    await db().update(nodes).set({ awgGenerator: { ...preset("dns_response"), mtu: 1300 } })
      .where(eq(nodes.id, node.id));
    const setBackupMtu = (mtu: number) => db().update(nodeVpnEndpoints)
      .set({ awgGenerator: { ...preset("issued"), mtu } })
      .where(eq(nodeVpnEndpoints.id, backup.id));
    await setBackupMtu(1380);
    const probe = harness((target) => {
      const ok = clientFields(target.config).mtu === "1300";
      return { handshake: ok, http: ok };
    });
    await probe.tick();

    const awg31 = probe.sent[0]?.targets.filter((target) => target.protocol === "awg3") ?? [];
    expect(awg31.map((target) => clientFields(target.config).mtu).sort()).toEqual(["1300", "1380"]);
    expect(awg31.every((target) => inspectAwgVpnLink(target.config).endpoint?.host === bridge.publicIpv4)).toBe(true);
    await setBackupMtu(1400);
    await probe.tick();
    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual(["ok", null, null]);
    await probe.tick(120);
    await probe.tick();
    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual(["ok", "failed", null]);
  });

  runDatabaseTest("does not apply a direct result to an IP switched to the active bridge", async () => {
    await seedProbe();
    await seedPortalPolicy(false);
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10" }) });
    await seedDirectEndpoints(node.id);
    const bridge = await seedBridge(`Changed path ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    const probe = harness(() => ({ handshake: true, http: true }));
    await probe.tick();

    await seedPortalPolicy(true);
    await probe.tick();

    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual([null, null, null]);
    expect((await resultsOf(node.id)).has("awg3")).toBe(false);
  });

  runDatabaseTest("measures each enabled direct IPv4 with its own AWG 3.1 result", async () => {
    await seedProbe();
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10", port: 51234 }) });
    await seedDirectEndpoints(node.id);
    const probe = harness((target) => {
      const endpoint = inspectAwgVpnLink(target.config).endpoint;
      const ok = endpoint?.host !== "192.0.2.20";
      return { handshake: ok, http: ok };
    });
    await probe.tick();

    const awg31 = probe.sent[0]?.targets.filter((target) => target.protocol === "awg3");
    expect(awg31).toHaveLength(2);
    const primary = awg31?.find((target) => target.targetId === `${node.id}:awg3:r0`);
    const backup = awg31?.find((target) => target.targetId.startsWith(`${node.id}:awg3:r0:direct:`));
    expect(inspectAwgVpnLink(primary?.config ?? "").endpoint).toEqual({ host: "192.0.2.10", port: 51234 });
    expect(inspectAwgVpnLink(backup?.config ?? "").endpoint).toEqual({ host: "192.0.2.20", port: 51234 });
    expect(backup?.targetId).not.toContain("192.0.2.20");
    expect(backup?.expectedEgressIp).toBe("192.0.2.10");

    await probe.tick();

    const observations = await directEndpointsOf(node.id);
    expect(observations).toMatchObject([
      { probeStatus: "ok", probeDetail: null },
      { probeStatus: "failed", probeDetail: "no handshake" },
      { probeStatus: null, probeCheckedAt: null, probeDetail: null },
    ]);
    expect(observations[0]?.probeCheckedAt).toBeInstanceOf(Date);
    expect(observations[1]?.probeCheckedAt).toBeInstanceOf(Date);
    expect((await resultsOf(node.id)).get("awg3")?.status).toBe("ok");
    expect(await stateOf(node.id)).toMatchObject({ status: "ok" });
  });

  runDatabaseTest("records every address when telemetry touches the probe key during the run", async () => {
    await seedProbe();
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10", port: 51234 }) });
    await seedDirectEndpoints(node.id);
    const probe = harness(() => ({ handshake: true, http: true }));
    await probe.tick();

    // The probe's own handshake is seen by the telemetry poll, which moves
    // `updated_at` on the key after the run started.
    await db()
      .update(vpnKeys)
      .set({ lastUsedAt: new Date(), updatedAt: new Date(Date.now() + 24 * 60 * 60_000) })
      .where(eq(vpnKeys.nodeId, node.id));
    await probe.tick();

    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual([
      "ok", "ok", null,
    ]);
  });

  runDatabaseTest("ignores a direct reply from before an address was disabled and reenabled", async () => {
    await seedProbe();
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10" }) });
    const [, backup] = await seedDirectEndpoints(node.id);
    if (!backup) throw new Error("Missing backup endpoint");
    const probe = harness(() => ({ handshake: true, http: true }));
    await probe.tick();

    for (const enabled of [false, true]) {
      await db().transaction(async (tx) => {
        await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, node.id)).for("no key update");
        await tx.update(nodeVpnEndpoints)
          .set({ enabled, revision: sql`${nodeVpnEndpoints.revision} + 1` })
          .where(eq(nodeVpnEndpoints.id, backup.id));
      });
    }
    await probe.tick();

    expect(await directEndpointsOf(node.id)).toMatchObject([
      { probeStatus: "ok" },
      { probeStatus: null, probeCheckedAt: null },
      { probeStatus: null, probeCheckedAt: null },
    ]);
  });

  runDatabaseTest("bridge activation clears direct evidence and checks only the bridged AWG 3.1 path", async () => {
    await seedProbe();
    await seedPortalPolicy(true);
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10" }) });
    await seedDirectEndpoints(node.id);
    const probe = harness(() => ({ handshake: true, http: true }));
    await probe.tick();
    await probe.tick();
    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual([
      "ok", "ok", null,
    ]);

    const bridge = await seedBridge("Endpoint bridge");
    const route = await seedRoute(node.id, bridge.id);
    await db().transaction((tx) => switchEndpoint(tx, node.id, route));
    await probe.tick(120);

    const awg31 = probe.sent[1]?.targets.filter((target) => target.protocol === "awg3");
    expect(awg31?.map((target) => inspectAwgVpnLink(target.config).endpoint)).toEqual([
      { host: bridge.publicIpv4, port: 41000 },
    ]);
    await probe.tick();
    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual([
      "ok", "ok", null,
    ]);
    expect((await resultsOf(node.id)).get("awg3")?.status).toBe("ok");
  });

  runDatabaseTest("probes bridged and direct endpoints on the same node according to bridgeMode and portal policy", async () => {
    await seedProbe();
    await seedPortalPolicy(false);
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10", port: 51234 }) });
    await db().update(nodes).set({ awgGenerator: { ...preset("dns_response"), mtu: 1300 } })
      .where(eq(nodes.id, node.id));
    await db().insert(nodeVpnEndpoints).values([
      {
        nodeId: node.id,
        ordinal: 1,
        name: "Bridged-EP",
        address: "192.0.2.10",
        enabled: true,
        reachabilityEnabled: true,
        bridgeMode: "bridge",
        awgGenerator: { ...preset("issued"), mtu: 1370 },
      },
      {
        nodeId: node.id,
        ordinal: 2,
        name: "Direct-EP",
        address: "192.0.2.20",
        enabled: true,
        reachabilityEnabled: true,
        bridgeMode: "direct",
        awgGenerator: { ...preset("dns_response"), mtu: 1400 },
      },
      {
        nodeId: node.id,
        ordinal: 3,
        name: "Inherit-EP",
        address: "192.0.2.30",
        enabled: true,
        reachabilityEnabled: true,
        bridgeMode: "inherit",
      },
    ]);
    const bridge = await seedBridge(`Mixed ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    const probe = harness((target) => {
      const host = inspectAwgVpnLink(target.config).endpoint?.host;
      const ok = host === bridge.publicIpv4 || host === "192.0.2.30";
      return { handshake: ok, http: ok };
    });

    await probe.tick();
    const awg31 = probe.sent[0]?.targets.filter((target) => target.protocol === "awg3");
    expect(new Set(awg31?.map((target) => ({
      ...inspectAwgVpnLink(target.config).endpoint,
      ...clientFields(target.config),
    })))).toEqual(new Set([
      { host: bridge.publicIpv4, port: 41000, mtu: "1370", jc: "8" },
      { host: "192.0.2.20", port: 51234, mtu: "1400", jc: "4" },
      { host: "192.0.2.30", port: 51234, mtu: "1300", jc: "4" },
    ]));

    await probe.tick();
    expect((await directEndpointsOf(node.id)).map((endpoint) => [endpoint.name, endpoint.probeStatus])).toEqual([
      ["Bridged-EP", "ok"],
      ["Direct-EP", "failed"],
      ["Inherit-EP", "ok"],
    ]);
  });

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
    "uses one bridged AWG 3.1 measurement for both node and bridge verdicts",
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
      expect(sent.has("awg2")).toBe(false);

      await probe.tick();
      const results = await resultsOf(node.id);
      expect(results.get("awg3")).toMatchObject({ status: "failed", detail: "no handshake" });
      expect(results.has("awg2")).toBe(false);
      expect(await stateOf(node.id)).toMatchObject({ status: "failed" });
      const [bridgeState] = await db().select().from(bridgeReachabilityState)
        .where(eq(bridgeReachabilityState.bridgeId, bridge.id));
      expect(bridgeState).toMatchObject({ probeStatus: "failed", mgmtStatus: null });
      const alert = (await alerts()).find((item) => item.deduplicationKey.includes(node.id));
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

  runDatabaseTest("keeps opt-in direct AWG results diagnostic when the bridged path fails", async () => {
    const node = await seedNode();
    const bridge = await seedBridge(`Bridge ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    await seedProbe({ probeDirectWhenBridged: true });
    const probe = harness((target) => {
      const direct = target.targetId.endsWith(":direct") || target.protocol === "awg2";
      return { handshake: direct, http: direct };
    });
    await probe.tick();
    const sent = probe.sent[0]?.targets.filter((target) => target.targetId.startsWith(`${node.id}:`));
    expect(sent?.map((target) => target.targetId).sort()).toEqual([
      `${node.id}:awg2`, `${node.id}:awg3:direct`, `${node.id}:awg3:r1`,
    ]);
    const direct = sent?.find((target) => target.targetId.endsWith(":direct"));
    expect(inspectAwgVpnLink(direct?.config ?? "").endpoint)
      .toEqual(inspectAwgVpnLink(awgServiceLink()).endpoint);
    await probe.tick();
    expect(await stateOf(node.id)).toMatchObject({ status: "failed", directStatus: "ok" });
    expect((await stateOf(node.id))?.directCheckedAt).toBeInstanceOf(Date);
    expect((await resultsOf(node.id)).get("awg3")).toMatchObject({ status: "failed" });
  });

  runDatabaseTest("measures opted-in bridged nodes' direct addresses independently", async () => {
    await seedPortalPolicy(true);
    const node = await seedNode({ awg3Link: awgServiceLink({ host: "192.0.2.10", port: 51234 }) });
    await seedDirectEndpoints(node.id);
    const bridge = await seedBridge(`Bridge ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    await seedProbe({ probeDirectWhenBridged: true });
    const probe = harness((target) => {
      const ok = inspectAwgVpnLink(target.config).endpoint?.host === "192.0.2.20";
      return { handshake: ok, http: ok };
    });
    await probe.tick();

    const awg31 = probe.sent[0]?.targets.filter((target) => target.protocol === "awg3");
    expect(awg31).toHaveLength(3);
    expect(new Set(awg31?.map((target) => inspectAwgVpnLink(target.config).endpoint))).toEqual(new Set([
      { host: bridge.publicIpv4, port: 41000 },
      { host: "192.0.2.10", port: 51234 },
      { host: "192.0.2.20", port: 51234 },
    ]));
    const prefix = `${node.id}:awg3:r1:direct:`;
    expect(awg31?.filter((target) => target.targetId.startsWith(prefix))).toHaveLength(2);
    expect(new Set(awg31?.map((target) => target.targetId)).size).toBe(3);

    await probe.tick();

    expect(await stateOf(node.id)).toMatchObject({ status: "failed", directStatus: "failed" });
    expect((await directEndpointsOf(node.id)).map((endpoint) => endpoint.probeStatus)).toEqual([
      "failed", "failed", null,
    ]);
  });

  runDatabaseTest("fences dispatch if direct diagnostics were disabled during the tick", async () => {
    const node = await seedNode();
    const bridge = await seedBridge(`Bridge ${runTag}`);
    await seedRoute(node.id, bridge.id, "active");
    await seedProbe({ probeDirectWhenBridged: true });
    const probe = harness(() => ({ handshake: true, http: true }));
    vi.mocked(probe.client.latestRun).mockImplementationOnce(async () => {
      await db().update(reachabilityProbe).set({ probeDirectWhenBridged: false });
      return null;
    });
    await probe.tick();
    expect(probe.sent).toHaveLength(0);
    await probe.tick();
    expect(probe.sent[0]?.targets.map((target) => target.targetId)).toEqual([`${node.id}:awg3:r1`]);
  });

  runDatabaseTest("serializes accepting a probe run against changing an endpoint", async () => {
    const node = await seedNode();
    const bridge = await seedBridge(`Bridge ${runTag}`);
    const route = await seedRoute(node.id, bridge.id, "draft");
    await seedProbe();
    const probe = harness(() => ({ handshake: true, http: true }));
    const requested = deferred();
    const acknowledge = deferred();
    vi.mocked(probe.client.startRun).mockImplementationOnce(async (request) => {
      requested.resolve();
      await acknowledge.promise;
      return { runId: request.runId };
    });
    const sending = probe.tick();
    await requested.promise;
    const changing = db().transaction((tx) => switchEndpoint(tx, node.id, route));
    try {
      expect(await Promise.race([
        changing.then(() => "committed"),
        waitForLockWait().then(() => "waiting"),
      ])).toBe("waiting");
    } finally {
      acknowledge.resolve();
      await Promise.all([sending, changing]);
    }
    expect(await revisionOf(node.id)).toBe(1);
  });

  runDatabaseTest("checks a standalone bridge host and queues one external outage and recovery", async () => {
    const bridge = await seedBridge(`Bridge ${runTag}`);
    await db().update(vpnBridges).set({ panelDnsHostname: "bridge.example.org" })
      .where(eq(vpnBridges.id, bridge.id));
    await seedProbe({ capabilities: ["bridge-measurement", "bridge-host-check"] });
    let online = false;
    const probe = harness(() => ({ handshake: true, http: true }), () => online);
    vi.mocked(probe.client.capabilities).mockResolvedValue({
      apiVersion: 1, capabilities: ["bridge-measurement", "bridge-host-check"],
    });
    await probe.tick();
    const hosts = probe.sent[0]?.bridgeTargets;
    expect(hosts).toHaveLength(1);
    expect(hosts?.[0]?.targetId).toMatch(new RegExp(`^${bridge.id}:host:`));
    expect(hosts?.[0]).toMatchObject({
      host: bridge.publicIpv4,
      httpsHostname: "bridge.example.org",
    });
    expect(probe.sent[0]?.targets).toEqual([]);
    await probe.tick();
    await probe.tick(70);
    await probe.tick();
    expect(await alerts()).toHaveLength(1);
    online = true;
    await probe.tick(70);
    await probe.tick();
    const [bridgeState] = await db().select().from(bridgeReachabilityState)
      .where(eq(bridgeReachabilityState.bridgeId, bridge.id));
    expect(bridgeState).toMatchObject({
      probeStatus: "ok", probeAlertedAt: null, mgmtStatus: null, probeLevels: { https: { ok: true } },
    });
    const notices = await alerts();
    expect(notices.map((row) => row.deduplicationKey.split(":").at(-1)).sort()).toEqual(["down", "up"]);
  });

  runDatabaseTest("ignores invalid legacy bridge hostnames without discarding usable AWG targets", async () => {
    const standalone = await seedBridge(`Standalone ${runTag}`);
    const routed = await seedBridge(`Routed ${runTag}`);
    const node = await seedNode();
    await seedRoute(node.id, routed.id, "active");
    await db().update(vpnBridges).set({ panelDnsHostname: "1.2" })
      .where(inArray(vpnBridges.id, [standalone.id, routed.id]));
    await seedProbe({ capabilities: ["bridge-measurement", "bridge-host-check"] });
    const probe = harness(() => ({ handshake: true, http: true }));
    await probe.tick();
    const hosts = probe.sent[0]?.bridgeTargets;
    expect(hosts).toHaveLength(1);
    expect(hosts?.[0]?.targetId).toMatch(new RegExp(`^${standalone.id}:host:`));
    expect(hosts?.[0]?.host).toBe(standalone.publicIpv4);
    expect(hosts?.[0]?.httpsHostname).toBeUndefined();
    expect(probe.sent[0]?.targets.map((target) => target.targetId)).toEqual([`${node.id}:awg3:r1`]);
    await probe.tick();
    const states = await db().select().from(bridgeReachabilityState)
      .where(inArray(bridgeReachabilityState.bridgeId, [standalone.id, routed.id]));
    expect(states.map(({ probeStatus }) => probeStatus)).toEqual(["ok", "ok"]);
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
      expect(sent.has("awg2")).toBe(false);

      await probe.tick();
      expect((await resultsOf(node.id)).get("awg3")).toMatchObject({
        status: "ok",
        egressIp: "198.51.100.7",
      });
      expect(await stateOf(node.id)).toMatchObject({ status: "ok" });
    },
  );

  runDatabaseTest(
    "a legacy probe leaves the bridged path unknown without sending direct checks",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      await seedRoute(node.id, bridge.id, "active");
      await seedProbe({ capabilities: [] });
      const probe = harness(() => ({ handshake: false, http: false }));

      await probe.tick();
      expect([...sentFor(probe.sent[0], node.id).keys()]).toEqual([]);

      await probe.tick();
      const results = await resultsOf(node.id);
      expect(results.get("awg3")).toMatchObject({
        status: "error",
        detail: BRIDGE_UNSUPPORTED_REASON,
      });
      expect(results.has("awg2")).toBe(false);
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
      expect(results.has("awg2")).toBe(false);
      expect(await stateOf(node.id)).toMatchObject({ status: "error", detail: OBSOLETE_DETAIL });
      expect(await alerts()).toEqual([]);

      // The next run goes through bridge B under the new revision.
      await probe.tick(70);
      const next = sentFor(probe.sent[1], node.id).get("awg3");
      expect(next?.targetId).toBe(`${node.id}:awg3:r2`);
      expect(inspectAwgVpnLink(next?.config ?? "").endpoint?.host).toBe(bridgeB.publicIpv4);
    },
  );

  runDatabaseTest(
    "a result returning after the bridge was switched off (Direct) is unknown",
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
      expect(results.get("awg2")).toMatchObject({ status: "error" });
      // Neither AWG 3.1 nor AWG 2 ran against the current direct endpoint.
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
    "a Direct -> bridge change committed while the ingest waits judges the node by its new bridged path",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge(`Bridge ${runTag}`);
      const route = await seedRoute(node.id, bridge.id, "draft");
      await seedProbe();
      // Direct was blocked for AWG 3.1 and an incident is open.
      const alertedAt = new Date(Date.now() - 3_600_000);
      await db().insert(nodeReachabilityState).values({
        nodeId: node.id,
        status: "failed",
        consecutiveFailures: 3,
        failingSince: alertedAt,
        alertedAt,
        alertKind: "node",
        checkedAt: alertedAt,
      });
      // The Direct run: AWG 2 works, which under the Direct rule would close
      // the incident. After the switch the verdict is the bridged path's.
      const probe = harness((target) => ({
        handshake: target.protocol === "awg2",
        http: target.protocol === "awg2",
      }));
      await probe.tick();

      const held = deferred();
      const lockTaken = deferred();
      const change = db().transaction(async (tx) => {
        await switchEndpoint(tx, node.id, route);
        lockTaken.resolve();
        await held.promise;
      });
      await lockTaken.promise;
      const ingest = probe.tick();
      try {
        await waitForLockWait();
      } finally {
        held.resolve();
        await change;
        await ingest;
      }

      expect(await stateOf(node.id)).toMatchObject({
        status: "error",
        alertedAt,
        alertKind: "node",
      });
      expect(await alerts()).toEqual([]);
      expect((await resultsOf(node.id)).has("awg3")).toBe(false);
      expect((await resultsOf(node.id)).has("awg2")).toBe(false);
    },
  );

  runDatabaseTest(
    "starting a probe consumes only the matching pending request, preserving a newer request",
    async () => {
      await seedProbe();
      const started = randomUUID();
      const queued = randomUUID();
      const now = new Date();
      await db().update(reachabilityProbe).set({ requestedRunId: queued, runRequestedAt: now });
      await repository.markRunStarted(started, now);
      expect(await repository.loadProbe()).toMatchObject({ currentRunId: started, requestedRunId: queued });
      await repository.abandonRun(now, "test reset before starting the queued request");
      await repository.markRunStarted(queued, now);
      expect(await repository.loadProbe()).toMatchObject({ currentRunId: queued, requestedRunId: null });
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
          endpointOutcomes: out.endpointOutcomes,
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
      expect((await resultsOf(node.id)).has("awg2")).toBe(false);
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
      await probe.tick(70);
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
