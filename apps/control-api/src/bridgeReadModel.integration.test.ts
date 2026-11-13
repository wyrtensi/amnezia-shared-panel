import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bridgeFrpProxyName, readBridgeAgentStatus } from "@amnezia/contracts";
import {
  applyBridgePollResult,
  auditEvents,
  createDatabase,
  nodeReachabilityResults,
  reachabilityProbe,
  encryptSecret,
  nodes,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
} from "@amnezia/db";

import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const TOKEN = "bridge-agent-enroll-token-".padEnd(48, "z");
const M1 = "11111111111111111111111111111111";
const M2 = "22222222222222222222222222222222";
const MINUTE = 60_000;

type Proxy = {
  proxyId: string;
  remotePort: number | null;
  online: boolean;
  registrationMarker: string | null;
};

/** A stand-in bridge-agent: a real local HTTP server with the v1 API. */
const agent = {
  /** The id `/v1/identity` and `/v1/status` report; set to the bridge's. */
  bridgeId: "",
  identityApiVersion: 1,
  capabilities: ["status.v1"],
  statusFails: false,
  frpsReachable: true,
  proxies: [] as Proxy[],
  requests: [] as Array<{ path: string; authorization: string | undefined }>,
  reset() {
    this.bridgeId = "";
    this.identityApiVersion = 1;
    this.capabilities = ["status.v1"];
    this.statusFails = false;
    this.frpsReachable = true;
    this.proxies = [];
    this.requests = [];
  },
};

