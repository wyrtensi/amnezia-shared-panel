import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BRIDGE_AGENT_POLL_JOB_TYPE,
  bridgeAgentPollDeduplicationKey,
  bridgeFrpProxyName,
} from "@amnezia/contracts";
import {
  createDatabase,
  encryptSecret,
  jobOutbox,
  nodes,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
} from "@amnezia/db";

import { createBridgeAgentPoll, createBridgePollArmer } from "./bridgePoller.js";
import { PostgresBridgePollRepository } from "./bridgePollRepository.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";
import {
  PostgresReachabilityRepository,
  SERVICE_ACCOUNT_EMAIL,
} from "./reachabilityRepository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const TOKEN = "bridge-agent-test-token-".padEnd(48, "x");
const M1 = "11111111111111111111111111111111";
const M2 = "22222222222222222222222222222222";

type Proxy = {
  proxyId: string;
  remotePort: number | null;
  online: boolean;
  registrationMarker: string | null;
};

/**
 * A stand-in bridge-agent: a real local HTTP server answering the v1
 * management API from mutable state, with the agent's bearer check.
 */
type FakeAgent = {
  bridgeId: string;
  apiVersion: number;
  frpsReachable: boolean;
  proxies: Proxy[];
  mode: "normal" | "hang";
  requests: number;
};

