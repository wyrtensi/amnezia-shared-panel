import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BRIDGE_AGENT_UPDATE_JOB_TYPE,
  BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS,
  bridgeAgentUpdateDeduplicationKey,
  type BridgeAgentUpdateAgentState,
} from "@amnezia/contracts";
import {
  createDatabase,
  encryptSecret,
  jobOutbox,
  vpnBridgeAgentUpdates,
  vpnBridges,
} from "@amnezia/db";

import { createBridgeAgentUpdate, createBridgeUpdateTracker } from "./bridgeAgentUpdate.js";
import { PostgresBridgePollRepository } from "./bridgePollRepository.js";
import { createBridgeAgentPoll } from "./bridgePoller.js";
import { PostgresBridgeUpdateRepository } from "./bridgeUpdateRepository.js";
import { PostgresWorkerRepository } from "./postgresRepository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runDatabaseTest = databaseUrl ? it : it.skip;

const TOKEN = "bridge-update-test-token-".padEnd(48, "x");
const REPOSITORY = "ghcr.io/example/amnezia/bridge-agent";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** A stand-in bridge-agent with the v1 identity, status and update routes. */
type FakeAgent = {
  bridgeId: string;
  capabilities: string[];
  /** What POST /v1/update does: accept, refuse with a status or drop the connection. */
  post: "accept" | "conflict" | "drop" | "store-then-drop";
  /** The whole agent is down (connections dropped). */
  offline: boolean;
  /** Reported state per operation id (set by POST, driven by the test). */
  ops: Map<string, BridgeAgentUpdateAgentState>;
  errorCodes: Map<string, string>;
  /** notAfter (epoch ms) the agent saw per operation. */
  notAfter: Map<string, number>;
  /** Answer GET /v1/update for another operation id. */
  answerForOther: boolean;
  posts: Array<{
    operationId: string;
    imageRepository: string;
    imageDigest: string;
    notAfter: string;
  }>;
};

