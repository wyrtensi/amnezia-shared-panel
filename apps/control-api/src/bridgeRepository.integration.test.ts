import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bridgeEligibilitySchema,
  bridgeFrpProxyName,
  infrastructureItemSchema,
  nodeBridgeRoutesSchema,
  prepareBridgeRouteResultSchema,
} from "@amnezia/contracts";
import {
  auditEvents,
  createDatabase,
  encryptSecret,
  ENDPOINT_CHANGED_DETAIL,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodes,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
} from "@amnezia/db";

import { createDefaultControlApiService } from "./defaultService.js";
import { awg31Link, readCopies } from "./awg31.fixture.js";
import { decodeVpnLink } from "./vpnConfig.js";
import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

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

const MINUTE = 60_000;

describe("bridge registry (real PostgreSQL)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  let admin: Actor;
  let repository: PostgresControlRepository;
  const createdNodeIds: string[] = [];
  const createdBridgeIds: string[] = [];
  const createdUserIds: string[] = [];
  let ipCounter = 0;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  /**
   * Resolves once another session of this database waits for a row lock: the
   * suites run one file at a time, so that session is the one the test just
   * started. Polled instead of slept, so the test does not depend on timing.
   */
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

  // Unique, public, per-run addresses (45.0.0.0/8 is ordinary unicast).
  const nextIpv4 = (): string => {
    ipCounter += 1;
    const seed = parseInt(runTag, 16);
    return `45.${(seed >> 8) & 0xff}.${seed & 0xff}.${ipCounter}`;
  };

  const seedNode = async (
    label: string,
    served: {
      protocol?: "awg2" | "awg3";
      capabilities?: Record<string, boolean>;
      enabledProtocols?: Array<"awg2" | "awg3"> | null;
    } = {},
  ): Promise<string> => {
    const credentials = encryptSecret("api-key", keyring, 1);
    const labelSecret = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `bridge-${runTag}-${label}-${randomBytes(2).toString("hex")}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        // Bridges carry AWG 3.1 only, so test nodes serve it unless told not to.
        protocol: served.protocol ?? "awg3",
        capabilities: served.capabilities ?? {},
        enabledProtocols: served.enabledProtocols ?? null,
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
    createdNodeIds.push(node.id);
    return node.id;
  };

  const createBridge = async (
    overrides: Partial<{ udpPortStart: number; udpPortEnd: number; name: string }> = {},
  ) => {
    const bridge = await repository.createBridge(admin, {
      name: overrides.name ?? `Bridge ${runTag}`,
      publicIpv4: nextIpv4(),
      controlTcpPort: 7000,
      udpPortStart: overrides.udpPortStart ?? 41000,
      udpPortEnd: overrides.udpPortEnd ?? 41031,
    });
    createdBridgeIds.push(bridge.id);
    return bridge;
  };

  /** Seed what the bridge-agent poller (Task 5) will write. */
  const observe = async (
    bridgeId: string,
    routeId: string,
    options: {
      online: boolean | null;
      marker?: string | null;
      at?: Date;
      routeAt?: Date | null;
      status?: "ok" | "down" | "stale" | "pending_enrollment";
    },
  ) => {
    const at = options.at ?? new Date();
    await db()
      .update(vpnBridges)
      .set({ managementStatus: options.status ?? "ok", lastObservedAt: at })
      .where(eq(vpnBridges.id, bridgeId));
    await db()
      .update(vpnBridgeRoutes)
      .set({
        observedOnline: options.online,
        observedRegistrationMarker: options.marker ?? null,
        observedAt: options.routeAt === undefined ? at : options.routeAt,
      })
      .where(eq(vpnBridgeRoutes.id, routeId));
  };

  const verify = async (
    routeId: string,
    options: { marker: string; at?: Date; result?: "success" | "failure" },
  ) => {
    await db()
      .update(vpnBridgeRoutes)
      .set({
        verificationMethod: "probe",
        verifiedRegistrationMarker: options.marker,
        verifiedAt: options.at ?? new Date(),
        verificationResult: options.result ?? "success",
      })
      .where(eq(vpnBridgeRoutes.id, routeId));
  };

  /** A route that satisfies every activation guard. */
  const makeActivatable = async (bridgeId: string, routeId: string, marker = "m-1") => {
    await observe(bridgeId, routeId, { online: true, marker });
    await verify(routeId, { marker });
  };

  const revisionOf = async (nodeId: string): Promise<number> => {
    const [row] = await db()
      .select({ revision: nodes.vpnEndpointRevision })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    return row?.revision ?? -1;
  };

  const routeRow = async (routeId: string) => {
    const [row] = await db()
      .select()
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.id, routeId));
    return row;
  };

  const activate = (nodeId: string, routeId: string | null, revision: number, actor = admin) =>
    repository.updateNode(actor, nodeId, {
      vpnBridgeRouteId: routeId,
      expectedVpnEndpointRevision: revision,
    }) as Promise<{
      vpnEndpoint: { changed: boolean; vpnEndpointRevision: number; activeRoute: { id: string } | null };
    }>;

  beforeAll(async () => {
    if (!database) return;
    repository = new PostgresControlRepository({ db: database.db, keyring });
    const [user] = await database.db
      .insert(users)
      .values({ email: `bridge-admin-${runTag}@example.com`, role: "admin" })
      .returning();
    if (!user) throw new Error("Failed to seed admin");
    createdUserIds.push(user.id);
    admin = {
      id: user.id,
      email: user.email,
      displayName: null,
      role: "admin",
      status: "active",
    };
  });

  afterEach(async () => {
    if (!database) return;
    // Routes first (RESTRICT on both parents), then bridges, keys and nodes.
    if (createdNodeIds.length > 0 || createdBridgeIds.length > 0) {
      const conditions = [];
      if (createdNodeIds.length > 0) conditions.push(inArray(vpnBridgeRoutes.nodeId, createdNodeIds));
      if (createdBridgeIds.length > 0)
        conditions.push(inArray(vpnBridgeRoutes.bridgeId, createdBridgeIds));
      await database.db.delete(vpnBridgeRoutes).where(or(...conditions));
    }
    if (createdBridgeIds.length > 0) {
      await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, createdBridgeIds));
    }
    if (createdNodeIds.length > 0) {
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.nodeId, createdNodeIds));
      await database.db.delete(nodes).where(inArray(nodes.id, createdNodeIds));
    }
    createdBridgeIds.length = 0;
    createdNodeIds.length = 0;
  });

  afterAll(async () => {
    if (!database) return;
    if (createdUserIds.length > 0) {
      await database.db.delete(auditEvents).where(inArray(auditEvents.actorUserId, createdUserIds));
      await database.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await database.client.end();
  });

  runDatabaseTest("an existing node row starts Direct at revision 0", async () => {
    const nodeId = await seedNode("legacy");
    expect(await revisionOf(nodeId)).toBe(0);
    const view = nodeBridgeRoutesSchema.parse(await repository.getNodeBridgeRoutes(admin, nodeId));
    expect(view).toEqual({
      nodeId,
      vpnEndpointRevision: 0,
      activeRoute: null,
      drafts: [],
      retiring: [],
    });
  });

  runDatabaseTest("registers a bridge with normalized settings and refuses a duplicate IPv4", async () => {
    const bridge = await createBridge();
    expect(bridge).toMatchObject({
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
      capacity: 32,
      heldPorts: 0,
      managementStatus: "pending_enrollment",
      lastObservedAt: null,
      routes: [],
    });
    const failure = await failureOf(
      repository.createBridge(admin, {
        name: "Duplicate",
        publicIpv4: bridge.publicIpv4,
        controlTcpPort: 7000,
        udpPortStart: 42000,
        udpPortEnd: 42001,
      }),
    );
    expect(failure).toMatchObject({ statusCode: 409, code: "BRIDGE_IPV4_CONFLICT" });

    const renamed = await repository.updateBridge(admin, bridge.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.publicIpv4).toBe(bridge.publicIpv4);
    const [audit] = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, bridge.id), eq(auditEvents.action, "vpn_bridge.created")));
    expect(audit?.metadata).toMatchObject({ publicIpv4: bridge.publicIpv4, udpPortStart: 41000 });
    expect(
      await failureOf(repository.updateBridge(admin, randomUUID(), { name: "x" })),
    ).toMatchObject({ statusCode: 404, code: "BRIDGE_NOT_FOUND" });
  });

  runDatabaseTest("one node holds routes on two bridges, each on its own pool", async () => {
    const nodeId = await seedNode("two-bridges");
    const bridgeA = await createBridge({ name: "A" });
    const bridgeB = await createBridge({ name: "B" });
    const onA = prepareBridgeRouteResultSchema.parse(
      await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridgeA.id }),
    );
    const onB = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridgeB.id });
    expect(onA.created).toBe(true);
    expect(onA.route.publicUdpPort).toBe(41000);
    expect(onB.route.publicUdpPort).toBe(41000);
    expect(onA.route.frpProxyName).toBe(bridgeFrpProxyName(onA.route.id));
    expect(onA.route).toMatchObject({
      state: "draft",
      bridgePublicIpv4: bridgeA.publicIpv4,
      bridgeControlTcpPort: 7000,
    });
    const view = await repository.getNodeBridgeRoutes(admin, nodeId);
    expect(view.drafts.map((route) => route.id).sort()).toEqual(
      [onA.route.id, onB.route.id].sort(),
    );
  });

  runDatabaseTest("bridge and route read models carry secret-free setup commands", async () => {
    const bridge = await createBridge();
    expect(bridge.setupCommands?.install).toBe(
      `sudo sh /opt/amnezia-bridge/install-bridge.sh --bridge-id ${bridge.id} --control-port ${bridge.controlTcpPort} --udp-start ${bridge.udpPortStart} --udp-end ${bridge.udpPortEnd}`,
    );
    expect(bridge.setupCommands?.dryRun).toBe(`${bridge.setupCommands?.install} --dry-run`);
    const nodeId = await seedNode("setup-commands");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    expect(route.setupCommands?.install).toBe(
      `sudo sh /opt/amnezia-panel-node/scripts/install-frpc.sh --route-id ${route.id} --bridge-ip ${bridge.publicIpv4} --control-port ${bridge.controlTcpPort} --public-port ${route.publicUdpPort}`,
    );
    expect(route.setupCommands?.remove).toBe(
      `sudo sh /opt/amnezia-panel-node/scripts/install-frpc.sh --route-id ${route.id} --remove`,
    );
    const listed = await repository.getNodeBridgeRoutes(admin, nodeId);
    expect(listed.drafts[0]?.setupCommands).toEqual(route.setupCommands);
  });

  runDatabaseTest("concurrent nodes on one bridge each get a distinct port", async () => {
    const bridge = await createBridge();
    const nodeIds = await Promise.all(
      Array.from({ length: 6 }, (_, index) => seedNode(`concurrent-${index}`)),
    );
    const results = await Promise.all(
      nodeIds.map((nodeId) => repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id })),
    );
    const ports = results.map((result) => result.route.publicUdpPort).sort((a, b) => a - b);
    expect(ports).toEqual([41000, 41001, 41002, 41003, 41004, 41005]);
    const listed = (await repository.listBridges(admin)).find((row) => row.id === bridge.id);
    expect(listed?.heldPorts).toBe(6);
    expect(listed?.capacity).toBe(32);
    expect(listed?.routes.map((route) => route.nodeName).every(Boolean)).toBe(true);
  });

  runDatabaseTest("a race for one requested port yields one winner and BRIDGE_PORT_TAKEN", async () => {
    const bridge = await createBridge();
    const nodeIds = await Promise.all(
      Array.from({ length: 5 }, (_, index) => seedNode(`race-${index}`)),
    );
    const settled = await Promise.allSettled(
      nodeIds.map((nodeId) =>
        repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id, publicUdpPort: 41010 }),
      ),
    );
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ statusCode: 409, code: "BRIDGE_PORT_TAKEN" });
    }
  });

  runDatabaseTest("an exhausted pool refuses with BRIDGE_POOL_EXHAUSTED", async () => {
    const bridge = await createBridge({ udpPortStart: 41000, udpPortEnd: 41001 });
    const [first, second, third] = await Promise.all([
      seedNode("full-1"),
      seedNode("full-2"),
      seedNode("full-3"),
    ]);
    await repository.prepareBridgeRoute(admin, first, { bridgeId: bridge.id });
    await repository.prepareBridgeRoute(admin, second, { bridgeId: bridge.id });
    expect(
      await failureOf(repository.prepareBridgeRoute(admin, third, { bridgeId: bridge.id })),
    ).toMatchObject({ statusCode: 409, code: "BRIDGE_POOL_EXHAUSTED" });
  });

  runDatabaseTest("prepare is idempotent per pairing and validates an override", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("idempotent");
    const other = await seedNode("idempotent-other");
    const first = await repository.prepareBridgeRoute(admin, nodeId, {
      bridgeId: bridge.id,
      publicUdpPort: 41005,
    });
    expect(first.created).toBe(true);
    const again = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    expect(again).toMatchObject({ created: false, route: { id: first.route.id, publicUdpPort: 41005 } });
    const samePort = await repository.prepareBridgeRoute(admin, nodeId, {
      bridgeId: bridge.id,
      publicUdpPort: 41005,
    });
    expect(samePort.route.id).toBe(first.route.id);
    expect(
      await failureOf(
        repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id, publicUdpPort: 41006 }),
      ),
    ).toMatchObject({ statusCode: 409, code: "BRIDGE_ROUTE_PAIR_CONFLICT" });
    expect(
      await failureOf(
        repository.prepareBridgeRoute(admin, other, { bridgeId: bridge.id, publicUdpPort: 40999 }),
      ),
    ).toMatchObject({ statusCode: 409, code: "BRIDGE_PORT_OUT_OF_RANGE" });
    expect(
      await failureOf(
        repository.prepareBridgeRoute(admin, other, { bridgeId: bridge.id, publicUdpPort: 41005 }),
      ),
    ).toMatchObject({ statusCode: 409, code: "BRIDGE_PORT_TAKEN" });
    expect(
      await failureOf(
        repository.prepareBridgeRoute(admin, randomUUID(), { bridgeId: bridge.id }),
      ),
    ).toMatchObject({ statusCode: 404, code: "NODE_NOT_FOUND" });
    expect(
      await failureOf(repository.prepareBridgeRoute(admin, other, { bridgeId: randomUUID() })),
    ).toMatchObject({ statusCode: 404, code: "BRIDGE_NOT_FOUND" });
    const prepared = await db()
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.targetId, first.route.id), eq(auditEvents.action, "vpn_bridge_route.prepared")),
      );
    // One reservation, one audit row: the idempotent repeats wrote nothing.
    expect(prepared).toHaveLength(1);
  });

  runDatabaseTest("Direct -> A -> Direct increments the revision and resets AWG 3.1 evidence", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("toggle");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    const runId = randomUUID();
    const now = new Date();
    await db().insert(nodeReachabilityResults).values([
      { nodeId, protocol: "awg3", status: "failed", levels: {}, runId, checkedAt: now },
      { nodeId, protocol: "awg2", status: "ok", levels: {}, runId, checkedAt: now },
    ]);
    const alertedAt = new Date(now.getTime() - 60_000);
    await db().insert(nodeReachabilityState).values({
      nodeId,
      status: "failed",
      consecutiveFailures: 3,
      failingSince: new Date(now.getTime() - 3_600_000),
      alertedAt,
      alertKind: "node",
      checkedAt: now,
    });

    const toBridge = await activate(nodeId, route.id, 0);
    expect(toBridge.vpnEndpoint).toMatchObject({
      changed: true,
      vpnEndpointRevision: 1,
      activeRoute: { id: route.id },
    });
    expect(await revisionOf(nodeId)).toBe(1);
    expect((await routeRow(route.id))?.state).toBe("active");
    expect((await routeRow(route.id))?.activatedAt).not.toBeNull();
    const results = await db()
      .select({ protocol: nodeReachabilityResults.protocol })
      .from(nodeReachabilityResults)
      .where(eq(nodeReachabilityResults.nodeId, nodeId));
    expect(results.map((row) => row.protocol)).toEqual(["awg2"]);
    // The verdict reads unknown until a run through the new endpoint; the
    // open incident stays (one recovery message later, never a second alert)
    // and the old path's failure streak restarts.
    const [state] = await db()
      .select()
      .from(nodeReachabilityState)
      .where(eq(nodeReachabilityState.nodeId, nodeId));
    expect(state).toMatchObject({
      status: "error",
      consecutiveFailures: 0,
      failingSince: null,
      alertedAt,
      alertKind: "node",
      detail: ENDPOINT_CHANGED_DETAIL,
    });
    const [audit] = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, nodeId), eq(auditEvents.action, "node.vpn_endpoint_changed")));
    expect(audit?.metadata).toEqual({
      fromRouteId: null,
      toRouteId: route.id,
      bridgeId: bridge.id,
      publicUdpPort: route.publicUdpPort,
      previousRevision: 0,
      revision: 1,
    });

    // Activating the already-active route is a no-op.
    const again = await activate(nodeId, route.id, 1);
    expect(again.vpnEndpoint).toMatchObject({ changed: false, vpnEndpointRevision: 1 });

    const toDirect = await activate(nodeId, null, 1);
    expect(toDirect.vpnEndpoint).toEqual({ changed: true, vpnEndpointRevision: 2, activeRoute: null });
    const retired = await routeRow(route.id);
    expect(retired?.state).toBe("retiring");
    expect(retired?.retiringSince).not.toBeNull();

    // Direct when already Direct changes nothing.
    const directAgain = await activate(nodeId, null, 2);
    expect(directAgain.vpnEndpoint).toEqual({ changed: false, vpnEndpointRevision: 2, activeRoute: null });
    expect(await revisionOf(nodeId)).toBe(2);
    const view = await repository.getNodeBridgeRoutes(admin, nodeId);
    expect(view.activeRoute).toBeNull();
    expect(view.retiring.map((row) => row.id)).toEqual([route.id]);
  });

  runDatabaseTest("switching A -> B retires A and activates B", async () => {
    const bridgeA = await createBridge({ name: "A" });
    const bridgeB = await createBridge({ name: "B" });
    const nodeId = await seedNode("a-to-b");
    const { route: a } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridgeA.id });
    const { route: b } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridgeB.id });
    await makeActivatable(bridgeA.id, a.id);
    await activate(nodeId, a.id, 0);
    await makeActivatable(bridgeB.id, b.id, "m-b");
    const result = await activate(nodeId, b.id, 1);
    expect(result.vpnEndpoint).toMatchObject({ changed: true, vpnEndpointRevision: 2 });
    expect((await routeRow(a.id))?.state).toBe("retiring");
    expect((await routeRow(b.id))?.state).toBe("active");
  });

  runDatabaseTest("a stale revision is refused with BRIDGE_REVISION_CONFLICT", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("stale-revision");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    expect(await failureOf(activate(nodeId, route.id, 3))).toMatchObject({
      statusCode: 409,
      code: "BRIDGE_REVISION_CONFLICT",
    });
    expect(await revisionOf(nodeId)).toBe(0);
    expect((await routeRow(route.id))?.state).toBe("draft");
  });

  describe("activation guard", () => {
    const expectRefused = async (
      setup: (bridgeId: string, routeId: string) => Promise<void>,
      code: string,
    ) => {
      const bridge = await createBridge();
      const nodeId = await seedNode("guard");
      const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      await setup(bridge.id, route.id);
      expect(await failureOf(activate(nodeId, route.id, 0))).toMatchObject({
        statusCode: 409,
        code,
      });
      expect(await revisionOf(nodeId)).toBe(0);
      expect((await routeRow(route.id))?.state).toBe("draft");
    };

    runDatabaseTest("no observation", () =>
      expectRefused(async () => {}, "BRIDGE_OBSERVATION_STALE"),
    );
    runDatabaseTest("stale observation", () =>
      expectRefused(async (bridgeId, routeId) => {
        const old = new Date(Date.now() - 10 * MINUTE);
        await observe(bridgeId, routeId, { online: true, marker: "m-1", at: old });
        await verify(routeId, { marker: "m-1" });
      }, "BRIDGE_OBSERVATION_STALE"),
    );
    runDatabaseTest("management channel down", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, { online: true, marker: "m-1", status: "down" });
        await verify(routeId, { marker: "m-1" });
      }, "BRIDGE_OBSERVATION_STALE"),
    );
    runDatabaseTest("route not covered by the latest poll", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, {
          online: true,
          marker: "m-1",
          routeAt: new Date(Date.now() - 2 * MINUTE),
        });
        await verify(routeId, { marker: "m-1" });
      }, "BRIDGE_OBSERVATION_STALE"),
    );
    runDatabaseTest("registration offline", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, { online: false, marker: null });
        await verify(routeId, { marker: "m-1" });
      }, "BRIDGE_OBSERVATION_STALE"),
    );
    runDatabaseTest("unverified", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, { online: true, marker: "m-1" });
      }, "BRIDGE_ROUTE_UNVERIFIED"),
    );
    runDatabaseTest("failed verification", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, { online: true, marker: "m-1" });
        await verify(routeId, { marker: "m-1", result: "failure" });
      }, "BRIDGE_ROUTE_UNVERIFIED"),
    );
    runDatabaseTest("verification bound to a different marker", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, { online: true, marker: "m-2" });
        await verify(routeId, { marker: "m-1" });
      }, "BRIDGE_ROUTE_UNVERIFIED"),
    );
    runDatabaseTest("verification older than 30 minutes", () =>
      expectRefused(async (bridgeId, routeId) => {
        await observe(bridgeId, routeId, { online: true, marker: "m-1" });
        await verify(routeId, { marker: "m-1", at: new Date(Date.now() - 31 * MINUTE) });
      }, "BRIDGE_ROUTE_UNVERIFIED"),
    );

    runDatabaseTest("a route of another node is not found", async () => {
      const bridge = await createBridge();
      const owner = await seedNode("owner");
      const stranger = await seedNode("stranger");
      const { route } = await repository.prepareBridgeRoute(admin, owner, { bridgeId: bridge.id });
      await makeActivatable(bridge.id, route.id);
      expect(await failureOf(activate(stranger, route.id, 0))).toMatchObject({
        statusCode: 404,
        code: "BRIDGE_ROUTE_NOT_FOUND",
      });
    });
  });

  runDatabaseTest("a failed audit insert rolls the whole activation back", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("audit-rollback");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    const now = new Date();
    await db()
      .insert(nodeReachabilityResults)
      .values({ nodeId, protocol: "awg3", status: "ok", levels: {}, runId: randomUUID(), checkedAt: now });
    // audit_events.actor_user_id references users: an actor without a row
    // makes the audit insert fail for real, as the last write of the change.
    const ghost: Actor = { ...admin, id: randomUUID() };
    let failure: unknown = null;
    try {
      await activate(nodeId, route.id, 0, ghost);
    } catch (error) {
      failure = error;
    }
    // Prove the audit insert is what failed, not an earlier guard.
    let cause = failure as { code?: string; constraint_name?: string; cause?: unknown } | null;
    for (let depth = 0; cause && cause.code !== "23503" && depth < 4; depth += 1) {
      cause = cause.cause as typeof cause;
    }
    expect(cause).toMatchObject({
      code: "23503",
      constraint_name: "audit_events_actor_user_id_users_id_fk",
    });
    expect(await revisionOf(nodeId)).toBe(0);
    const row = await routeRow(route.id);
    expect(row?.state).toBe("draft");
    expect(row?.activatedAt).toBeNull();
    expect(
      await db()
        .select()
        .from(nodeReachabilityResults)
        .where(eq(nodeReachabilityResults.nodeId, nodeId)),
    ).toHaveLength(1);
  });

  runDatabaseTest("activation does not deadlock with an overlapping reachability ingest", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("ingest-overlap");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    const runId = randomUUID();
    const result = { nodeId, protocol: "awg3" as const, status: "ok" as const, levels: {}, runId };
    await db().insert(nodeReachabilityResults).values({ ...result, checkedAt: new Date() });
    let activation: Promise<unknown> | null = null;
    // The worker's ingest order: take the node rows FOR SHARE (reading the
    // endpoint revision), then upsert the per-protocol result and insert a
    // history row, whose foreign key key-shares the node row. Activation
    // waits on the node row and never holds a reachability row the ingest
    // needs.
    await db().transaction(async (ingest) => {
      await ingest
        .select({ revision: nodes.vpnEndpointRevision })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("share");
      activation = activate(nodeId, route.id, 0);
      await waitForLockWait();
      await ingest
        .insert(nodeReachabilityResults)
        .values({ ...result, checkedAt: new Date() })
        .onConflictDoUpdate({
          target: [nodeReachabilityResults.nodeId, nodeReachabilityResults.protocol],
          set: { checkedAt: new Date() },
        });
      await ingest
        .insert(nodeReachabilityHistory)
        .values({ nodeId, runId, status: "ok", checkedAt: new Date() });
    });
    await expect(activation).resolves.toMatchObject({
      vpnEndpoint: { changed: true, vpnEndpointRevision: 1 },
    });
    // The activation ran after the ingest and reset its evidence.
    expect(
      await db().select().from(nodeReachabilityResults).where(eq(nodeReachabilityResults.nodeId, nodeId)),
    ).toHaveLength(0);
  });

  runDatabaseTest("an unrelated node PATCH leaves the revision and routes alone", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("unrelated");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    await activate(nodeId, route.id, 0);
    const updated = (await repository.updateNode(admin, nodeId, { maxPeers: 77 })) as Record<
      string,
      unknown
    >;
    expect(updated.maxPeers).toBe(77);
    expect("vpnEndpoint" in updated).toBe(false);
    expect(await revisionOf(nodeId)).toBe(1);
    expect((await routeRow(route.id))?.state).toBe("active");

    // Only the revision, no route id: a no-op that writes no node.updated row.
    const before = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, nodeId), eq(auditEvents.action, "node.updated")));
    const revisionOnly = (await repository.updateNode(admin, nodeId, {
      expectedVpnEndpointRevision: 0,
    })) as { vpnEndpoint: { changed: boolean; vpnEndpointRevision: number } };
    expect(revisionOnly.vpnEndpoint).toMatchObject({ changed: false, vpnEndpointRevision: 1 });
    const after = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, nodeId), eq(auditEvents.action, "node.updated")));
    expect(after).toHaveLength(before.length);
    expect(await revisionOf(nodeId)).toBe(1);
  });

  runDatabaseTest("a retiring route keeps its port", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("retiring-port");
    const other = await seedNode("retiring-other");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    await activate(nodeId, route.id, 0);
    await activate(nodeId, null, 1);
    expect((await routeRow(route.id))?.state).toBe("retiring");
    expect(
      await failureOf(
        repository.prepareBridgeRoute(admin, other, {
          bridgeId: bridge.id,
          publicUdpPort: route.publicUdpPort,
        }),
      ),
    ).toMatchObject({ statusCode: 409, code: "BRIDGE_PORT_TAKEN" });
    const next = await repository.prepareBridgeRoute(admin, other, { bridgeId: bridge.id });
    expect(next.route.publicUdpPort).not.toBe(route.publicUdpPort);
    const listed = (await repository.listBridges(admin)).find((row) => row.id === bridge.id);
    expect(listed?.heldPorts).toBe(2);
  });

  runDatabaseTest("preparation is refused for a node that does not serve AWG 3.1", async () => {
    const bridge = await createBridge();
    const awg2Only = await seedNode("awg2-only", { protocol: "awg2" });
    const awg3Disabled = await seedNode("awg3-disabled", {
      protocol: "awg3",
      capabilities: { awg2: true, awg3: true },
      enabledProtocols: ["awg2"],
    });
    const awg3Reported = await seedNode("awg3-reported", {
      protocol: "awg2",
      capabilities: { awg2: true, awg3: true },
    });
    for (const nodeId of [awg2Only, awg3Disabled]) {
      expect(
        await failureOf(repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id })),
      ).toMatchObject({ statusCode: 409, code: "BRIDGE_NODE_NOT_AWG31" });
    }
    const ok = await repository.prepareBridgeRoute(admin, awg3Reported, { bridgeId: bridge.id });
    expect(ok.created).toBe(true);
    const held = await db()
      .select()
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.bridgeId, bridge.id));
    expect(held).toHaveLength(1);
  });

  runDatabaseTest("A -> Direct -> A needs a fresh verification", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("demotion-clears");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    await activate(nodeId, route.id, 0);
    await activate(nodeId, null, 1);
    const retired = await routeRow(route.id);
    expect(retired).toMatchObject({
      state: "retiring",
      verificationMethod: null,
      verifiedRegistrationMarker: null,
      verifiedAt: null,
      verificationResult: null,
      verificationError: null,
    });
    // Same registration still online and fresh: only the verification is missing.
    await observe(bridge.id, route.id, { online: true, marker: "m-1" });
    expect(await failureOf(activate(nodeId, route.id, 2))).toMatchObject({
      statusCode: 409,
      code: "BRIDGE_ROUTE_UNVERIFIED",
    });
    expect(await revisionOf(nodeId)).toBe(2);
    await verify(route.id, { marker: "m-1" });
    const result = await activate(nodeId, route.id, 2);
    expect(result.vpnEndpoint).toMatchObject({ changed: true, vpnEndpointRevision: 3 });
  });

  runDatabaseTest("switching A -> B clears A's verification", async () => {
    const bridgeA = await createBridge({ name: "A" });
    const bridgeB = await createBridge({ name: "B" });
    const nodeId = await seedNode("a-to-b-clears");
    const { route: a } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridgeA.id });
    const { route: b } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridgeB.id });
    await makeActivatable(bridgeA.id, a.id);
    await activate(nodeId, a.id, 0);
    await makeActivatable(bridgeB.id, b.id, "m-b");
    await activate(nodeId, b.id, 1);
    expect(await routeRow(a.id)).toMatchObject({
      state: "retiring",
      verifiedAt: null,
      verificationResult: null,
    });
    // The newly active route keeps its own verification.
    expect((await routeRow(b.id))?.verificationResult).toBe("success");
  });

  runDatabaseTest("a retiring route is reactivated only after re-verification", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("reactivate");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    await activate(nodeId, route.id, 0);
    await activate(nodeId, null, 1);

    const reprepared = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    expect(reprepared).toMatchObject({
      created: false,
      route: {
        id: route.id,
        publicUdpPort: route.publicUdpPort,
        state: "retiring",
        verifiedAt: null,
        verificationResult: null,
        verifiedRegistrationMarker: null,
      },
    });
    await observe(bridge.id, route.id, { online: true, marker: "m-2" });
    expect(await failureOf(activate(nodeId, route.id, 2))).toMatchObject({
      code: "BRIDGE_ROUTE_UNVERIFIED",
    });
    await verify(route.id, { marker: "m-2" });
    const result = await activate(nodeId, route.id, 2);
    expect(result.vpnEndpoint).toMatchObject({ changed: true, vpnEndpointRevision: 3 });
    const row = await routeRow(route.id);
    expect(row?.state).toBe("active");
    expect(row?.retiringSince).toBeNull();
  });

  runDatabaseTest("a bridge with held routes cannot be deleted", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("bridge-delete");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    expect(await failureOf(repository.deleteBridge(admin, bridge.id))).toMatchObject({
      statusCode: 409,
      code: "BRIDGE_HAS_ROUTES",
    });
    await observe(bridge.id, route.id, { online: false });
    await repository.releaseBridgeRoute(admin, route.id);
    expect(await repository.deleteBridge(admin, bridge.id)).toEqual({ id: bridge.id, deleted: true });
    expect(await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridge.id))).toHaveLength(0);
  });

  runDatabaseTest("a node holding routes cannot be deleted, even with deleteKeys", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("node-delete");
    await db().insert(vpnKeys).values({
      ownerId: admin.id,
      nodeId,
      nodeLabel: `bridge_${runTag}_${randomBytes(3).toString("hex")}`,
      protocol: "awg3",
      routeProfile: "full_tunnel",
      state: "active",
    });
    await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    for (const deleteKeys of [false, true]) {
      expect(await failureOf(repository.deleteNode(admin, nodeId, { deleteKeys }))).toMatchObject({
        statusCode: 409,
        code: "NODE_HAS_BRIDGE_ROUTES",
      });
    }
    expect(await db().select().from(nodes).where(eq(nodes.id, nodeId))).toHaveLength(1);
    expect(await db().select().from(vpnKeys).where(eq(vpnKeys.nodeId, nodeId))).toHaveLength(1);
  });

  runDatabaseTest("a bridge outage leaves the selected active assignment in force", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("outage");
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    await makeActivatable(bridge.id, route.id);
    await activate(nodeId, route.id, 0);
    // The agent stops answering: status down, last observation long ago.
    await db()
      .update(vpnBridges)
      .set({ managementStatus: "down", lastObservedAt: new Date(Date.now() - 60 * MINUTE) })
      .where(eq(vpnBridges.id, bridge.id));
    const view = await repository.getNodeBridgeRoutes(admin, nodeId);
    expect(view.activeRoute?.id).toBe(route.id);
    expect(view.activeRoute?.bridgeManagementStatus).toBe("down");
    expect(view.vpnEndpointRevision).toBe(1);
    const items = await repository.listInfrastructure(admin);
    const vpnItem = items.find((item) => item.kind === "vpn" && item.id === nodeId);
    expect(vpnItem && vpnItem.kind === "vpn" ? vpnItem.activeRoute?.id : null).toBe(route.id);
  });

  describe("release", () => {
    const prepared = async () => {
      const bridge = await createBridge();
      const nodeId = await seedNode("release");
      const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      return { bridge, nodeId, route };
    };

    runDatabaseTest("an active route is refused", async () => {
      const { bridge, nodeId, route } = await prepared();
      await makeActivatable(bridge.id, route.id);
      await activate(nodeId, route.id, 0);
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_ROUTE_ACTIVE",
      });
    });

    runDatabaseTest("a stale or unobserved bridge keeps the reservation", async () => {
      const { bridge, route } = await prepared();
      // Enrolled (status ok) but with no observation of the route yet.
      await db()
        .update(vpnBridges)
        .set({ managementStatus: "ok", lastObservedAt: new Date() })
        .where(eq(vpnBridges.id, bridge.id));
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_OBSERVATION_STALE",
      });
      // Observed absent, but long ago.
      await observe(bridge.id, route.id, {
        online: false,
        at: new Date(Date.now() - 10 * MINUTE),
      });
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });
      // Fresh bridge poll that did not cover this route.
      await observe(bridge.id, route.id, {
        online: false,
        routeAt: new Date(Date.now() - 2 * MINUTE),
      });
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });
      // Fresh, but the registration is still online.
      await observe(bridge.id, route.id, { online: true, marker: "m-1" });
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });
      expect(await routeRow(route.id)).toBeDefined();
    });

    runDatabaseTest("a fresh observation without the registration releases the port", async () => {
      const { bridge, nodeId, route } = await prepared();
      await observe(bridge.id, route.id, { online: false });
      expect(await repository.releaseBridgeRoute(admin, route.id)).toEqual({
        id: route.id,
        released: true,
        nodeId,
        bridgeId: bridge.id,
        publicUdpPort: route.publicUdpPort,
      });
      expect(await routeRow(route.id)).toBeUndefined();
      // The freed port is the first free one again.
      const reused = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      expect(reused.route.publicUdpPort).toBe(route.publicUdpPort);
      expect(await failureOf(repository.releaseBridgeRoute(admin, randomUUID()))).toMatchObject({
        statusCode: 404,
        code: "BRIDGE_ROUTE_NOT_FOUND",
      });
    });

    runDatabaseTest("a draft on a never-enrolled bridge is released on confirmation", async () => {
      const { bridge, nodeId, route } = await prepared();
      const [row] = await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridge.id));
      expect(row).toMatchObject({ managementStatus: "pending_enrollment", lastObservedAt: null });
      expect(await repository.releaseBridgeRoute(admin, route.id)).toMatchObject({
        id: route.id,
        released: true,
        nodeId,
      });
      // And the pending bridge can now be deleted.
      expect(await repository.deleteBridge(admin, bridge.id)).toEqual({
        id: bridge.id,
        deleted: true,
      });
    });

    runDatabaseTest("a retiring route on a pending bridge is refused", async () => {
      const { bridge, nodeId, route } = await prepared();
      await makeActivatable(bridge.id, route.id);
      await activate(nodeId, route.id, 0);
      await activate(nodeId, null, 1);
      // Back to a never-observed pending state: the draft exception must not apply.
      await db()
        .update(vpnBridges)
        .set({ managementStatus: "pending_enrollment", lastObservedAt: null })
        .where(eq(vpnBridges.id, bridge.id));
      expect((await routeRow(route.id))?.state).toBe("retiring");
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_OBSERVATION_STALE",
      });
    });

    runDatabaseTest("a draft on an enrolled but stale bridge is refused", async () => {
      const { bridge, route } = await prepared();
      await observe(bridge.id, route.id, {
        online: false,
        at: new Date(Date.now() - 10 * MINUTE),
        status: "stale",
      });
      expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_OBSERVATION_STALE",
      });
      expect(await routeRow(route.id)).toBeDefined();
    });

    runDatabaseTest("a retiring route with a null observation flag is released", async () => {
      const { bridge, nodeId, route } = await prepared();
      await makeActivatable(bridge.id, route.id);
      await activate(nodeId, route.id, 0);
      await activate(nodeId, null, 1);
      await observe(bridge.id, route.id, { online: null });
      const result = await repository.releaseBridgeRoute(admin, route.id);
      expect(result.released).toBe(true);
    });
  });

  runDatabaseTest("the infrastructure view is a typed vpn/bridge union", async () => {
    const bridge = await createBridge();
    const nodeId = await seedNode("infra");
    await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    const items = await repository.listInfrastructure(admin);
    for (const item of items) infrastructureItemSchema.parse(item);
    const vpnItem = items.find((item) => item.id === nodeId);
    expect(vpnItem).toMatchObject({ kind: "vpn", vpnEndpointRevision: 0, activeRoute: null });
    const bridgeItem = items.find((item) => item.id === bridge.id);
    expect(bridgeItem).toMatchObject({ kind: "bridge", heldPorts: 1, capacity: 32 });
    // Bridges never show up in the VPN node lists.
    const adminNodes = (await repository.adminList(admin, "nodes")) as Array<{ id: string }>;
    expect(adminNodes.some((row) => row.id === bridge.id)).toBe(false);
  });

  describe("effective endpoint at delivery and eligibility", () => {
    const seedKey = async (
      nodeId: string,
      artifact: string | null,
      options: { protocol?: "awg2" | "awg3"; state?: "active" | "revoked" } = {},
    ): Promise<string> => {
      const secret = artifact === null ? null : encryptSecret(artifact, keyring, 1);
      const [row] = await db()
        .insert(vpnKeys)
        .values({
          ownerId: admin.id,
          nodeId,
          nodeLabel: `bridge_${runTag}_${randomBytes(3).toString("hex")}`,
          protocol: options.protocol ?? "awg3",
          routeProfile: "full_tunnel",
          state: options.state ?? "active",
          ...(secret
            ? {
                configCiphertext: secret.ciphertext,
                configNonce: secret.nonce,
                configAuthTag: secret.authTag,
                configKeyVersion: secret.keyVersion,
              }
            : {}),
        })
        .returning({ id: vpnKeys.id });
      if (!row) throw new Error("Failed to seed key");
      return row.id;
    };

    const endpointOf = async (keyId: string): Promise<string | undefined> => {
      const service = createDefaultControlApiService({ repository, keyring });
      const vpn = String((await service.getKeyConfig(admin, keyId, "vpn", false)).body);
      return readCopies(vpn, decodeVpnLink).line("Endpoint") ?? undefined;
    };

    const prepared = async (nodeId: string, name: string) => {
      const bridge = await createBridge({ name });
      const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      await makeActivatable(bridge.id, route.id);
      return { bridge, route };
    };

    runDatabaseTest("walks Direct, Bridge A, Bridge B, Direct for an existing key and a new key", async () => {
      const nodeId = await seedNode("delivery");
      const keyId = await seedKey(nodeId, awg31Link());
      const [before] = await db().select().from(vpnKeys).where(eq(vpnKeys.id, keyId));
      const a = await prepared(nodeId, "A");
      const b = await prepared(nodeId, "B");

      expect(await endpointOf(keyId)).toBe("vpn.example.test:443");
      await activate(nodeId, a.route.id, 0);
      expect(await endpointOf(keyId)).toBe(`${a.bridge.publicIpv4}:${a.route.publicUdpPort}`);
      // A key issued after the activation reads the same assignment.
      const fresh = await seedKey(nodeId, awg31Link());
      expect(await endpointOf(fresh)).toBe(`${a.bridge.publicIpv4}:${a.route.publicUdpPort}`);
      await makeActivatable(b.bridge.id, b.route.id);
      await activate(nodeId, b.route.id, 1);
      expect(await endpointOf(keyId)).toBe(`${b.bridge.publicIpv4}:${b.route.publicUdpPort}`);
      await activate(nodeId, null, 2);
      expect(await endpointOf(keyId)).toBe("vpn.example.test:443");
      expect(await endpointOf(fresh)).toBe("vpn.example.test:443");

      const [after] = await db().select().from(vpnKeys).where(eq(vpnKeys.id, keyId));
      expect(after?.configCiphertext).toBe(before?.configCiphertext);
      expect(after?.nodeId).toBe(nodeId);
    });

    runDatabaseTest("refuses an unsupported AWG3 artifact on an active bridge and serves native AWG 2 and 2.0 Direct", async () => {
      const nodeId = await seedNode("unsupported-delivery");
      const unmarked = await seedKey(nodeId, awg31Link({ protocolVersion: null }));
      const native = await seedKey(nodeId, awg31Link({ protocolVersion: null }), { protocol: "awg2" });
      const fallback = await seedKey(nodeId, awg31Link({ protocolVersion: "2" }));
      const ok = await seedKey(nodeId, awg31Link());
      // Activation itself refuses while the unmarked key is usable; revoke it to activate.
      const a = await prepared(nodeId, "A");
      await db().update(vpnKeys).set({ state: "revoked" }).where(eq(vpnKeys.id, unmarked));
      await activate(nodeId, a.route.id, 0);
      await db().update(vpnKeys).set({ state: "active" }).where(eq(vpnKeys.id, unmarked));

      const service = createDefaultControlApiService({ repository, keyring });
      expect(await failureOf(service.getKeyConfig(admin, unmarked, "vpn", false))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_CONFIG_UNSUPPORTED",
      });
      expect(await endpointOf(native)).toBe("vpn.example.test:443");
      expect(await endpointOf(fallback)).toBe("vpn.example.test:443");
      expect(await endpointOf(ok)).toBe(`${a.bridge.publicIpv4}:${a.route.publicUdpPort}`);
    });

    runDatabaseTest("the eligibility dry-run returns counts and unsupported key ids only", async () => {
      const nodeId = await seedNode("eligibility");
      await seedKey(nodeId, awg31Link());
      await seedKey(nodeId, awg31Link());
      await seedKey(nodeId, awg31Link({ protocolVersion: "2" }));
      await seedKey(nodeId, awg31Link({ protocolVersion: null }), { protocol: "awg2" });
      const unsupportedId = await seedKey(nodeId, awg31Link({ protocolVersion: null }));
      // Not usable: revoked, or without a saved config.
      await seedKey(nodeId, awg31Link({ protocolVersion: null }), { state: "revoked" });
      await seedKey(nodeId, null);
      const result = await repository.getBridgeEligibility(admin, nodeId);
      expect(bridgeEligibilitySchema.parse(result)).toEqual({
        nodeId,
        total: 5,
        awg31Eligible: 2,
        awg20Direct: 1,
        awg2NativeDirect: 1,
        unsupported: 1,
        unsupportedKeyIds: [unsupportedId],
      });
      expect(JSON.stringify(result)).not.toMatch(/synthetic|vpn:\/\//);
      expect(
        await failureOf(repository.getBridgeEligibility(admin, randomUUID())),
      ).toMatchObject({ statusCode: 404, code: "NODE_NOT_FOUND" });
    });

    runDatabaseTest("activation is refused while any usable AWG3 artifact is unsupported", async () => {
      const nodeId = await seedNode("activation-gate");
      await seedKey(nodeId, awg31Link());
      const bad = await seedKey(nodeId, awg31Link({ protocolVersion: null }));
      const a = await prepared(nodeId, "A");
      const failure = await failureOf(activate(nodeId, a.route.id, 0));
      expect(failure).toMatchObject({ statusCode: 409, code: "BRIDGE_CONFIG_UNSUPPORTED" });
      expect(failure?.message).not.toMatch(/synthetic|vpn:\/\//);
      expect(await revisionOf(nodeId)).toBe(0);
      expect((await routeRow(a.route.id))?.state).toBe("draft");
      // Direct is never gated.
      expect((await activate(nodeId, null, 0)).vpnEndpoint.changed).toBe(false);

      await db().update(vpnKeys).set({ state: "revoked" }).where(eq(vpnKeys.id, bad));
      expect((await activate(nodeId, a.route.id, 0)).vpnEndpoint.changed).toBe(true);
      // Checked on every activation, not only the first: a later bad key blocks B.
      await seedKey(nodeId, awg31Link({ protocolVersion: null }));
      const b = await prepared(nodeId, "B");
      expect(await failureOf(activate(nodeId, b.route.id, 1))).toMatchObject({
        code: "BRIDGE_CONFIG_UNSUPPORTED",
      });
      expect((await routeRow(a.route.id))?.state).toBe("active");
      // Returning to Direct stays possible.
      expect((await activate(nodeId, null, 1)).vpnEndpoint.changed).toBe(true);
    });
  });
});