describe("bridge-agent poller (real PostgreSQL, fake bridge-agent over HTTP)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  const createdNodeIds: string[] = [];
  const createdBridgeIds: string[] = [];
  let server: Server;
  let agentUrl: string;
  const agent: FakeAgent = {
    bridgeId: "",
    apiVersion: 1,
    frpsReachable: true,
    proxies: [],
    mode: "normal",
    requests: 0,
  };
  let workerRepository: PostgresWorkerRepository;
  let pollRepository: PostgresBridgePollRepository;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      agent.requests += 1;
      if (agent.mode === "hang") return;
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          bridgeId: agent.bridgeId,
          agentVersion: "0.1.0",
          apiVersion: agent.apiVersion,
          observedAt: new Date().toISOString(),
          frps: { reachable: agent.frpsReachable, version: agent.frpsReachable ? "0.72.0" : null },
          applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
          proxies: agent.frpsReachable ? agent.proxies : [],
          errors: agent.frpsReachable
            ? []
            : [{ code: "FRPS_UNREACHABLE", message: "frps did not answer" }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (!database) return;
    workerRepository = new PostgresWorkerRepository({
      db: database.db,
      keyring,
      activeKeyVersion: 1,
    });
    pollRepository = new PostgresBridgePollRepository({ db: database.db, keyring });
  });

  afterEach(async () => {
    agent.apiVersion = 1;
    agent.frpsReachable = true;
    agent.proxies = [];
    agent.mode = "normal";
    agent.requests = 0;
    if (!database) return;
    if (createdBridgeIds.length > 0) {
      await database.db
        .delete(jobOutbox)
        .where(
          inArray(
            jobOutbox.deduplicationKey,
            createdBridgeIds.map((id) => bridgeAgentPollDeduplicationKey(id)),
          ),
        );
      await database.db
        .delete(vpnBridgeRoutes)
        .where(inArray(vpnBridgeRoutes.bridgeId, createdBridgeIds));
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.client.end();
  });

  const seedNode = async () => {
    const credentials = encryptSecret("k".repeat(32), keyring, 1);
    const label = encryptSecret(randomBytes(32).toString("base64"), keyring, 1);
    const [node] = await db()
      .insert(nodes)
      .values({
        name: `poll-${runTag}-${randomBytes(2).toString("hex")}`,
        apiBaseUrl: "http://127.0.0.1:4001",
        protocol: "awg3",
        reachabilityEnabled: false,
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
    return node;
  };

  /** An enrolled bridge pointing at the fake agent. */
  const seedBridge = async (options: { enrolled?: boolean; apiUrl?: string } = {}) => {
    const enrolled = options.enrolled ?? true;
    const seed = parseInt(runTag, 16);
    const credential = encryptSecret(TOKEN, keyring, 1);
    const [bridge] = await db()
      .insert(vpnBridges)
      .values({
        name: `Poll bridge ${runTag} ${createdBridgeIds.length}`,
        publicIpv4: `48.${(seed >> 8) & 0xff}.${seed & 0xff}.${createdBridgeIds.length + 1}`,
        managementStatus: enrolled ? "ok" : "pending_enrollment",
        ...(enrolled
          ? {
              managementApiUrl: options.apiUrl ?? agentUrl,
              managementCredentialCiphertext: credential.ciphertext,
              managementCredentialNonce: credential.nonce,
              managementCredentialAuthTag: credential.authTag,
              managementCredentialKeyVersion: credential.keyVersion,
              managementEnrolledAt: new Date(Date.now() - 60_000),
            }
          : {}),
      })
      .returning();
    if (!bridge) throw new Error("Failed to seed bridge");
    createdBridgeIds.push(bridge.id);
    agent.bridgeId = bridge.id;
    return bridge;
  };

  const seedRoute = async (
    bridgeId: string,
    nodeId: string,
    port: number,
    extra: Partial<typeof vpnBridgeRoutes.$inferInsert> = {},
  ) => {
    const id = randomUUID();
    await db()
      .insert(vpnBridgeRoutes)
      .values({
        id,
        nodeId,
        bridgeId,
        publicUdpPort: port,
        state: "draft",
        frpProxyName: bridgeFrpProxyName(id),
        ...extra,
      });
    return id;
  };

  const route = async (id: string) => {
    const [row] = await db().select().from(vpnBridgeRoutes).where(eq(vpnBridgeRoutes.id, id));
    if (!row) throw new Error("route missing");
    return row;
  };
  const bridgeRow = async (id: string) => {
    const [row] = await db().select().from(vpnBridges).where(eq(vpnBridges.id, id));
    if (!row) throw new Error("bridge missing");
    return row;
  };

  const poll = (options: { now?: Date; timeoutMs?: number; hosts?: string[] } = {}) =>
    createBridgeAgentPoll({
      repository: pollRepository,
      jobs: workerRepository,
      jobsEnabled: true,
      managementHosts: options.hosts ?? ["127.0.0.1"],
      timeoutMs: options.timeoutMs ?? 2_000,
      now: () => options.now ?? new Date(),
    });

  /** Arm the bridge's poll row and run it through the real handler. */
  const runPoll = async (bridgeId: string, options: Parameters<typeof poll>[0] = {}) => {
    await createBridgePollArmer({ repository: pollRepository, jobsEnabled: true })();
    const [job] = await db()
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, bridgeAgentPollDeduplicationKey(bridgeId)));
    if (!job) throw new Error("poll job was not armed");
    await poll(options)({ id: job.id, type: job.type, attempts: job.attempts, payload: job.payload });
    const [after] = await db().select().from(jobOutbox).where(eq(jobOutbox.id, job.id));
    return after;
  };

  runDatabaseTest("arms one row per enrolled bridge, only while the gate is open", async () => {
    const enrolled = await seedBridge();
    const pending = await seedBridge({ enrolled: false });
    const keys = [enrolled.id, pending.id].map((id) => bridgeAgentPollDeduplicationKey(id));
    const rows = () =>
      db().select().from(jobOutbox).where(inArray(jobOutbox.deduplicationKey, keys));

    const lines: string[] = [];
    const closed = createBridgePollArmer({
      repository: pollRepository,
      jobsEnabled: false,
      log: (line) => lines.push(line),
    });
    await closed();
    await closed();
    expect(await rows()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/BRIDGE_JOBS_DISABLED/);

    const open = createBridgePollArmer({ repository: pollRepository, jobsEnabled: true });
    await open();
    await open();
    const armed = await rows();
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({
      type: BRIDGE_AGENT_POLL_JOB_TYPE,
      status: "pending",
      payload: { bridgeId: enrolled.id },
    });

    // A completed row is re-armed in place, never duplicated.
    await workerRepository.completeJob(armed[0]!.id);
    await open();
    const rearmed = await rows();
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]).toMatchObject({ id: armed[0]!.id, status: "pending", attempts: 0 });
  });

  runDatabaseTest(
    "a successful poll stamps the bridge and every route with one poll time, matching name and port",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge();
      const online = await seedRoute(bridge.id, node.id, 41000);
      const node2 = await seedNode();
      const absent = await seedRoute(bridge.id, node2.id, 41001, {
        observedOnline: true,
        observedRegistrationMarker: M1,
        observedAt: new Date(Date.now() - 120_000),
      });
      const node3 = await seedNode();
      const wrongPort = await seedRoute(bridge.id, node3.id, 41002);
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(online), remotePort: 41000, online: true, registrationMarker: M1 },
        // Its proxy name on another public port: not this route's registration.
        { proxyId: bridgeFrpProxyName(wrongPort), remotePort: 41009, online: true, registrationMarker: M2 },
        // Foreign registrations are ignored.
        { proxyId: "someone-else", remotePort: 41003, online: true, registrationMarker: M2 },
      ];
      const pollTime = new Date(Date.now() - 1_000);

      const job = await runPoll(bridge.id, { now: pollTime });

      expect(job?.status).toBe("completed");
      const stored = await bridgeRow(bridge.id);
      expect(stored).toMatchObject({
        managementStatus: "ok",
        agentVersion: "0.1.0",
        agentApiVersion: 1,
        frpsVersion: "0.72.0",
        frpsReachable: true,
        lastErrorCode: "ROUTE_PORT_MISMATCH",
      });
      expect(stored.lastObservedAt?.getTime()).toBe(pollTime.getTime());
      expect(stored.lastPollAttemptAt?.getTime()).toBe(pollTime.getTime());
      expect(await route(online)).toMatchObject({
        observedOnline: true,
        observedRegistrationMarker: M1,
      });
      expect(await route(absent)).toMatchObject({
        observedOnline: false,
        observedRegistrationMarker: null,
      });
      expect(await route(wrongPort)).toMatchObject({
        observedOnline: false,
        observedRegistrationMarker: null,
      });
      for (const id of [online, absent, wrongPort]) {
        expect((await route(id)).observedAt?.getTime()).toBe(pollTime.getTime());
      }

      // An offline registration keeps no marker and is not online.
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(online), remotePort: null, online: false, registrationMarker: M1 },
      ];
      await runPoll(bridge.id);
      expect(await route(online)).toMatchObject({
        observedOnline: false,
        observedRegistrationMarker: null,
      });
      expect((await bridgeRow(bridge.id)).lastErrorCode).toBeNull();
    },
  );

  runDatabaseTest(
    "a changed marker clears a verification bound to another marker and keeps one bound to it",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge();
      const verification = {
        verificationMethod: "operator" as const,
        verifiedAt: new Date(),
        verificationResult: "success" as const,
      };
      const reconnected = await seedRoute(bridge.id, node.id, 41000, {
        observedOnline: true,
        observedRegistrationMarker: M1,
        observedAt: new Date(Date.now() - 60_000),
        verifiedRegistrationMarker: M1,
        ...verification,
      });
      // An operator verification recorded before any observation (3c).
      const node2 = await seedNode();
      const preObserved = await seedRoute(bridge.id, node2.id, 41001, {
        verifiedRegistrationMarker: M2,
        ...verification,
      });
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(reconnected), remotePort: 41000, online: true, registrationMarker: M2 },
        { proxyId: bridgeFrpProxyName(preObserved), remotePort: 41001, online: true, registrationMarker: M2 },
      ];

      await runPoll(bridge.id);

      expect(await route(reconnected)).toMatchObject({
        observedRegistrationMarker: M2,
        verificationMethod: null,
        verifiedRegistrationMarker: null,
        verifiedAt: null,
        verificationResult: null,
        verificationError: null,
      });
      expect(await route(preObserved)).toMatchObject({
        observedRegistrationMarker: M2,
        verificationMethod: "operator",
        verifiedRegistrationMarker: M2,
        verificationResult: "success",
      });
    },
  );

  runDatabaseTest(
    "down, timeout, mismatched and unsupported agents change the bridge status only",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge();
      const active = await seedRoute(bridge.id, node.id, 41000, {
        state: "active",
        activatedAt: new Date(),
      });
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(active), remotePort: 41000, online: true, registrationMarker: M1 },
      ];
      await runPoll(bridge.id);
      const observed = await bridgeRow(bridge.id);
      const routeBefore = await route(active);
      expect(routeBefore).toMatchObject({ state: "active", observedOnline: true });

      // Every later read would report the route gone; none of them may say so.
      agent.proxies = [];
      const cases: Array<{
        setup: () => void;
        status: string;
        code: string;
        options?: Parameters<typeof poll>[0];
      }> = [
        { setup: () => (agent.bridgeId = randomUUID()), status: "identity_mismatch", code: "AGENT_IDENTITY_MISMATCH" },
        { setup: () => (agent.apiVersion = 2), status: "unsupported", code: "AGENT_API_UNSUPPORTED" },
        { setup: () => (agent.mode = "hang"), status: "down", code: "AGENT_TIMEOUT", options: { timeoutMs: 200 } },
      ];
      for (const scenario of cases) {
        agent.bridgeId = bridge.id;
        agent.apiVersion = 1;
        agent.mode = "normal";
        scenario.setup();
        const attempt = new Date();
        const job = await runPoll(bridge.id, { ...scenario.options, now: attempt });
        expect(job?.status).toBe("completed");
        const stored = await bridgeRow(bridge.id);
        expect(stored.managementStatus).toBe(scenario.status);
        expect(stored.lastErrorCode).toBe(scenario.code);
        expect(stored.lastPollAttemptAt?.getTime()).toBe(attempt.getTime());
        expect(stored.lastObservedAt?.getTime()).toBe(observed.lastObservedAt?.getTime());
        expect(await route(active)).toEqual(routeBefore);
      }

      // The agent gone entirely.
      const closedServer = createServer();
      await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
      const deadUrl = `http://127.0.0.1:${(closedServer.address() as AddressInfo).port}`;
      await new Promise<void>((resolve) => closedServer.close(() => resolve()));
      await db().update(vpnBridges).set({ managementApiUrl: deadUrl }).where(eq(vpnBridges.id, bridge.id));
      await runPoll(bridge.id);
      expect(await bridgeRow(bridge.id)).toMatchObject({
        managementStatus: "down",
        lastErrorCode: "AGENT_UNREACHABLE",
      });
      expect(await route(active)).toEqual(routeBefore);
    },
  );

  runDatabaseTest("a rejected credential reads as down", async () => {
    const bridge = await seedBridge();
    const wrong = encryptSecret("w".repeat(40), keyring, 1);
    await db()
      .update(vpnBridges)
      .set({
        managementCredentialCiphertext: wrong.ciphertext,
        managementCredentialNonce: wrong.nonce,
        managementCredentialAuthTag: wrong.authTag,
      })
      .where(eq(vpnBridges.id, bridge.id));
    await runPoll(bridge.id);
    expect(await bridgeRow(bridge.id)).toMatchObject({
      managementStatus: "down",
      lastErrorCode: "AGENT_UNAUTHORIZED",
    });
  });

  runDatabaseTest(
    "an unreachable frps advances the bridge observation but leaves every route as it was",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge();
      const id = await seedRoute(bridge.id, node.id, 41000);
      agent.proxies = [
        { proxyId: bridgeFrpProxyName(id), remotePort: 41000, online: true, registrationMarker: M1 },
      ];
      await runPoll(bridge.id, { now: new Date(Date.now() - 5_000) });
      const before = await route(id);

      agent.frpsReachable = false;
      const later = new Date();
      await runPoll(bridge.id, { now: later });

      const stored = await bridgeRow(bridge.id);
      expect(stored).toMatchObject({
        managementStatus: "ok",
        frpsReachable: false,
        frpsVersion: null,
        lastErrorCode: "FRPS_UNREACHABLE",
      });
      expect(stored.lastObservedAt?.getTime()).toBe(later.getTime());
      const after = await route(id);
      expect(after).toEqual(before);
      // The route is no longer covered by the bridge's latest poll: Unknown.
      expect(after.observedAt!.getTime()).toBeLessThan(stored.lastObservedAt!.getTime());
    },
  );

  runDatabaseTest(
    "a poll of a superseded credential or an older poll is discarded",
    async () => {
      const node = await seedNode();
      const bridge = await seedBridge();
      const id = await seedRoute(bridge.id, node.id, 41000);
      const enrolledAt = bridge.managementEnrolledAt!;
      const outcome = {
        kind: "ok" as const,
        agentVersion: "0.1.0",
        agentApiVersion: 1,
        frpsReachable: true,
        frpsVersion: "0.72.0",
        proxies: [
          { proxyId: bridgeFrpProxyName(id), remotePort: 41000, online: true, registrationMarker: M1 },
        ],
        errorCode: null,
      };
      const newer = new Date();
      expect(
        await pollRepository.recordPoll({ bridgeId: bridge.id, enrolledAt, startedAt: newer, outcome }),
      ).toBe("written");
      expect(
        await pollRepository.recordPoll({
          bridgeId: bridge.id,
          enrolledAt,
          startedAt: new Date(newer.getTime() - 10_000),
          outcome: { kind: "down", errorCode: "AGENT_TIMEOUT" },
        }),
      ).toBe("discarded");
      expect(
        await pollRepository.recordPoll({
          bridgeId: bridge.id,
          enrolledAt: new Date(enrolledAt.getTime() - 1),
          startedAt: new Date(newer.getTime() + 1_000),
          outcome: { kind: "down", errorCode: "AGENT_TIMEOUT" },
        }),
      ).toBe("discarded");
      expect((await bridgeRow(bridge.id)).managementStatus).toBe("ok");
      expect((await route(id)).observedOnline).toBe(true);
    },
  );

  runDatabaseTest(
    "a stored URL that is no longer an allowed destination is never contacted",
    async () => {
      const bridge = await seedBridge();
      await runPoll(bridge.id, { hosts: ["host.docker.internal"] });
      expect(agent.requests).toBe(0);
      expect(await bridgeRow(bridge.id)).toMatchObject({
        managementStatus: "down",
        lastErrorCode: "AGENT_URL_NOT_ALLOWED",
      });
    },
  );

  runDatabaseTest("a deleted bridge's or a closed gate's job completes without a request", async () => {
    const bridge = await seedBridge();
    await createBridgePollArmer({ repository: pollRepository, jobsEnabled: true })();
    const [job] = await db()
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, bridgeAgentPollDeduplicationKey(bridge.id)));
    if (!job) throw new Error("not armed");
    const asJob = { id: job.id, type: job.type, attempts: job.attempts, payload: job.payload };

    await createBridgeAgentPoll({
      repository: pollRepository,
      jobs: workerRepository,
      jobsEnabled: false,
      managementHosts: ["127.0.0.1"],
    })(asJob);
    expect(agent.requests).toBe(0);
    expect((await db().select().from(jobOutbox).where(eq(jobOutbox.id, job.id)))[0]?.status).toBe(
      "completed",
    );

    await db().delete(vpnBridges).where(eq(vpnBridges.id, bridge.id));
    await poll()(asJob);
    expect(agent.requests).toBe(0);
  });

  runDatabaseTest(
    "bridges never enter telemetry, peer reconciliation or service-key provisioning",
    async () => {
      const node = await seedNode();
      await db().update(nodes).set({ reachabilityEnabled: true }).where(eq(nodes.id, node.id));
      const bridge = await seedBridge();
      await seedRoute(bridge.id, node.id, 41000, { state: "active", activatedAt: new Date() });

      // Everything runs inside a transaction that is rolled back, so it leaves
      // no keys, jobs or audit rows behind. Other suites may leave nodes
      // (sealed with other keyrings) behind; inside it only ours takes part.
      const rolledBack = new Error("rollback");
      await db()
        .transaction(async (tx) => {
          await tx
            .update(nodes)
            .set({ enabled: false, reachabilityEnabled: false })
            .where(ne(nodes.id, node.id));
          const scoped = new PostgresWorkerRepository({
            db: tx as unknown as Database,
            keyring,
            activeKeyVersion: 1,
          });
          const telemetry = await scoped.listTelemetryNodes();
          expect(telemetry.map((item) => item.id)).toEqual([node.id]);
          expect(await scoped.loadNodeReconcileContext(bridge.id)).toBeNull();

          const reachability = new PostgresReachabilityRepository({
            db: tx as unknown as Database,
            keyring,
          });
          const result = await reachability.syncServiceKeys(new Date());
          expect(result.created).toBeGreaterThan(0);
          const keys = await tx
            .select({ nodeId: vpnKeys.nodeId })
            .from(vpnKeys)
            .innerJoin(users, eq(users.id, vpnKeys.ownerId))
            .where(eq(users.email, SERVICE_ACCOUNT_EMAIL));
          expect(keys.some((key) => key.nodeId === node.id)).toBe(true);
          expect(keys.some((key) => key.nodeId === bridge.id)).toBe(false);
          throw rolledBack;
        })
        .catch((error: unknown) => {
          if (error !== rolledBack) throw error;
        });
    },
  );
});
