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
  post: "accept" | "conflict" | "drop";
  /** The whole agent is down (connections dropped). */
  offline: boolean;
  /** Reported state per operation id (set by POST, driven by the test). */
  ops: Map<string, BridgeAgentUpdateAgentState>;
  errorCodes: Map<string, string>;
  /** Answer GET /v1/update for another operation id. */
  answerForOther: boolean;
  posts: Array<{ operationId: string; imageRepository: string; imageDigest: string }>;
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
    state: agent.ops.get(operationId),
    updatedAt: new Date().toISOString(),
    ...(agent.errorCodes.has(operationId) ? { errorCode: agent.errorCodes.get(operationId) } : {}),
  });

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
          if (!known) agent.ops.set(body.operationId, "queued");
          json(res, known ? 200 : 202, updateStatus(body.operationId));
        });
        return;
      }
      if (url.pathname === "/v1/update" && req.method === "GET") {
        const operationId = url.searchParams.get("operationId") ?? "";
        if (!agent.ops.has(operationId)) json(res, 404, { error: { code: "NOT_FOUND" } });
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
    options: { requestedAt?: Date; state?: typeof vpnBridgeAgentUpdates.$inferInsert.state } = {},
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
        { operationId, imageRepository: REPOSITORY, imageDigest: DIGEST },
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
      state: "unsupported",
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
    "an unreachable agent is retried with the same operation id, then surfaced as pickup_timeout, never retried again",
    async () => {
      const bridge = await seedBridge();
      agent.post = "drop";
      const requestedAt = new Date("2026-11-13T10:00:00.000Z");
      const { operationId, job } = await queueOperation(bridge.id, { requestedAt });

      // Inside the window: the job throws so the runner retries it; the
      // operation stays queued with the observed code.
      await expect(
        sendJob({ now: new Date(requestedAt.getTime() + 10_000) })(job),
      ).rejects.toThrow(/not delivered/);
      expect(await operation(operationId)).toMatchObject({
        state: "queued",
        errorCode: "AGENT_UNREACHABLE",
      });

      // Past the window: no more retries, the request is surfaced.
      await sendJob({
        now: new Date(requestedAt.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 1),
      })(job);
      expect(await operation(operationId)).toMatchObject({
        state: "pickup_timeout",
        errorCode: "UPDATE_NOT_ACKNOWLEDGED",
      });
      expect(await jobStatus(job.id)).toBe("completed");
      agent.post = "accept";
      await sendJob()(job);
      expect(agent.posts).toHaveLength(0);
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
    "a request the host never picked up becomes pickup_timeout (and is not retried); a late pickup still shows",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      const sentAt = new Date("2026-11-13T10:00:00.000Z");
      await sendJob({ now: sentAt })(job);

      // Inside the deadline the agent still says queued: nothing changes.
      await pollOnce(bridge.id, { now: new Date(sentAt.getTime() + 60_000) });
      expect((await operation(operationId)).state).toBe("sent");

      const late = new Date(sentAt.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 1_000);
      await pollOnce(bridge.id, { now: late });
      const timedOut = await operation(operationId);
      expect(timedOut).toMatchObject({
        state: "pickup_timeout",
        errorCode: "UPDATE_NOT_ACKNOWLEDGED",
      });
      expect(timedOut.finishedAt).not.toBeNull();
      // Polling again never sends the intent again.
      await pollOnce(bridge.id, { now: new Date(late.getTime() + 60_000) });
      expect(agent.posts).toHaveLength(1);
      expect((await operation(operationId)).state).toBe("pickup_timeout");

      // The host did start after all: the confirmed state is taken over.
      agent.ops.set(operationId, "staging");
      await pollOnce(bridge.id, { now: new Date(late.getTime() + 120_000) });
      const resumed = await operation(operationId);
      expect(resumed).toMatchObject({ state: "running", errorCode: null, finishedAt: null });
      expect(resumed.acknowledgedAt).not.toBeNull();
    },
  );

  runDatabaseTest(
    "lost contact before any pickup is a pickup_timeout after the deadline, not contact_lost",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      const sentAt = new Date("2026-11-13T10:00:00.000Z");
      await sendJob({ now: sentAt })(job);
      agent.offline = true;
      await pollOnce(bridge.id, { now: new Date(sentAt.getTime() + 30_000) });
      const early = await operation(operationId);
      expect(early).toMatchObject({ state: "sent", errorCode: "AGENT_UNREACHABLE" });
      expect(early.contactLostSince).toBeNull();
      await pollOnce(bridge.id, {
        now: new Date(sentAt.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 1_000),
      });
      expect((await operation(operationId)).state).toBe("pickup_timeout");
    },
  );

  runDatabaseTest("an answer for another operation id is never trusted", async () => {
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
  });

  runDatabaseTest("every successful poll refreshes the stored agent capabilities", async () => {
    const bridge = await seedBridge(["status.v1"]);
    await pollOnce(bridge.id);
    const [row] = await db().select().from(vpnBridges).where(eq(vpnBridges.id, bridge.id));
    expect(row?.agentCapabilities).toEqual(["status.v1", "update.v1"]);
  });
  runDatabaseTest(
    "a queued operation whose delivery job is gone does not hold the slot past the deadline",
    async () => {
      const bridge = await seedBridge();
      const requestedAt = new Date("2026-11-13T10:00:00.000Z");
      const { operationId, job } = await queueOperation(bridge.id, { requestedAt });
      const late = new Date(requestedAt.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 1_000);

      // The job is still pending (its retry backoff): the send path owns it.
      await db().update(jobOutbox).set({ status: "pending" }).where(eq(jobOutbox.id, job.id));
      await pollOnce(bridge.id, { now: late });
      expect((await operation(operationId)).state).toBe("queued");

      // The job ended without moving the operation (failJob, a catch-all
      // completeJob of an older worker): nothing else would ever close it.
      await db().update(jobOutbox).set({ status: "failed" }).where(eq(jobOutbox.id, job.id));
      await pollOnce(bridge.id, { now: new Date(late.getTime() + 60_000) });
      expect(await operation(operationId)).toMatchObject({
        state: "pickup_timeout",
        errorCode: "UPDATE_NOT_ACKNOWLEDGED",
      });
    },
  );

  runDatabaseTest(
    "an agent that answers as unsupported still lets the acknowledgement deadline fire",
    async () => {
      const bridge = await seedBridge();
      const { operationId, job } = await queueOperation(bridge.id);
      const sentAt = new Date("2026-11-13T10:00:00.000Z");
      await sendJob({ now: sentAt })(job);
      // The status route answers for another bridge: identity mismatch.
      agent.bridgeId = randomUUID();
      await pollOnce(bridge.id, { now: new Date(sentAt.getTime() + 30_000) });
      expect(await operation(operationId)).toMatchObject({ state: "sent" });
      await pollOnce(bridge.id, {
        now: new Date(sentAt.getTime() + BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS + 1_000),
      });
      expect((await operation(operationId)).state).toBe("pickup_timeout");
    },
  );
});