describe("bridge admin read model (real PostgreSQL, fake agent)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  let repository: PostgresControlRepository;
  let admin: Actor;
  let server: Server;
  let agentUrl: string;
  let deadUrl: string;
  const createdNodeIds: string[] = [];
  const createdBridgeIds: string[] = [];
  const createdUserIds: string[] = [];
  let ipCounter = 0;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      agent.requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
        return;
      }
      if (req.url === "/v1/identity") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            bridgeId: agent.bridgeId,
            agentVersion: "0.1.0",
            apiVersion: agent.identityApiVersion,
            capabilities: agent.capabilities,
          }),
        );
        return;
      }
      if (req.url === "/v1/status") {
        if (agent.statusFails) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            bridgeId: agent.bridgeId,
            agentVersion: "0.1.0",
            apiVersion: 1,
            observedAt: new Date().toISOString(),
            frps: { reachable: agent.frpsReachable, version: agent.frpsReachable ? "0.72.0" : null },
            applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
            proxies: agent.frpsReachable ? agent.proxies : [],
            errors: agent.frpsReachable
              ? []
              : [{ code: "FRPS_UNREACHABLE", message: "frps did not answer" }],
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A port nothing listens on: the agent gone.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    if (!database) return;
    repository = new PostgresControlRepository({
      db: database.db,
      keyring,
      bridgeManagementHosts: ["127.0.0.1"],
      bridgeAgentTimeoutMs: 2_000,
    });
    const seedUser = async (label: string, role: "admin" | "user"): Promise<Actor> => {
      const [user] = await db()
        .insert(users)
        .values({ email: `readmodel-${label}-${runTag}@example.com`, role })
        .returning();
      if (!user) throw new Error("Failed to seed user");
      createdUserIds.push(user.id);
      return { id: user.id, email: user.email, displayName: null, role, status: "active" };
    };
    admin = await seedUser("admin", "admin");
  });

  afterEach(async () => {
    agent.reset();
    if (!database) return;
    if (createdBridgeIds.length > 0) {
      await database.db
        .delete(vpnBridgeRoutes)
        .where(inArray(vpnBridgeRoutes.bridgeId, createdBridgeIds));
      await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, createdBridgeIds));
    }
    if (createdNodeIds.length > 0) {
      await database.db.delete(vpnBridgeRoutes).where(inArray(vpnBridgeRoutes.nodeId, createdNodeIds));
      await database.db.delete(vpnKeys).where(inArray(vpnKeys.nodeId, createdNodeIds));
      await database.db.delete(nodes).where(inArray(nodes.id, createdNodeIds));
    }
    createdBridgeIds.length = 0;
    createdNodeIds.length = 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!database) return;
    if (createdUserIds.length > 0) {
      await database.db.delete(auditEvents).where(inArray(auditEvents.actorUserId, createdUserIds));
      await database.db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await database.client.end();
  });

  const nextIpv4 = (): string => {
    ipCounter += 1;
    const seed = parseInt(runTag, 16);
    return `49.${(seed >> 8) & 0xff}.${seed & 0xff}.${ipCounter}`;
  };

  const seedNode = async (label: string): Promise<string> => {
    const credentials = encryptSecret("api-key", keyring, 1);
    const labelSecret = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `readmodel-${runTag}-${label}-${randomBytes(2).toString("hex")}`,
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
    createdNodeIds.push(node.id);
    return node.id;
  };

  const createBridge = async () => {
    const bridge = await repository.createBridge(admin, {
      name: `Readmodel ${runTag} ${ipCounter}`,
      publicIpv4: nextIpv4(),
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
    createdBridgeIds.push(bridge.id);
    agent.bridgeId = bridge.id;
    return bridge;
  };

  const enroll = (bridgeId: string, overrides: { managementApiUrl?: string; apiKey?: string } = {}) =>
    repository.updateBridge(admin, bridgeId, {
      managementApiUrl: overrides.managementApiUrl ?? `${agentUrl}/`,
      apiKey: overrides.apiKey ?? TOKEN,
    });

  const bridgeRow = async (bridgeId: string) => {
    const [row] = await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridgeId));
    if (!row) throw new Error("bridge missing");
    return row;
  };
  /**
   * One worker poll: the same two halves the worker's `bridge_agent.poll`
   * handler composes (the shared client + classifier, then the shared write).
   */
  const poll = async (bridgeId: string, baseUrl = agentUrl) => {
    const row = await bridgeRow(bridgeId);
    if (!row.managementEnrolledAt) throw new Error("not enrolled");
    const startedAt = new Date();
    const outcome = await readBridgeAgentStatus(bridgeId, { baseUrl, apiKey: TOKEN, timeoutMs: 2_000 });
    return db().transaction((tx) =>
      applyBridgePollResult(tx, {
        bridgeId,
        enrolledAt: row.managementEnrolledAt!,
        startedAt,
        outcome,
      }),
    );
  };

  const revisionOf = async (nodeId: string): Promise<number> => {
    const [row] = await db()
      .select({ revision: nodes.vpnEndpointRevision })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    return row?.revision ?? -1;
  };

  const activate = async (nodeId: string, routeId: string | null) =>
    repository.updateNode(admin, nodeId, {
      vpnBridgeRouteId: routeId,
      expectedVpnEndpointRevision: await revisionOf(nodeId),
    });

  const operatorVerify = (routeId: string, registrationMarker: string) =>
    repository.verifyBridgeRoute(admin, routeId, {
      method: "operator",
      registrationMarker,
      confirmHandshakeAndHttp: true,
    });

  const seedRoute = async (label: string, bridgeId: string) => {
    const nodeId = await seedNode(label);
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId });
    return { nodeId, route };
  };

  const summaryOf = async (bridgeId: string) => {
    const bridge = (await repository.listBridges(admin)).find((item) => item.id === bridgeId);
    if (!bridge) throw new Error("bridge missing");
    return bridge;
  };

  runDatabaseTest(
    "two routes on one bridge are observed independently; the overview and node counters stay separate",
    async () => {
      const before = (await repository.getAdminOverview()) as {
        nodes: { total: number; enabled: number };
      };

      const bridge = await createBridge();
      await enroll(bridge.id);
      const a = await seedRoute("a", bridge.id);
      const b = await seedRoute("b", bridge.id);
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(a.route.id), remotePort: a.route.publicUdpPort, online: true, registrationMarker: M1 },
        { proxyId: bridgeFrpProxyName(b.route.id), remotePort: b.route.publicUdpPort, online: true, registrationMarker: M2 },
      ];
      await poll(bridge.id);
      await operatorVerify(a.route.id, M1);
      await operatorVerify(b.route.id, M2);
      await activate(a.nodeId, a.route.id);

      const read = await summaryOf(bridge.id);
      expect(read.managementStatus).toBe("ok");
      const routeA = read.routes.find((route) => route.id === a.route.id)!;
      const routeB = read.routes.find((route) => route.id === b.route.id)!;
      expect(routeA).toMatchObject({
        state: "active",
        registration: { status: "online", marker: M1 },
        // No probe or AWG 3.1 result for the active route's node: unknown (R19).
        verification: { kind: "awg_path", status: "unknown", checkedAt: null },
      });
      expect(routeB).toMatchObject({
        state: "draft",
        registration: { status: "online", marker: M2 },
        verification: { kind: "candidate", status: "valid", method: "operator" },
      });

      // The same typed rows reach the infrastructure view.
      const infra = (await repository.listInfrastructure(admin)).find(
        (item) => item.kind === "bridge" && item.id === bridge.id,
      );
      expect(infra).toMatchObject({ kind: "bridge", routes: read.routes });

      // Overview: its own block, VPN node counters unchanged by the bridge.
      const overview = (await repository.getAdminOverview()) as {
        nodes: { total: number; enabled: number };
        bridges?: { count: number; items: Array<Record<string, unknown>> };
      };
      expect(overview.bridges?.items.find((item) => item.id === bridge.id)).toEqual({
        id: bridge.id,
        name: bridge.name,
        managementStatus: "ok",
        lastObservedAt: read.lastObservedAt,
        activeRoutes: 1,
        verifiedActiveRoutes: 0,
        awgPathOk: 0,
        awgPathFailed: 0,
        awgPathUnknown: 1,
      });
      expect(overview.bridges?.count).toBe(overview.bridges?.items.length);
      // Two seeded VPN nodes were added; the bridge itself added none.
      expect(overview.nodes.total - before.nodes.total).toBe(2);

      // Stop only route B's frpc: only its registration changes.
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(a.route.id), remotePort: a.route.publicUdpPort, online: true, registrationMarker: M1 },
        { proxyId: bridgeFrpProxyName(b.route.id), remotePort: null, online: false, registrationMarker: null },
      ];
      await poll(bridge.id);
      const afterStop = await summaryOf(bridge.id);
      expect(afterStop.routes.find((route) => route.id === a.route.id)).toMatchObject({
        registration: { status: "online", marker: M1 },
        verification: { kind: "awg_path" },
      });
      expect(afterStop.routes.find((route) => route.id === b.route.id)).toMatchObject({
        registration: { status: "offline", marker: null },
        // The registration left, so the poller cleared its verification.
        verification: { kind: "candidate", status: "none" },
      });

      // Management lost: status down, the route keeps its assignment, and the
      // last registration reads Unknown instead of a stale "online".
      await poll(bridge.id, deadUrl);
      const down = await summaryOf(bridge.id);
      expect(down.managementStatus).toBe("down");
      expect(down.routes.find((route) => route.id === a.route.id)?.registration.status).toBe("unknown");
      const nodeRoutes = await repository.getNodeBridgeRoutes(admin, a.nodeId);
      expect(nodeRoutes.activeRoute).toMatchObject({ id: a.route.id, state: "active", bridgeManagementStatus: "down" });

      // The agent comes back (restart): both routes are reported again.
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(a.route.id), remotePort: a.route.publicUdpPort, online: true, registrationMarker: M1 },
        { proxyId: bridgeFrpProxyName(b.route.id), remotePort: b.route.publicUdpPort, online: true, registrationMarker: M2 },
      ];
      await poll(bridge.id);
      const back = await summaryOf(bridge.id);
      expect(back.managementStatus).toBe("ok");
      expect(back.routes.map((route) => route.registration.status)).toEqual(["online", "online"]);
    },
  );

  runDatabaseTest(
    "an active route's AWG path is the node's AWG 3.1 reachability result, mapped to ok / failed / unknown",
    async () => {
      const bridge = await createBridge();
      await enroll(bridge.id);
      const a = await seedRoute("awg", bridge.id);
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(a.route.id), remotePort: a.route.publicUdpPort, online: true, registrationMarker: M1 },
      ];
      await poll(bridge.id);
      await operatorVerify(a.route.id, M1);
      await activate(a.nodeId, a.route.id);

      const credentials = encryptSecret("probe-api-key", keyring, 1);
      await db().delete(reachabilityProbe);
      await db().insert(reachabilityProbe).values({
        label: "readmodel-probe",
        apiBaseUrl: "http://probe-host.invalid:4002",
        credentialsCiphertext: credentials.ciphertext,
        credentialsNonce: credentials.nonce,
        credentialsAuthTag: credentials.authTag,
        credentialsKeyVersion: credentials.keyVersion,
        controlUrl: "https://control.invalid/",
        lastResultAt: new Date(),
        enabledAt: new Date(Date.now() - 86_400_000),
        timeZone: "Europe/Belgrade",
      });
      try {
        const verificationOf = async () =>
          (await summaryOf(bridge.id)).routes.find((route) => route.id === a.route.id)?.verification;
        const overviewOf = async () =>
          (
            (await repository.getAdminOverview()) as {
              bridges?: { items: Array<{ id: string; awgPathOk: number; awgPathFailed: number; awgPathUnknown: number }> };
            }
          ).bridges?.items.find((item) => item.id === bridge.id);
        const checkedAt = new Date(Date.now() - 60_000);
        const put = async (status: "ok" | "failed" | "error") => {
          await db().delete(nodeReachabilityResults).where(eq(nodeReachabilityResults.nodeId, a.nodeId));
          await db().insert(nodeReachabilityResults).values({
            nodeId: a.nodeId,
            protocol: "awg3",
            status,
            levels: {},
            runId: randomUUID(),
            checkedAt,
            failingSince: status === "failed" ? checkedAt : null,
          });
        };

        await put("ok");
        expect(await verificationOf()).toEqual({ kind: "awg_path", status: "ok", checkedAt: checkedAt.toISOString() });
        expect(await overviewOf()).toMatchObject({ awgPathOk: 1, awgPathFailed: 0, awgPathUnknown: 0 });
        expect((await repository.getNodeBridgeRoutes(admin, a.nodeId)).activeRoute?.verification).toMatchObject({
          kind: "awg_path",
          status: "ok",
        });

        await put("failed");
        expect(await verificationOf()).toMatchObject({ status: "failed" });
        expect(await overviewOf()).toMatchObject({ awgPathOk: 0, awgPathFailed: 1, awgPathUnknown: 0 });

        await put("error");
        expect(await verificationOf()).toMatchObject({ status: "unknown" });

        // A result from before the endpoint change is gone: nothing to read.
        await db().delete(nodeReachabilityResults).where(eq(nodeReachabilityResults.nodeId, a.nodeId));
        expect(await verificationOf()).toEqual({ kind: "awg_path", status: "unknown", checkedAt: null });

        // A bridge that is not ok cannot vouch for the path, whatever the probe says.
        await put("ok");
        await db().update(vpnBridges).set({ lastObservedAt: new Date(Date.now() - 10 * MINUTE) }).where(eq(vpnBridges.id, bridge.id));
        expect(await overviewOf()).toMatchObject({ awgPathOk: 0, awgPathFailed: 0, awgPathUnknown: 1 });
      } finally {
        await db().delete(nodeReachabilityResults).where(eq(nodeReachabilityResults.nodeId, a.nodeId));
        await db().delete(reachabilityProbe);
      }
    },
  );

  runDatabaseTest(
    "a stored ok past the stale window reads stale everywhere, including the node route and overview",
    async () => {
      const bridge = await createBridge();
      await enroll(bridge.id);
      const a = await seedRoute("stale", bridge.id);
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(a.route.id), remotePort: a.route.publicUdpPort, online: true, registrationMarker: M1 },
      ];
      await poll(bridge.id);
      const old = new Date(Date.now() - 10 * MINUTE);
      await db().update(vpnBridges).set({ lastObservedAt: old }).where(eq(vpnBridges.id, bridge.id));

      const read = await summaryOf(bridge.id);
      expect(read.managementStatus).toBe("stale");
      expect(read.routes[0]?.registration).toMatchObject({ status: "unknown", marker: null });
      const infra = (await repository.listInfrastructure(admin)).find(
        (item) => item.kind === "bridge" && item.id === bridge.id,
      );
      expect(infra).toMatchObject({ managementStatus: "stale" });
      const { drafts } = await repository.getNodeBridgeRoutes(admin, a.nodeId);
      expect(drafts[0]?.bridgeManagementStatus).toBe("stale");
      const overview = (await repository.getAdminOverview()) as {
        bridges?: { items: Array<{ id: string; managementStatus: string }> };
      };
      expect(overview.bridges?.items.find((item) => item.id === bridge.id)?.managementStatus).toBe("stale");
    },
  );
});
