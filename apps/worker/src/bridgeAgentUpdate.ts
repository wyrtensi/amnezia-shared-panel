import {
  BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  BRIDGE_AGENT_UPDATE_CAPABILITY,
  BRIDGE_AGENT_UPDATE_ERRORS,
  BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS,
  bridgeAgentUpdatePayloadSchema,
  bridgeAgentUpdateProgress,
  bridgeAgentUpdateStateOf,
  isAllowedBridgeManagementUrl,
  isBridgeAgentUpdateOutstanding,
  readBridgeAgentUpdate,
  sendBridgeAgentUpdate,
  type BridgeAgentPollOutcome,
  type BridgeAgentUpdateError,
  type BridgeAgentUpdateReadOutcome,
  type BridgeAgentUpdateState,
} from "@amnezia/contracts";

import { bridgeJobsGate } from "./config.js";
import type { BridgePollRepository, BridgePollTarget } from "./bridgePoller.js";
import type {
  BridgeUpdateChange,
  BridgeUpdateOperation,
  BridgeUpdateRepository,
} from "./bridgeUpdateRepository.js";
import type { OutboxJob, WorkerRepository } from "./repository.js";

/**
 * Bridge-agent updates in the worker, in two parts.
 *
 * The `bridge_agent.update` job (`createBridgeAgentUpdate`) delivers the
 * stored intent to the agent's `POST /v1/update` exactly as the stored
 * operation says and ends; it never waits for the host. Delivery is safe to
 * repeat because the agent answers a replayed operation id with its known
 * state (at-most-once apply).
 *
 * The poller then follows the operation (`createBridgeUpdateTracker`, called
 * by the bridge poll job): `GET /v1/update?operationId=` moves it
 * `sent -> acknowledged -> running -> terminal`. Management contact lost
 * after the host started is an observation (`contactLostSince`), not a
 * terminal state; only the host's matching terminal result ends it. A request
 * the host never picked up within `BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS`
 * becomes `pickup_timeout`: surfaced, never retried automatically.
 */

/** How long a `pickup_timeout` operation is still followed for a late pickup. */
export const BRIDGE_AGENT_UPDATE_LATE_WINDOW_MS = 24 * 60 * 60 * 1_000;

const knownError = (code: string): BridgeAgentUpdateError =>
  (BRIDGE_AGENT_UPDATE_ERRORS as readonly string[]).includes(code)
    ? (code as BridgeAgentUpdateError)
    : "AGENT_UNREACHABLE";