describe("bridge-agent update (real PostgreSQL, fake bridge-agent over HTTP)", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const keyring = { 1: randomBytes(32) };
  const runTag = randomBytes(3).toString("hex");
  const createdBridgeIds: string[] = [];
  let server: Server;
  let agentUrl: string;
  const agent: FakeAgent = {
    bridgeId: "",
    capabilities: ["status.v1", "update.v1"],
    post: "accept",
    offline: false,
    ops: new Map(),
    errorCodes: new Map(),
    notAfter: new Map(),
    answerForOther: false,
    posts: [],
  };
  let workerRepository: PostgresWorkerRepository;
  let pollRepository: PostgresBridgePollRepository;
  let updateRepository: PostgresBridgeUpdateRepository;

  const db = () => {
    if (!database) throw new Error("No database");
    return database.db;
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const updateStatus = (operationId: string) => ({
    operationId: agent.answerForOther ? randomUUID() : operationId,
    state: stateOf(operationId),
    updatedAt: new Date().toISOString(),
    ...(agent.errorCodes.has(operationId) ? { errorCode: agent.errorCodes.get(operationId) } : {}),
  });

  /** The agent never starts an intent after its notAfter: it reads as expired. */
  const stateOf = (operationId: string): BridgeAgentUpdateAgentState | undefined => {
    const state = agent.ops.get(operationId);
    const notAfter = agent.notAfter.get(operationId);
    if (state === "queued" && notAfter !== undefined && Date.now() >= notAfter) {
      agent.ops.set(operationId, "expired");
      return "expired";
    }
    return state;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (agent.offline) {
        req.socket.destroy();
        return;
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        json(res, 401, { error: { code: "UNAUTHORIZED" } });
        return;
      }
      const url = new URL(req.url ?? "/", "http://agent");
      if (url.pathname === "/v1/identity") {
        json(res, 200, {
          bridgeId: agent.bridgeId,
          agentVersion: "0.1.0",
          apiVersion: 1,
          capabilities: agent.capabilities,
        });
        return;
      }
      if (url.pathname === "/v1/status") {
        json(res, 200, {
          bridgeId: agent.bridgeId,
          agentVersion: "0.1.0",
          apiVersion: 1,
          observedAt: new Date().toISOString(),
          frps: { reachable: true, version: "0.72.0" },
          applied: { controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
          proxies: [],
          errors: [],
        });
        return;
      }
      if (url.pathname === "/v1/update" && req.method === "POST") {
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        req.on("end", () => {
          if (agent.post === "drop") {
            req.socket.destroy();
            return;
          }
          const body = JSON.parse(raw) as FakeAgent["posts"][number];
          agent.posts.push(body);
          if (agent.post === "conflict") {
            json(res, 409, { error: { code: "OPERATION_CONFLICT" } });
            return;
          }
          const known = agent.ops.has(body.operationId);
          if (!known) {
            agent.ops.set(body.operationId, "queued");
            agent.notAfter.set(body.operationId, Date.parse(body.notAfter));
          }
          if (agent.post === "store-then-drop") {
            req.socket.destroy();
            return;
          }
          json(res, known ? 200 : 202, updateStatus(body.operationId));
        });
        return;
      }
      if (url.pathname === "/v1/update" && req.method === "GET") {
        const operationId = url.searchParams.get("operationId") ?? "";
        if (!agent.ops.has(operationId)) json(res, 404, { error: { code: "UNKNOWN_OPERATION" } });
        else json(res, 200, updateStatus(operationId));
        return;
      }
      json(res, 404, {});
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
    updateRepository = new PostgresBridgeUpdateRepository({ db: database.db });
  });

  afterEach(async () => {
    agent.capabilities = ["status.v1", "update.v1"];
    agent.post = "accept";
    agent.offline = false;
    agent.ops.clear();
    agent.errorCodes.clear();
    agent.notAfter.clear();
    agent.answerForOther = false;
    agent.posts.length = 0;
    if (!database) return;
    if (createdBridgeIds.length > 0) {
      const operations = await database.db
        .select({ id: vpnBridgeAgentUpdates.id })
        .from(vpnBridgeAgentUpdates)
        .where(inArray(vpnBridgeAgentUpdates.bridgeId, createdBridgeIds));
      if (operations.length > 0) {
        await database.db.delete(jobOutbox).where(
          inArray(
            jobOutbox.deduplicationKey,
            operations.map((operation) => bridgeAgentUpdateDeduplicationKey(operation.id)),
          ),
        );
      }
      await database.db.delete(vpnBridges).where(inArray(vpnBridges.id, createdBridgeIds));
    }
    createdBridgeIds.length = 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.client.end();
  });

  const seedBridge = async (capabilities: string[] = ["status.v1", "update.v1"]) => {
    const seed = parseInt(runTag, 16);
    const credential = encryptSecret(TOKEN, keyring, 1);
    const [bridge] = await db()
      .insert(vpnBridges)
      .values({
        name: `Update bridge ${runTag} ${createdBridgeIds.length}`,
        publicIpv4: `49.${(seed >> 8) & 0xff}.${seed & 0xff}.${createdBridgeIds.length + 1}`,
        managementStatus: "ok",
        managementApiUrl: agentUrl,
        managementCredentialCiphertext: credential.ciphertext,
        managementCredentialNonce: credential.nonce,
        managementCredentialAuthTag: credential.authTag,
        managementCredentialKeyVersion: credential.keyVersion,
        managementEnrolledAt: new Date(Date.now() - 60_000),
        agentVersion: "0.1.0",
        agentCapabilities: capabilities,
      })
      .returning();
    if (!bridge) throw new Error("Failed to seed bridge");
    createdBridgeIds.push(bridge.id);
    agent.bridgeId = bridge.id;
    return bridge;
  };

  /** A queued operation and its outbox row, as the Control API stores them. */
  const queueOperation = async (
    bridgeId: string,
    options: {
      requestedAt?: Date;
      notAfter?: Date;
      state?: typeof vpnBridgeAgentUpdates.$inferInsert.state;
    } = {},
  ) => {
    const operationId = randomUUID();
    await db()
      .insert(vpnBridgeAgentUpdates)
      .values({
        id: operationId,
        bridgeId,
        imageRepository: REPOSITORY,
        imageDigest: DIGEST,
        imageVersion: "0.2.0",
        fromVersion: "0.1.0",
        requestedAt: options.requestedAt ?? new Date(),
        notAfter:
          options.notAfter ?? new Date((options.requestedAt ?? new Date()).getTime() + 120_000),
        state: options.state ?? "queued",
      });
    const [job] = await db()
      .insert(jobOutbox)
      .values({
        type: BRIDGE_AGENT_UPDATE_JOB_TYPE,
        deduplicationKey: bridgeAgentUpdateDeduplicationKey(operationId),
        payload: { bridgeId, operationId },
        status: "processing",
      })
      .returning();
    if (!job) throw new Error("job insert failed");
    return { operationId, job: { id: job.id, type: job.type, attempts: 1, payload: job.payload } };
  };

  const operation = async (operationId: string) => {
    const [row] = await db()
      .select()
      .from(vpnBridgeAgentUpdates)
      .where(eq(vpnBridgeAgentUpdates.id, operationId));
    if (!row) throw new Error("operation missing");
    return row;
  };
  const jobStatus = async (jobId: string) => {
    const [row] = await db().select().from(jobOutbox).where(eq(jobOutbox.id, jobId));
    return row?.status;
  };

  const sendJob = (options: { now?: Date; jobsEnabled?: boolean; timeoutMs?: number } = {}) =>
    createBridgeAgentUpdate({
      repository: updateRepository,
      targets: pollRepository,
      jobs: workerRepository,
      jobsEnabled: options.jobsEnabled ?? true,
      managementHosts: ["127.0.0.1"],
      timeoutMs: options.timeoutMs ?? 2_000,
      now: () => options.now ?? new Date(),
    });

  /** One poll-job run for the bridge, with update tracking wired as in main.ts. */
  const pollOnce = async (bridgeId: string, options: { now?: Date } = {}) => {
    const now = () => options.now ?? new Date();
    const [job] = await db()
      .insert(jobOutbox)
      .values({
        type: "bridge_agent.poll",
        deduplicationKey: `bridge_agent.poll:${bridgeId}:${randomUUID()}`,
        payload: { bridgeId },
        status: "processing",
      })
      .returning();
    if (!job) throw new Error("poll job insert failed");
    try {
      await createBridgeAgentPoll({
        repository: pollRepository,
        jobs: workerRepository,
        jobsEnabled: true,
        managementHosts: ["127.0.0.1"],
        timeoutMs: 2_000,
        now,
        isUpdateOutstanding: async (id) => (await updateRepository.loadOutstanding(id)) !== null,
        trackUpdate: createBridgeUpdateTracker({
          repository: updateRepository,
          timeoutMs: 2_000,
          now,
        }),
      })({ id: job.id, type: job.type, attempts: 1, payload: job.payload });
    } finally {
      await db().delete(jobOutbox).where(eq(jobOutbox.id, job.id));
    }
  };

  runDatabaseTest(
    "delivers the stored intent once with the operation id, repository and digest, and a replay sends nothing",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      await sendJob()(job);
      expect(agent.posts).toEqual([
        {
          operationId,
          imageRepository: REPOSITORY,
          imageDigest: DIGEST,
          notAfter: (await operation(operationId)).notAfter.toISOString(),
        },
      ]);
      const sent = await operation(operationId);
      expect(sent).toMatchObject({ state: "sent", agentState: "queued", errorCode: null });
      expect(sent.sentAt).not.toBeNull();
      expect(sent.finishedAt).toBeNull();
      expect(await jobStatus(job.id)).toBe("completed");

      // The same job delivered again (a runner replay): known operation, no POST.
      await sendJob()(job);
      expect(agent.posts).toHaveLength(1);
    },
  );

  runDatabaseTest("refuses to send to an agent without the update.v1 capability", async () => {
    const bridge = await seedBridge(["status.v1"]);
    const { operationId, job } = await queueOperation(bridge.id);
    await sendJob()(job);
    expect(agent.posts).toHaveLength(0);
    expect(await operation(operationId)).toMatchObject({
      state: "failed",
      errorCode: "AGENT_UPDATE_UNSUPPORTED",
    });
    expect(await jobStatus(job.id)).toBe("completed");
  });

  runDatabaseTest("a closed gate fails the operation without contacting the agent", async () => {
    const bridge = await seedBridge();
    const { operationId, job } = await queueOperation(bridge.id);
    await sendJob({ jobsEnabled: false })(job);
    expect(agent.posts).toHaveLength(0);
    expect(await operation(operationId)).toMatchObject({
      state: "failed",
      errorCode: "BRIDGE_JOBS_DISABLED",
    });
  });

  runDatabaseTest("an agent that refuses the intent ends the operation as failed", async () => {
    const bridge = await seedBridge();
    agent.post = "conflict";
    const { operationId, job } = await queueOperation(bridge.id);
    await sendJob()(job);
    const row = await operation(operationId);
    expect(row).toMatchObject({ state: "failed", errorCode: "AGENT_UPDATE_CONFLICT" });
    expect(row.finishedAt).not.toBeNull();
  });

  runDatabaseTest(
    "an unreachable agent is never a verdict: the delivery stays queued, observed as lost contact, and is not timed out",
    async () => {
      const bridge = await seedBridge();
      agent.post = "drop";
      const requestedAt = new Date("2026-11-13T10:00:00.000Z");
      const { operationId, job } = await queueOperation(bridge.id, { requestedAt });
      await sendJob({ now: new Date(requestedAt.getTime() + 10_000) })(job);
      const first = await operation(operationId);
      expect(first).toMatchObject({ state: "queued", errorCode: "AGENT_UNREACHABLE" });
      expect(first.sendAttemptedAt).not.toBeNull();
      expect(first.contactLostSince).not.toBeNull();
      expect(first.finishedAt).toBeNull();
      expect(await jobStatus(job.id)).toBe("completed");

      // Far past notAfter and still no contact: still outstanding, never retried blindly.
      agent.offline = true;
      await pollOnce(bridge.id, { now: new Date(requestedAt.getTime() + 3_600_000) });
      const later = await operation(operationId);
      expect(later).toMatchObject({ state: "queued", finishedAt: null });
      expect(later.contactLostSince?.getTime()).toBe(first.contactLostSince?.getTime());
      // The dropped POST never reached the agent, and nothing was sent blindly.
      expect(agent.posts).toHaveLength(0);
    },
  );

  runDatabaseTest(
    "a POST the agent stored but never answered is recognized by the tracker; one it never saw is sent again",
    async () => {
      const stored = await seedBridge();
      agent.post = "store-then-drop";
      const a = await queueOperation(stored.id);
      await sendJob()(a.job);
      expect((await operation(a.operationId)).state).toBe("queued");
      agent.post = "accept";
      await pollOnce(stored.id, { now: new Date(Date.now() + 5_000) });
      // The agent has it (queued): the intent is not sent a second time.
      expect(await operation(a.operationId)).toMatchObject({ state: "sent", contactLostSince: null });
      expect(agent.posts).toHaveLength(1);

      const lost = await seedBridge();
      agent.post = "drop";
      const b = await queueOperation(lost.id);
      await sendJob()(b.job);
      agent.post = "accept";
      await pollOnce(lost.id, { now: new Date(Date.now() + 5_000) });
      // 404 from the agent: the earlier POST never arrived, so it is sent again.
      // The first POST was dropped before the agent saw it: now it arrives, once.
      expect(agent.posts.filter((post) => post.operationId === b.operationId)).toHaveLength(1);
      expect(await operation(b.operationId)).toMatchObject({ state: "sent", contactLostSince: null });
    },
  );

  runDatabaseTest(
    "polls follow an operation through acknowledged and running to a terminal result, with lost contact as an observation",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      await sendJob()(job);

      await pollOnce(bridge.id);
      expect((await operation(operationId)).state).toBe("sent");

      agent.ops.set(operationId, "picked_up");
      await pollOnce(bridge.id);
      const acknowledged = await operation(operationId);
      expect(acknowledged.state).toBe("acknowledged");
      expect(acknowledged.acknowledgedAt).not.toBeNull();

      agent.ops.set(operationId, "replacing");
      await pollOnce(bridge.id);
      expect((await operation(operationId)).state).toBe("running");

      // The agent is replaced: management is unreachable. Not terminal.
      agent.offline = true;
      const lostAt = new Date(Date.now() + 1_000);
      await pollOnce(bridge.id, { now: lostAt });
      const lost = await operation(operationId);
      expect(lost.state).toBe("running");
      expect(lost.contactLostSince?.getTime()).toBe(lostAt.getTime());
      expect(lost.finishedAt).toBeNull();

      // A second miss keeps the original observation time.
      await pollOnce(bridge.id, { now: new Date(lostAt.getTime() + 60_000) });
      expect((await operation(operationId)).contactLostSince?.getTime()).toBe(lostAt.getTime());

      // The host reports the matching terminal result once contact returns.
      agent.offline = false;
      agent.ops.set(operationId, "succeeded");
      await pollOnce(bridge.id, { now: new Date(lostAt.getTime() + 120_000) });
      const done = await operation(operationId);
      expect(done).toMatchObject({ state: "succeeded", contactLostSince: null, errorCode: null });
      expect(done.finishedAt).not.toBeNull();

      // A finished operation is never rewritten.
      agent.ops.set(operationId, "failed");
      await pollOnce(bridge.id, { now: new Date(lostAt.getTime() + 180_000) });
      expect((await operation(operationId)).state).toBe("succeeded");
    },
  );

  runDatabaseTest("every terminal host outcome is stored with its bounded code", async () => {
    for (const [state, code] of [
      ["rolled_back", "HEALTH_GATE_FAILED"],
      ["rollback_failed", "ROLLBACK_UNVERIFIED"],
      ["failed", "PULL_FAILED"],
    ] as const) {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      await sendJob()(job);
      agent.ops.set(operationId, state);
      agent.errorCodes.set(operationId, code);
      await pollOnce(bridge.id);
      const row = await operation(operationId);
      expect(row).toMatchObject({ state, errorCode: code, agentState: state });
      expect(row.finishedAt).not.toBeNull();
    }
  });

  runDatabaseTest(
    "a reachable agent that still says queued past notAfter keeps the slot and shows an overdue acknowledgement; only expired ends it",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      const t0 = new Date();
      await sendJob({ now: t0 })(job);
      const late = new Date(t0.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 10_000);

      await pollOnce(bridge.id, { now: late });
      const overdue = await operation(operationId);
      expect(overdue).toMatchObject({ state: "sent", finishedAt: null });
      expect(overdue.acknowledgementOverdueSince?.getTime()).toBe(late.getTime());
      // The slot is still held: a second outstanding operation is refused by PostgreSQL.
      await expect(
        db().insert(vpnBridgeAgentUpdates).values({
          id: randomUUID(),
          bridgeId: bridge.id,
          imageRepository: REPOSITORY,
          imageDigest: DIGEST,
          notAfter: new Date(Date.now() + 120_000),
        }),
      ).rejects.toThrow();
      // Nothing is sent again.
      expect(agent.posts).toHaveLength(1);

      // The agent confirms the intent expired unstarted: terminal, slot freed.
      agent.ops.set(operationId, "expired");
      await pollOnce(bridge.id, { now: new Date(late.getTime() + 60_000) });
      const done = await operation(operationId);
      expect(done).toMatchObject({
        state: "pickup_timeout",
        errorCode: "UPDATE_NOT_ACKNOWLEDGED",
        agentState: "expired",
        acknowledgementOverdueSince: null,
      });
      expect(done.finishedAt).not.toBeNull();
      await db().insert(vpnBridgeAgentUpdates).values({
        id: randomUUID(),
        bridgeId: bridge.id,
        imageRepository: REPOSITORY,
        imageDigest: DIGEST,
        notAfter: new Date(Date.now() + 120_000),
      });
    },
  );

  runDatabaseTest(
    "a fast pickup and replacement with the agent down across polls is lost contact, then the matching result",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      const t0 = new Date();
      await sendJob({ now: t0 })(job);
      // The host picked it up and replaced the agent between two polls: the
      // panel never saw picked_up, and the agent stays down past notAfter.
      agent.ops.set(operationId, "replacing");
      agent.offline = true;
      const down1 = new Date(t0.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 30_000);
      await pollOnce(bridge.id, { now: down1 });
      await pollOnce(bridge.id, { now: new Date(down1.getTime() + 600_000) });
      const lost = await operation(operationId);
      expect(lost).toMatchObject({ state: "sent", finishedAt: null, errorCode: "AGENT_UNREACHABLE" });
      expect(lost.contactLostSince?.getTime()).toBe(down1.getTime());

      agent.offline = false;
      agent.ops.set(operationId, "succeeded");
      await pollOnce(bridge.id, { now: new Date(down1.getTime() + 700_000) });
      const done = await operation(operationId);
      expect(done).toMatchObject({ state: "succeeded", contactLostSince: null, errorCode: null });
      expect(done.acknowledgedAt).not.toBeNull();
    },
  );

  runDatabaseTest("an agent that confirms it does not know the operation ends it, distinctly", async () => {
    const bridge = await seedBridge();
    const { operationId, job } = await queueOperation(bridge.id);
    await sendJob()(job);
    agent.ops.delete(operationId);
    await pollOnce(bridge.id, { now: new Date(Date.now() + 5_000) });
    expect(await operation(operationId)).toMatchObject({
      state: "failed",
      errorCode: "UPDATE_UNKNOWN_TO_AGENT",
    });
  });

  runDatabaseTest(
    "an answer for another operation id is never trusted",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      await sendJob()(job);
      agent.answerForOther = true;
      agent.ops.set(operationId, "succeeded");
      await pollOnce(bridge.id);
      expect(await operation(operationId)).toMatchObject({
        state: "sent",
        errorCode: "AGENT_OPERATION_MISMATCH",
      });
    },
  );

  runDatabaseTest(
    "a queued operation whose delivery job is gone is closed only if its POST was never attempted",
    async () => {
      const bridge = await seedBridge();
      const requestedAt = new Date("2026-11-13T10:00:00.000Z");
      const never = await queueOperation(bridge.id, { requestedAt });
      const late = new Date(requestedAt.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 1_000);

      // The job is still pending: the send path owns it.
      await db().update(jobOutbox).set({ status: "pending" }).where(eq(jobOutbox.id, never.job.id));
      await pollOnce(bridge.id, { now: late });
      expect((await operation(never.operationId)).state).toBe("queued");

      await db().update(jobOutbox).set({ status: "failed" }).where(eq(jobOutbox.id, never.job.id));
      await pollOnce(bridge.id, { now: new Date(late.getTime() + 60_000) });
      expect(await operation(never.operationId)).toMatchObject({
        state: "failed",
        errorCode: "UPDATE_NEVER_SENT",
      });
      expect(agent.posts).toHaveLength(0);

      // A POST was attempted (no answer): only the agent can say; never closed here.
      const other = await seedBridge();
      const attempted = await queueOperation(other.id, { requestedAt });
      await db()
        .update(vpnBridgeAgentUpdates)
        .set({ sendAttemptedAt: requestedAt })
        .where(eq(vpnBridgeAgentUpdates.id, attempted.operationId));
      await db().update(jobOutbox).set({ status: "failed" }).where(eq(jobOutbox.id, attempted.job.id));
      agent.offline = true;
      await pollOnce(other.id, { now: new Date(late.getTime() + 3_600_000) });
      expect((await operation(attempted.operationId)).state).toBe("queued");
    },
  );

  runDatabaseTest("a first delivery past notAfter is never sent", async () => {
    const bridge = await seedBridge();
    const requestedAt = new Date("2026-11-13T10:00:00.000Z");
    const { operationId, job } = await queueOperation(bridge.id, { requestedAt });
    // The job ran late (a backed-up lane): its clock is past the deadline.
    await sendJob({ now: new Date(requestedAt.getTime() + 121_000) })(job);
    expect(agent.posts).toHaveLength(0);
    const row = await operation(operationId);
    expect(row).toMatchObject({ state: "failed", errorCode: "UPDATE_NEVER_SENT", sendAttemptedAt: null });
    expect(await jobStatus(job.id)).toBe("completed");
  });

  runDatabaseTest("the attempt is committed before the POST goes out", async () => {
    const bridge = await seedBridge();
    const { operationId, job } = await queueOperation(bridge.id);
    let seenDuringPost: Date | null | undefined;
    const fetchImpl: typeof fetch = async () => {
      seenDuringPost = (await operation(operationId)).sendAttemptedAt;
      throw new Error("network down");
    };
    await createBridgeAgentUpdate({
      repository: updateRepository,
      targets: pollRepository,
      jobs: workerRepository,
      jobsEnabled: true,
      managementHosts: ["127.0.0.1"],
      fetchImpl,
    })(job);
    expect(seenDuringPost).toBeInstanceOf(Date);
    expect(await operation(operationId)).toMatchObject({ state: "queued", errorCode: "AGENT_UNREACHABLE" });
  });

  runDatabaseTest("a POST that reaches the agent after notAfter is refused as expired, which frees the slot", async () => {
    const bridge = await seedBridge();
    const notAfter = new Date(Date.now() + 300);
    const { operationId, job } = await queueOperation(bridge.id, { notAfter });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The job's own clock is early, the agent's is not.
    await sendJob({ now: new Date(notAfter.getTime() - 100) })(job);
    expect(agent.posts).toHaveLength(1);
    expect(await operation(operationId)).toMatchObject({
      state: "pickup_timeout",
      agentState: "expired",
      errorCode: "UPDATE_NOT_ACKNOWLEDGED",
    });
  });

  runDatabaseTest("a 404 past notAfter is not answered with a re-send", async () => {
    const bridge = await seedBridge();
    const requestedAt = new Date("2026-11-13T10:00:00.000Z");
    const { operationId } = await queueOperation(bridge.id, { requestedAt });
    await db()
      .update(vpnBridgeAgentUpdates)
      .set({ sendAttemptedAt: requestedAt })
      .where(eq(vpnBridgeAgentUpdates.id, operationId));
    // The agent never saw it; the poll runs after the deadline.
    await pollOnce(bridge.id, { now: new Date(requestedAt.getTime() + 300_000) });
    expect(agent.posts).toHaveLength(0);
    expect(await operation(operationId)).toMatchObject({
      state: "failed",
      errorCode: "UPDATE_UNKNOWN_TO_AGENT",
    });
  });

  runDatabaseTest("a poll re-reads capabilities when stale or while an update is outstanding, not otherwise", async () => {
    const bridge = await seedBridge(["status.v1"]);
    await pollOnce(bridge.id);
    const [row] = await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridge.id));
    expect(row?.agentCapabilities).toEqual(["status.v1", "update.v1"]);
    expect(row?.agentCapabilitiesCheckedAt).not.toBeNull();

    // Fresh and nothing outstanding: the agent's capability list is not asked again.
    await db()
      .update(vpnBridges)
      .set({ agentCapabilities: ["status.v1"], agentCapabilitiesCheckedAt: new Date() })
      .where(eq(vpnBridges.id, bridge.id));
    await pollOnce(bridge.id, { now: new Date(Date.now() + 5_000) });
    expect(
      (await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridge.id)))[0]?.agentCapabilities,
    ).toEqual(["status.v1"]);

    // An outstanding update forces the re-read.
    await queueOperation(bridge.id, { state: "sent" });
    await pollOnce(bridge.id, { now: new Date(Date.now() + 10_000) });
    expect(
      (await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridge.id)))[0]?.agentCapabilities,
    ).toEqual(["status.v1", "update.v1"]);
  });
});
