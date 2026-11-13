import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bridgeFrpProxyName, readBridgeAgentStatus } from "@amnezia/contracts";
import {
  applyBridgePollResult,
  auditEvents,
  createDatabase,
  decryptSecret,
  encryptSecret,
  nodes,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
} from "@amnezia/db";
import { inspectAwgVpnLink } from "@amnezia/vpn-config";

import { awg31Link } from "./awg31.fixture.js";
import { createDefaultControlApiService } from "./defaultService.js";
import { PostgresControlRepository } from "./postgresRepository.js";
import type { Actor } from "./service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const TOKEN = "bridge-agent-enroll-token-".padEnd(48, "z");
const M1 = "11111111111111111111111111111111";
const M2 = "22222222222222222222222222222222";
const MINUTE = 60_000;

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

describe("bridge enrollment and bridge-agent observations (real PostgreSQL, fake agent)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  let repository: PostgresControlRepository;
  let admin: Actor;
  let member: Actor;
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
        .values({ email: `enroll-${label}-${runTag}@example.com`, role })
        .returning();
      if (!user) throw new Error("Failed to seed user");
      createdUserIds.push(user.id);
      return { id: user.id, email: user.email, displayName: null, role, status: "active" };
    };
    admin = await seedUser("admin", "admin");
    member = await seedUser("member", "user");
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
        name: `enroll-${runTag}-${label}-${randomBytes(2).toString("hex")}`,
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
      name: `Enroll ${runTag} ${ipCounter}`,
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
  const routeRow = async (routeId: string) => {
    const [row] = await db().select().from(vpnBridgeRoutes).where(eq(vpnBridgeRoutes.id, routeId));
    if (!row) throw new Error("route missing");
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

  const reportOnline = (routeId: string, port: number, marker: string) => {
    agent.proxies = [
      { proxyId: bridgeFrpProxyName(routeId), remotePort: port, online: true, registrationMarker: marker },
    ];
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

  /** A node with a verified, active route on an enrolled bridge. */
  const activeRoute = async (label: string) => {
    const nodeId = await seedNode(label);
    const bridge = await createBridge();
    await enroll(bridge.id);
    const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
    reportOnline(route.id, route.publicUdpPort, M1);
    await poll(bridge.id);
    await operatorVerify(route.id, M1);
    await activate(nodeId, route.id);
    expect((await routeRow(route.id)).state).toBe("active");
    return { nodeId, bridge, route };
  };

  describe("enrollment", () => {
    runDatabaseTest(
      "checks the agent's identity, stores the credential encrypted and never returns it",
      async () => {
        const nodeId = await seedNode("enroll");
        const bridge = await createBridge();
        expect(bridge.managementStatus).toBe("pending_enrollment");
        expect(bridge.management).toMatchObject({ enrolled: false, apiUrl: null });
        const { route } = await repository.prepareBridgeRoute(admin, nodeId, {
          bridgeId: bridge.id,
        });
        reportOnline(route.id, route.publicUdpPort, M1);

        const result = await enroll(bridge.id);

        expect(result.managementStatus).toBe("ok");
        expect(result.lastObservedAt).not.toBeNull();
        expect(result.management).toMatchObject({
          apiUrl: agentUrl,
          enrolled: true,
          agentVersion: "0.1.0",
          agentApiVersion: 1,
          agentCapabilities: ["status.v1"],
          frpsVersion: "0.72.0",
          frpsReachable: true,
          lastErrorCode: null,
        });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(JSON.stringify(await repository.listBridges(admin))).not.toContain(TOKEN);
        expect(JSON.stringify(await repository.listInfrastructure(admin))).not.toContain(TOKEN);
        // The identity check came first, both with the candidate credential.
        expect(agent.requests.map((request) => request.path)).toEqual([
          "/v1/identity",
          "/v1/status",
        ]);
        expect(agent.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(
          true,
        );
        // The first status read is already the route's observation.
        expect(await routeRow(route.id)).toMatchObject({
          observedOnline: true,
          observedRegistrationMarker: M1,
        });

        const row = await bridgeRow(bridge.id);
        expect(JSON.stringify(row)).not.toContain(TOKEN);
        expect(
          decryptSecret(
            {
              ciphertext: row.managementCredentialCiphertext!,
              nonce: row.managementCredentialNonce!,
              authTag: row.managementCredentialAuthTag!,
              keyVersion: row.managementCredentialKeyVersion!,
            },
            keyring,
          ),
        ).toBe(TOKEN);

        const audits = await db()
          .select()
          .from(auditEvents)
          .where(
            and(eq(auditEvents.targetId, bridge.id), eq(auditEvents.action, "vpn_bridge.enrolled")),
          );
        expect(audits).toHaveLength(1);
        expect(audits[0]?.metadata).toEqual({
          replaced: false,
          agentApiVersion: 1,
          managementStatus: "ok",
        });
        expect(JSON.stringify(audits)).not.toContain(TOKEN);
      },
    );

    runDatabaseTest("a refused candidate leaves the working enrollment exactly as it was", async () => {
      const bridge = await createBridge();
      await enroll(bridge.id);
      const enrolled = await bridgeRow(bridge.id);
      const enrollmentColumns = (row: typeof enrolled) => ({
        url: row.managementApiUrl,
        ciphertext: row.managementCredentialCiphertext,
        enrolledAt: row.managementEnrolledAt?.getTime(),
        status: row.managementStatus,
        lastObservedAt: row.lastObservedAt?.getTime(),
      });

      const refusals: Array<{
        setup: () => void;
        request?: { managementApiUrl?: string; apiKey?: string };
        statusCode: number;
        code: string;
        requests?: number;
      }> = [
        { setup: () => (agent.bridgeId = "0b6a9d3c-1e2f-4a5b-8c7d-9e0f1a2b3c4d"), statusCode: 409, code: "BRIDGE_IDENTITY_MISMATCH" },
        { setup: () => (agent.identityApiVersion = 2), statusCode: 409, code: "BRIDGE_UNSUPPORTED_CAPABILITY" },
        { setup: () => (agent.capabilities = []), statusCode: 409, code: "BRIDGE_UNSUPPORTED_CAPABILITY" },
        { setup: () => undefined, request: { apiKey: "w".repeat(40) }, statusCode: 409, code: "BRIDGE_AGENT_UNAUTHORIZED" },
        { setup: () => undefined, request: { managementApiUrl: deadUrl }, statusCode: 502, code: "BRIDGE_AGENT_UNREACHABLE" },
        {
          setup: () => undefined,
          request: { managementApiUrl: agentUrl.replace("127.0.0.1", "localhost") },
          statusCode: 400,
          code: "BRIDGE_MANAGEMENT_URL_NOT_ALLOWED",
          requests: 0,
        },
      ];
      for (const refusal of refusals) {
        agent.reset();
        agent.bridgeId = bridge.id;
        refusal.setup();
        const failure = await failureOf(enroll(bridge.id, refusal.request));
        expect(failure).toMatchObject({ statusCode: refusal.statusCode, code: refusal.code });
        expect(failure?.message).not.toContain(TOKEN);
        if (refusal.requests !== undefined) expect(agent.requests).toHaveLength(refusal.requests);
        expect(enrollmentColumns(await bridgeRow(bridge.id))).toEqual(enrollmentColumns(enrolled));
      }

      agent.reset();
      expect(
        await failureOf(enroll("0b6a9d3c-1e2f-4a5b-8c7d-9e0f1a2b3c4d")),
      ).toMatchObject({ statusCode: 404, code: "BRIDGE_NOT_FOUND" });
      expect(agent.requests).toHaveLength(0);

      // An allowlist entry with a port admits only that port.
      const agentPort = Number(new URL(agentUrl).port);
      const pinned = (port: number) =>
        new PostgresControlRepository({
          db: db(),
          keyring,
          bridgeManagementHosts: [`127.0.0.1:${port}`],
        });
      agent.reset();
      agent.bridgeId = bridge.id;
      expect(
        await failureOf(
          pinned(agentPort + 1).updateBridge(admin, bridge.id, {
            managementApiUrl: agentUrl,
            apiKey: TOKEN,
          }),
        ),
      ).toMatchObject({ statusCode: 400, code: "BRIDGE_MANAGEMENT_URL_NOT_ALLOWED" });
      expect(agent.requests).toHaveLength(0);
      expect(enrollmentColumns(await bridgeRow(bridge.id))).toEqual(enrollmentColumns(enrolled));

      // A good replacement is stored and audited as one.
      agent.bridgeId = bridge.id;
      await pinned(agentPort).updateBridge(admin, bridge.id, {
        managementApiUrl: agentUrl,
        apiKey: TOKEN,
      });
      const replaced = await bridgeRow(bridge.id);
      expect(replaced.managementEnrolledAt!.getTime()).toBeGreaterThan(
        enrolled.managementEnrolledAt!.getTime(),
      );
      expect(replaced.managementCredentialCiphertext).not.toBe(enrolled.managementCredentialCiphertext);
      const audits = await db()
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.targetId, bridge.id), eq(auditEvents.action, "vpn_bridge.enrolled")));
      expect(audits.map((audit) => audit.metadata?.replaced).sort()).toEqual([false, true]);
    });

    runDatabaseTest(
      "an agent that fails the first status read is enrolled as down; a draft then needs a fresh absent observation",
      async () => {
        const nodeId = await seedNode("r9");
        const bridge = await createBridge();
        const { route } = await repository.prepareBridgeRoute(admin, nodeId, {
          bridgeId: bridge.id,
        });
        agent.statusFails = true;

        const result = await enroll(bridge.id);

        expect(result.managementStatus).toBe("down");
        expect(result.management?.lastErrorCode).toBe("AGENT_HTTP_ERROR");
        expect(result.lastObservedAt).toBeNull();
        // Out of pending_enrollment: the never-enrolled exception (R9) no
        // longer applies.
        expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
          code: "BRIDGE_OBSERVATION_STALE",
        });
        agent.statusFails = false;
        await poll(bridge.id);
        await expect(repository.releaseBridgeRoute(admin, route.id)).resolves.toMatchObject({
          released: true,
        });
      },
    );
  });

  describe("activation and release read the real observations", () => {
    runDatabaseTest("an frpc reconnect between verification and activation is refused", async () => {
      const nodeId = await seedNode("reconnect");
      const bridge = await createBridge();
      await enroll(bridge.id);
      const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      reportOnline(route.id, route.publicUdpPort, M1);
      await poll(bridge.id);
      await operatorVerify(route.id, M1);

      // frpc reconnects: same name and port, a new registration.
      reportOnline(route.id, route.publicUdpPort, M2);
      await poll(bridge.id);

      expect(await failureOf(activate(nodeId, route.id))).toMatchObject({
        statusCode: 409,
        code: "BRIDGE_ROUTE_UNVERIFIED",
      });
      expect((await routeRow(route.id)).state).toBe("draft");
      expect(await revisionOf(nodeId)).toBe(0);

      await operatorVerify(route.id, M2);
      await activate(nodeId, route.id);
      expect((await routeRow(route.id)).state).toBe("active");
    });

    runDatabaseTest("the route reported on another port is not online, so activation is refused", async () => {
      const nodeId = await seedNode("port");
      const bridge = await createBridge();
      await enroll(bridge.id);
      const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      // Operator verified before any observation (stored as given).
      await operatorVerify(route.id, M1);
      reportOnline(route.id, route.publicUdpPort + 1, M1);
      await poll(bridge.id);
      expect(await failureOf(activate(nodeId, route.id))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });
      expect((await bridgeRow(bridge.id)).lastErrorCode).toBe("ROUTE_PORT_MISMATCH");
    });

    runDatabaseTest("a foreign identity or a stale observation stays Unknown", async () => {
      const nodeId = await seedNode("unknown");
      const bridge = await createBridge();
      await enroll(bridge.id);
      const { route } = await repository.prepareBridgeRoute(admin, nodeId, { bridgeId: bridge.id });
      reportOnline(route.id, route.publicUdpPort, M1);
      await poll(bridge.id);
      await operatorVerify(route.id, M1);

      agent.bridgeId = "0b6a9d3c-1e2f-4a5b-8c7d-9e0f1a2b3c4d";
      await poll(bridge.id);
      expect((await repository.listBridges(admin)).find((b) => b.id === bridge.id)?.managementStatus).toBe(
        "identity_mismatch",
      );
      expect(await failureOf(activate(nodeId, route.id))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });

      agent.bridgeId = bridge.id;
      await poll(bridge.id);
      // No poll since: the observation ages past the window.
      const old = new Date(Date.now() - 10 * MINUTE);
      await db().update(vpnBridges).set({ lastObservedAt: old }).where(eq(vpnBridges.id, bridge.id));
      await db().update(vpnBridgeRoutes).set({ observedAt: old }).where(eq(vpnBridgeRoutes.id, route.id));
      expect((await repository.listBridges(admin)).find((b) => b.id === bridge.id)?.managementStatus).toBe(
        "stale",
      );
      expect(await failureOf(activate(nodeId, route.id))).toMatchObject({
        code: "BRIDGE_OBSERVATION_STALE",
      });
      expect((await routeRow(route.id)).state).toBe("draft");
    });

    runDatabaseTest(
      "an unreachable frps refuses activation and release and keeps the active route",
      async () => {
        const { nodeId, bridge, route } = await activeRoute("frps");
        const second = await createBridge();
        await enroll(second.id);
        const { route: candidate } = await repository.prepareBridgeRoute(admin, nodeId, {
          bridgeId: second.id,
        });
        agent.bridgeId = second.id;
        reportOnline(candidate.id, candidate.publicUdpPort, M2);
        await poll(second.id);
        await operatorVerify(candidate.id, M2);

        agent.frpsReachable = false;
        await poll(second.id);
        expect(await failureOf(activate(nodeId, candidate.id))).toMatchObject({
          code: "BRIDGE_OBSERVATION_STALE",
        });
        expect(await failureOf(repository.releaseBridgeRoute(admin, candidate.id))).toMatchObject({
          code: "BRIDGE_OBSERVATION_STALE",
        });
        expect((await routeRow(route.id)).state).toBe("active");
        expect((await repository.getNodeBridgeRoutes(admin, nodeId)).activeRoute?.id).toBe(route.id);
        expect((await bridgeRow(bridge.id)).managementStatus).toBe("ok");
      },
    );

    runDatabaseTest("a missing bridge-agent never changes a working route or its export", async () => {
      const { nodeId, bridge, route } = await activeRoute("missing");
      const secret = encryptSecret(awg31Link(), keyring, 1);
      const [key] = await db()
        .insert(vpnKeys)
        .values({
          ownerId: admin.id,
          nodeId,
          nodeLabel: `enroll_${runTag}_${randomBytes(3).toString("hex")}`,
          protocol: "awg3",
          routeProfile: "full_tunnel",
          state: "active",
          configCiphertext: secret.ciphertext,
          configNonce: secret.nonce,
          configAuthTag: secret.authTag,
          configKeyVersion: secret.keyVersion,
        })
        .returning({ id: vpnKeys.id });
      const service = createDefaultControlApiService({ repository, keyring });
      const endpoint = async () => {
        const inspected = inspectAwgVpnLink(
          String((await service.getKeyConfig(admin, key!.id, "vpn", false)).body),
        );
        return inspected.kind === "awg31"
          ? `${inspected.endpoint.host}:${inspected.endpoint.port}`
          : null;
      };
      expect(await endpoint()).toBe(`${bridge.publicIpv4}:${route.publicUdpPort}`);
      const before = await routeRow(route.id);

      await poll(bridge.id, deadUrl);

      expect((await bridgeRow(bridge.id)).managementStatus).toBe("down");
      expect(await routeRow(route.id)).toEqual(before);
      expect((await repository.getNodeBridgeRoutes(admin, nodeId)).activeRoute?.id).toBe(route.id);
      expect(await endpoint()).toBe(`${bridge.publicIpv4}:${route.publicUdpPort}`);
    });

    runDatabaseTest(
      "releasing a retiring port needs a fresh observation of the removed forwarding",
      async () => {
        const { nodeId, bridge, route } = await activeRoute("release");
        await activate(nodeId, null);
        expect((await routeRow(route.id)).state).toBe("retiring");

        // The forwarding is still registered.
        await poll(bridge.id);
        expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
          code: "BRIDGE_OBSERVATION_STALE",
        });
        // Removed on the node, but not yet observed.
        agent.proxies = [];
        expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
          code: "BRIDGE_OBSERVATION_STALE",
        });
        // A down agent proves nothing either.
        await poll(bridge.id, deadUrl);
        expect(await failureOf(repository.releaseBridgeRoute(admin, route.id))).toMatchObject({
          code: "BRIDGE_OBSERVATION_STALE",
        });
        // frps keeps an offline proxy listed until it restarts (ruling R18):
        // listed offline under this name counts as the registration gone.
        agent.proxies = [
          { proxyId: bridgeFrpProxyName(route.id), remotePort: null, online: false, registrationMarker: M1 },
        ];
        await poll(bridge.id);
        await expect(repository.releaseBridgeRoute(admin, route.id)).resolves.toMatchObject({
          released: true,
          publicUdpPort: route.publicUdpPort,
        });
      },
    );

    runDatabaseTest(
      "activation and release wait for an in-flight poll of the bridge and judge its result",
      async () => {
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
        /** A poll that stored `down` and has not committed yet. */
        const holdDownPoll = async (bridgeId: string) => {
          const { managementEnrolledAt } = await bridgeRow(bridgeId);
          let commit!: () => void;
          let written!: () => void;
          const committed = new Promise<void>((resolve) => (commit = resolve));
          const applied = new Promise<void>((resolve) => (written = resolve));
          const transaction = db().transaction(async (tx) => {
            await applyBridgePollResult(tx, {
              bridgeId,
              enrolledAt: managementEnrolledAt!,
              startedAt: new Date(),
              outcome: { kind: "down", errorCode: "AGENT_TIMEOUT" },
            });
            written();
            await committed;
          });
          await applied;
          return async () => {
            commit();
            await transaction;
          };
        };

        // Activation of a verified draft whose bridge is being polled.
        const nodeId = await seedNode("race");
        const bridge = await createBridge();
        await enroll(bridge.id);
        const { route } = await repository.prepareBridgeRoute(admin, nodeId, {
          bridgeId: bridge.id,
        });
        reportOnline(route.id, route.publicUdpPort, M1);
        await poll(bridge.id);
        await operatorVerify(route.id, M1);
        const finishPoll = await holdDownPoll(bridge.id);
        const activation = failureOf(activate(nodeId, route.id));
        await waitForLockWait();
        await finishPoll();
        expect(await activation).toMatchObject({ code: "BRIDGE_OBSERVATION_STALE" });
        expect((await routeRow(route.id)).state).toBe("draft");

        // Release of a draft whose forwarding the last poll saw absent.
        agent.proxies = [];
        await poll(bridge.id);
        const finishSecond = await holdDownPoll(bridge.id);
        const release = failureOf(repository.releaseBridgeRoute(admin, route.id));
        await waitForLockWait();
        await finishSecond();
        expect(await release).toMatchObject({ code: "BRIDGE_OBSERVATION_STALE" });
        expect((await routeRow(route.id)).state).toBe("draft");
      },
    );

    runDatabaseTest("node deletion is refused while a port is held, also with deleteKeys", async () => {
      const { nodeId } = await activeRoute("delete");
      for (const deleteKeys of [false, true]) {
        expect(
          await failureOf(repository.deleteNode(admin, nodeId, { deleteKeys })),
        ).toMatchObject({ statusCode: 409, code: "NODE_HAS_BRIDGE_ROUTES" });
      }
      expect(await revisionOf(nodeId)).toBe(1);
    });

    runDatabaseTest("bridges never enter user server selection or the admin node list", async () => {
      const { nodeId, bridge } = await activeRoute("selection");
      const userNodes = (await repository.listNodes(member)) as Array<{ id: string }>;
      expect(userNodes.map((node) => node.id)).toContain(nodeId);
      expect(userNodes.map((node) => node.id)).not.toContain(bridge.id);
      const adminNodes = (await repository.adminList(admin, "nodes")) as Array<{ id: string }>;
      expect(adminNodes.map((node) => node.id)).not.toContain(bridge.id);
    });
  });
});