export type BridgeAgentUpdateJobOptions = {
  repository: Pick<BridgeUpdateRepository, "loadOperation" | "recordChange">;
  targets: Pick<BridgePollRepository, "loadPollTarget">;
  jobs: Pick<WorkerRepository, "completeJob" | "failJob">;
  jobsEnabled: boolean;
  /** `VPN_BRIDGE_MANAGEMENT_HOSTS`. */
  managementHosts: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pickupTimeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

const finished = (
  state: BridgeAgentUpdateState,
  errorCode: string | null,
  at: Date,
): BridgeUpdateChange => ({ state, errorCode, finishedAt: at, lastCheckedAt: at });

/**
 * The `bridge_agent.update` job handler. An agent problem is never a job
 * failure: it is recorded on the operation. Only an unreachable agent inside
 * the acknowledgement window throws, so the outbox runner retries the same
 * operation id with its own backoff.
 */
export const createBridgeAgentUpdate = ({
  repository,
  targets,
  jobs,
  jobsEnabled,
  managementHosts,
  fetchImpl,
  timeoutMs = BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  pickupTimeoutMs = BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS,
  now = () => new Date(),
  log = () => undefined,
}: BridgeAgentUpdateJobOptions) =>
  async (job: OutboxJob): Promise<void> => {
    const parsed = bridgeAgentUpdatePayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      await jobs.failJob(job.id, "bridge_agent.update job payload is malformed");
      return;
    }
    const { bridgeId, operationId } = parsed.data;
    const operation = await repository.loadOperation(operationId);
    // Deleted bridge, or a replay of an operation that was already delivered.
    if (!operation || operation.bridgeId !== bridgeId || operation.state !== "queued") {
      await jobs.completeJob(job.id);
      return;
    }
    const at = now();
    const end = async (state: BridgeAgentUpdateState, code: string): Promise<void> => {
      await repository.recordChange(operationId, finished(state, code, at));
      await jobs.completeJob(job.id);
    };
    // Queued while the gate was open, picked up by a worker that has it closed.
    if (!bridgeJobsGate(jobsEnabled).ok) {
      await end("failed", "BRIDGE_JOBS_DISABLED");
      return;
    }
    const target = await targets.loadPollTarget(bridgeId);
    if (!target) {
      await end("failed", "AGENT_CREDENTIAL_UNREADABLE");
      return;
    }
    if (!isAllowedBridgeManagementUrl(target.apiUrl, managementHosts)) {
      await end("failed", "AGENT_URL_NOT_ALLOWED");
      return;
    }
    if (target.apiKey === null) {
      await end("failed", "AGENT_CREDENTIAL_UNREADABLE");
      return;
    }
    // Capabilities are refreshed by every successful poll; an agent that does
    // not report `update.v1` is never sent an update intent.
    if (!target.capabilities?.includes(BRIDGE_AGENT_UPDATE_CAPABILITY)) {
      await end("unsupported", "AGENT_UPDATE_UNSUPPORTED");
      return;
    }
    const sent = await sendBridgeAgentUpdate(
      {
        operationId,
        imageRepository: operation.imageRepository,
        imageDigest: operation.imageDigest,
      },
      { baseUrl: target.apiUrl, apiKey: target.apiKey, fetchImpl, timeoutMs },
    );
    if (sent.kind === "accepted") {
      const next = bridgeAgentUpdateStateOf(sent.status.state);
      const change: BridgeUpdateChange = {
        state: next,
        agentState: sent.status.state,
        sentAt: at,
        lastCheckedAt: at,
        errorCode: sent.status.errorCode ?? null,
      };
      if (bridgeAgentUpdateProgress(next) >= bridgeAgentUpdateProgress("acknowledged")) {
        change.acknowledgedAt = at;
      }
      if (!isBridgeAgentUpdateOutstanding(next)) change.finishedAt = at;
      await repository.recordChange(operationId, change);
      await jobs.completeJob(job.id);
      return;
    }
    if (sent.kind === "rejected") {
      await end(sent.errorCode === "AGENT_UPDATE_UNSUPPORTED" ? "unsupported" : "failed", sent.errorCode);
      return;
    }
    // No usable answer. Within the window the same operation id is sent
    // again (a replay is harmless); past it the request counts as never
    // acknowledged and is surfaced, not retried.
    if (at.getTime() - operation.requestedAt.getTime() >= pickupTimeoutMs) {
      log(`bridge ${bridgeId}: update ${operationId} could not be delivered in time (${sent.errorCode})`);
      await end("pickup_timeout", "UPDATE_NOT_ACKNOWLEDGED");
      return;
    }
    await repository.recordChange(operationId, { errorCode: sent.errorCode, lastCheckedAt: at });
    throw new Error(`bridge-agent update not delivered: ${sent.errorCode}`);
  };

