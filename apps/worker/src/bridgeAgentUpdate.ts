import {
  BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  BRIDGE_AGENT_UPDATE_CAPABILITY,
  BRIDGE_AGENT_UPDATE_ERRORS,
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
  type BridgeAgentUpdateRequest,
  type BridgeAgentUpdateSendOutcome,
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
 * stored intent to the agent's `POST /v1/update` once and ends; it never
 * waits for the host. The intent carries `notAfter`, the panel's pickup
 * deadline: the agent and host updater never start it afterwards. Replaying
 * the same operation id is harmless (at-most-once apply).
 *
 * The poller then follows the operation (`createBridgeUpdateTracker`):
 * `GET /v1/update?operationId=` moves it `sent -> acknowledged -> running ->
 * terminal`, and re-sends a delivery that got no usable answer.
 *
 * An operation holds the bridge's slot until a REACHABLE agent confirms it: a
 * terminal state, `expired` (-> `pickup_timeout`) or an unknown operation
 * (-> `failed UPDATE_UNKNOWN_TO_AGENT`). Unreachable agents only produce the
 * observation `contactLostSince`; a reachable agent that still says `queued`
 * past `notAfter` produces `acknowledgementOverdueSince`. Neither frees the
 * slot or retries anything: a host that may still apply the update must never
 * be raced by a second request.
 */

const knownError = (code: string): BridgeAgentUpdateError =>
  (BRIDGE_AGENT_UPDATE_ERRORS as readonly string[]).includes(code)
    ? (code as BridgeAgentUpdateError)
    : "AGENT_UNREACHABLE";

const finished = (
  state: BridgeAgentUpdateState,
  errorCode: string | null,
  at: Date,
): BridgeUpdateChange => ({ state, errorCode, finishedAt: at, lastCheckedAt: at });

const requestOf = (operation: BridgeUpdateOperation): BridgeAgentUpdateRequest => ({
  operationId: operation.id,
  imageRepository: operation.imageRepository,
  imageDigest: operation.imageDigest,
  notAfter: operation.notAfter.toISOString(),
});

/**
 * The transition a state the agent reported implies. Shared by the POST
 * answer and the GET answer. `pickup_timeout` only ever comes from the agent
 * confirming `expired`.
 */
const reportedChange = (
  operation: BridgeUpdateOperation,
  agentState: Parameters<typeof bridgeAgentUpdateStateOf>[0],
  errorCode: string | undefined,
  at: Date,
): BridgeUpdateChange => {
  const next = bridgeAgentUpdateStateOf(agentState);
  const started =
    bridgeAgentUpdateProgress(next) >= bridgeAgentUpdateProgress("acknowledged");
  const change: BridgeUpdateChange = {
    state: next,
    agentState,
    lastCheckedAt: at,
    contactLostSince: null,
    errorCode: errorCode ?? (next === "pickup_timeout" ? "UPDATE_NOT_ACKNOWLEDGED" : null),
    finishedAt: isBridgeAgentUpdateOutstanding(next) ? null : at,
    acknowledgementOverdueSince:
      next === "sent" && at.getTime() >= operation.notAfter.getTime()
        ? (operation.acknowledgementOverdueSince ?? at)
        : null,
  };
  if (bridgeAgentUpdateProgress(next) >= bridgeAgentUpdateProgress("sent") && !operation.sentAt) {
    change.sentAt = at;
  }
  if (started && !operation.acknowledgedAt) change.acknowledgedAt = at;
  return change;
};

/** The change one POST answer implies. Pure. */
export const deliveryChange = (
  operation: BridgeUpdateOperation,
  sent: BridgeAgentUpdateSendOutcome,
  at: Date,
): BridgeUpdateChange => {
  if (sent.kind === "accepted") {
    return {
      ...reportedChange(operation, sent.status.state, sent.status.errorCode, at),
      sendAttemptedAt: at,
    };
  }
  if (sent.kind === "rejected") {
    return { ...finished("failed", sent.errorCode, at), sendAttemptedAt: at };
  }
  // No usable answer: the agent may or may not have the intent. Stay
  // outstanding and let the tracker ask the agent; never time out here.
  return {
    sendAttemptedAt: at,
    lastCheckedAt: at,
    errorCode: sent.errorCode,
    contactLostSince: operation.contactLostSince ?? at,
  };
};

/**
 * The transition one GET answer implies, or null for none. Pure: every branch
 * of the state machine is unit-tested here. A `queued` operation whose agent
 * does not know it is re-sent by the tracker, not decided here.
 */
export const nextChange = (
  operation: BridgeUpdateOperation,
  read: BridgeAgentUpdateReadOutcome,
  at: Date,
): BridgeUpdateChange | null => {
  if (read.kind === "status") {
    // `expired` is only true of an intent the host never started.
    if (
      read.status.state === "expired" &&
      operation.state !== "queued" &&
      operation.state !== "sent"
    ) {
      return { errorCode: "AGENT_UNEXPECTED_STATE", lastCheckedAt: at, contactLostSince: null };
    }
    const next = bridgeAgentUpdateStateOf(read.status.state);
    // The agent never moves an operation back; a stale answer changes nothing
    // but proves contact.
    if (bridgeAgentUpdateProgress(next) < bridgeAgentUpdateProgress(operation.state)) {
      return { lastCheckedAt: at, contactLostSince: null };
    }
    return reportedChange(operation, read.status.state, read.status.errorCode, at);
  }
  if (read.kind === "unknown_operation") {
    return finished("failed", "UPDATE_UNKNOWN_TO_AGENT", at);
  }
  if (read.kind === "mismatch") {
    return { errorCode: "AGENT_OPERATION_MISMATCH", lastCheckedAt: at };
  }
  // No usable answer: an observation, never a verdict.
  return {
    errorCode: read.errorCode,
    lastCheckedAt: at,
    contactLostSince: operation.contactLostSince ?? at,
  };
};

export type BridgeAgentUpdateJobOptions = {
  repository: Pick<BridgeUpdateRepository, "loadOperation" | "recordChange">;
  targets: Pick<BridgePollRepository, "loadPollTarget">;
  jobs: Pick<WorkerRepository, "completeJob" | "failJob">;
  jobsEnabled: boolean;
  /** `VPN_BRIDGE_MANAGEMENT_HOSTS`. */
  managementHosts: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

/**
 * The `bridge_agent.update` job handler. An agent problem is never a job
 * failure: it is recorded on the operation. Before the POST is attempted the
 * operation can still be failed safely (nothing reached the agent); after it,
 * only the agent's answers decide.
 */
export const createBridgeAgentUpdate = ({
  repository,
  targets,
  jobs,
  jobsEnabled,
  managementHosts,
  fetchImpl,
  timeoutMs = BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  now = () => new Date(),
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
    // Nothing has been sent yet, so each of these ends the operation safely.
    const end = async (code: string): Promise<void> => {
      await repository.recordChange(operationId, finished("failed", code, at));
      await jobs.completeJob(job.id);
    };
    if (!bridgeJobsGate(jobsEnabled).ok) return end("BRIDGE_JOBS_DISABLED");
    // A first delivery past the pickup deadline is never sent: the agent would
    // only refuse it, and a stale intent must not reach a host at all.
    if (!operation.sendAttemptedAt && at.getTime() >= operation.notAfter.getTime()) {
      return end("UPDATE_NEVER_SENT");
    }
    const target = await targets.loadPollTarget(bridgeId);
    if (!target) return end("AGENT_CREDENTIAL_UNREADABLE");
    if (!isAllowedBridgeManagementUrl(target.apiUrl, managementHosts)) {
      return end("AGENT_URL_NOT_ALLOWED");
    }
    if (target.apiKey === null) return end("AGENT_CREDENTIAL_UNREADABLE");
    // Capabilities are refreshed by polls; an agent that does not report
    // `update.v1` is never sent an update intent.
    if (!target.capabilities?.includes(BRIDGE_AGENT_UPDATE_CAPABILITY)) {
      return end("AGENT_UPDATE_UNSUPPORTED");
    }
    // Committed before the POST: from here on only the agent can say whether
    // the intent arrived, so nothing may close the operation on its own.
    await repository.recordChange(operationId, { sendAttemptedAt: at });
    const sent = await sendBridgeAgentUpdate(requestOf(operation), {
      baseUrl: target.apiUrl,
      apiKey: target.apiKey,
      fetchImpl,
      timeoutMs,
    });
    await repository.recordChange(operationId, deliveryChange(operation, sent, at));
    await jobs.completeJob(job.id);
  };

export type BridgeUpdateTrackerOptions = {
  repository: Pick<
    BridgeUpdateRepository,
    "loadOutstanding" | "recordChange" | "expireNeverSent"
  >;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
 * read did not succeed (down, unsupported, wrong identity) is not asked
 * again: the answer is "no contact" (an observation), and such an agent is
 * never trusted with an operation.
 */
export const createBridgeUpdateTracker = ({
  repository,
  fetchImpl,
  timeoutMs = BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  now = () => new Date(),
  log = () => undefined,
}: BridgeUpdateTrackerOptions) =>
  async ({ target, outcome }: BridgeUpdateTrackerInput): Promise<void> => {
    // An operation whose delivery job is gone and whose POST never happened
    // would hold the slot forever; the agent never saw it, so it can close.
    await repository.expireNeverSent(target.bridgeId, now());
    const operation = await repository.loadOutstanding(target.bridgeId);
    // `queued` without an attempted POST belongs to the delivery job.
    if (!operation || (operation.state === "queued" && !operation.sendAttemptedAt)) return;
    const options =
      outcome.kind === "ok" && target.apiKey !== null
        ? { baseUrl: target.apiUrl, apiKey: target.apiKey, fetchImpl, timeoutMs }
        : null;
    let read: BridgeAgentUpdateReadOutcome;
    if (!options) {
      read = {
        kind: "no_contact",
        errorCode:
          outcome.kind === "ok" ? "AGENT_CREDENTIAL_UNREADABLE" : knownError(outcome.errorCode),
      };
    } else {
      read = await readBridgeAgentUpdate(operation.id, options);
    }
    const at = now();
    let change: BridgeUpdateChange | null;
    if (
      read.kind === "unknown_operation" &&
      operation.state === "queued" &&
      options &&
      at.getTime() < operation.notAfter.getTime()
    ) {
      // The earlier POST did not arrive and the intent is still in date: send
      // the same intent again. Past `notAfter` it is never re-sent; the agent
      // confirmed it does not know it, which ends it (nextChange).
      change = deliveryChange(operation, await sendBridgeAgentUpdate(requestOf(operation), options), at);
    } else {
      change = nextChange(operation, read, at);
    }
    if (!change) return;
    const applied = await repository.recordChange(operation.id, change);
    if (applied && change.state && change.state !== operation.state) {
      log(`bridge ${target.bridgeId}: update ${operation.id} is now ${change.state}`);
    }
  };