export type BridgeUpdateTrackerOptions = {
  repository: Pick<BridgeUpdateRepository, "loadTracked" | "recordChange">;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pickupTimeoutMs?: number;
  lateWindowMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

export type BridgeUpdateTrackerInput = {
  target: BridgePollTarget;
  /** The classified status read of the same poll. */
  outcome: BridgeAgentPollOutcome;
};

/**
 * Follow a bridge's outstanding update during its poll. A bridge whose status
 * read failed (`down`) is not asked again: the answer is "no contact". An
 * `unsupported` or mismatching agent is never trusted with an operation.
 */
export const createBridgeUpdateTracker = ({
  repository,
  fetchImpl,
  timeoutMs = BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  pickupTimeoutMs = BRIDGE_AGENT_UPDATE_PICKUP_TIMEOUT_MS,
  lateWindowMs = BRIDGE_AGENT_UPDATE_LATE_WINDOW_MS,
  now = () => new Date(),
  log = () => undefined,
}: BridgeUpdateTrackerOptions) =>
  async ({ target, outcome }: BridgeUpdateTrackerInput): Promise<void> => {
    if (outcome.kind !== "ok" && outcome.kind !== "down") return;
    const operation = await repository.loadTracked(target.bridgeId, now(), lateWindowMs);
    if (!operation) return;
    let read: BridgeAgentUpdateReadOutcome;
    if (outcome.kind === "down" || target.apiKey === null) {
      read = {
        kind: "no_contact",
        errorCode: outcome.kind === "down" ? knownError(outcome.errorCode) : "AGENT_CREDENTIAL_UNREADABLE",
      };
    } else {
      read = await readBridgeAgentUpdate(operation.id, {
        baseUrl: target.apiUrl,
        apiKey: target.apiKey,
        fetchImpl,
        timeoutMs,
      });
    }
    const checkedAt = now();
    const next = nextChange(operation, read, checkedAt, pickupTimeoutMs);
    if (!next) return;
    const applied = await repository.recordChange(operation.id, next, {
      fromPickupTimeout: operation.state === "pickup_timeout",
    });
    if (applied && next.state && next.state !== operation.state) {
      log(`bridge ${target.bridgeId}: update ${operation.id} is now ${next.state}`);
    }
  };

/**
 * The transition one read implies, or null for none. Pure: every branch of
 * the state machine is unit-tested here.
 */
export const nextChange = (
  operation: BridgeUpdateOperation,
  read: BridgeAgentUpdateReadOutcome,
  at: Date,
  pickupTimeoutMs: number,
): BridgeUpdateChange | null => {
  // Already timed out: only a later report that the host did start counts.
  const late = operation.state === "pickup_timeout";
  const unacknowledged = operation.state === "sent";
  const deadlinePassed =
    at.getTime() - (operation.sentAt ?? operation.requestedAt).getTime() >= pickupTimeoutMs;
  const timeout = (): BridgeUpdateChange =>
    finished("pickup_timeout", "UPDATE_NOT_ACKNOWLEDGED", at);

  if (read.kind === "status") {
    const next = bridgeAgentUpdateStateOf(read.status.state);
    const ahead = bridgeAgentUpdateProgress(next) >= bridgeAgentUpdateProgress("acknowledged");
    if (late) {
      if (!ahead) return null;
    } else if (bridgeAgentUpdateProgress(next) < bridgeAgentUpdateProgress(operation.state)) {
      // The agent never moves an operation back; a stale answer changes nothing.
      return { lastCheckedAt: at };
    } else if (next === "sent" && unacknowledged && deadlinePassed) {
      return timeout();
    }
    const change: BridgeUpdateChange = {
      state: next,
      agentState: read.status.state,
      lastCheckedAt: at,
      contactLostSince: null,
      errorCode: read.status.errorCode ?? null,
      finishedAt: isBridgeAgentUpdateOutstanding(next) ? null : at,
    };
    if (ahead && !operation.acknowledgedAt) change.acknowledgedAt = at;
    return change;
  }
  if (late) return null;
  if (unacknowledged && deadlinePassed) return timeout();
  if (read.kind === "mismatch") {
    return { errorCode: "AGENT_OPERATION_MISMATCH", lastCheckedAt: at };
  }
  if (read.kind === "unknown_operation") {
    return { errorCode: "AGENT_OPERATION_UNKNOWN", lastCheckedAt: at };
  }
  // No contact. Once the host has started, losing the agent is expected during
  // replacement: an observation that ends when the agent answers again.
  const started = operation.state === "acknowledged" || operation.state === "running";
  return {
    errorCode: read.errorCode,
    lastCheckedAt: at,
    ...(started ? { contactLostSince: operation.contactLostSince ?? at } : {}),
  };
};
