import {
  BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  bridgeAgentPollPayloadSchema,
  isAllowedBridgeManagementUrl,
  readBridgeAgentIdentity,
  readBridgeAgentStatus,
  type BridgeAgentPollOutcome,
} from "@amnezia/contracts";
import type { BridgePollApplied, BridgePollWrite } from "@amnezia/db";

import { bridgeJobsGate } from "./config.js";
import type { OutboxJob, WorkerRepository } from "./repository.js";

/**
 * The bridge-agent poller: one `bridge_agent.poll` outbox row per enrolled
 * bridge, re-armed by a 60 s timer (`createBridgePollArmer`) and run by the
 * outbox runner (`createBridgeAgentPoll`). The runner executes one job at a
 * time, so polls are serialized among themselves and with the other jobs:
 * concurrency is bounded at one and every request has a short deadline.
 */

/** An enrolled bridge as one poll needs it. */
export type BridgePollTarget = {
  bridgeId: string;
  apiUrl: string;
  /** The decrypted credential; null when it cannot be decrypted. */
  apiKey: string | null;
  enrolledAt: Date;
  /** The capabilities the agent last reported; null when never read. */
  capabilities: readonly string[] | null;
};

export interface BridgePollRepository {
  /**
   * Arm the poll row of every enrolled bridge: a finished row is set
   * pending again, a pending or running one is left alone. Returns how many
   * bridges are enrolled.
   */
  armBridgePolls: () => Promise<number>;
  loadPollTarget: (bridgeId: string) => Promise<BridgePollTarget | null>;
  /** `applyBridgePollResult` in its own transaction. */
  recordPoll: (write: BridgePollWrite) => Promise<BridgePollApplied>;
  /** Store the capabilities of a fresh `/v1/identity` read. */
  recordCapabilities: (write: {
    bridgeId: string;
    enrolledAt: Date;
    capabilities: string[];
  }) => Promise<void>;
}

export type BridgePollArmerOptions = {
  repository: Pick<BridgePollRepository, "armBridgePolls">;
  /** `VPN_BRIDGE_JOBS_ENABLED`. */
  jobsEnabled: boolean;
  log?: (line: string) => void;
};

/**
 * The timer task. With the gate closed it queues nothing (ruling R6): a
 * pre-bridge worker in a mixed deployment could otherwise claim a poll job
 * and mark it complete without running it.
 */
export const createBridgePollArmer = ({
  repository,
  jobsEnabled,
  log = () => undefined,
}: BridgePollArmerOptions): (() => Promise<void>) => {
  let reportedClosed = false;
  return async () => {
    const gate = bridgeJobsGate(jobsEnabled);
    if (!gate.ok) {
      if (!reportedClosed) {
        log(`bridge-agent polls are not queued: ${gate.code} (VPN_BRIDGE_JOBS_ENABLED is not true)`);
        reportedClosed = true;
      }
      return;
    }
    await repository.armBridgePolls();
  };
};

export type BridgeAgentPollOptions = {
  repository: Pick<BridgePollRepository, "loadPollTarget" | "recordPoll" | "recordCapabilities">;
  jobs: Pick<WorkerRepository, "completeJob" | "failJob">;
  jobsEnabled: boolean;
  /** `VPN_BRIDGE_MANAGEMENT_HOSTS`. */
  managementHosts: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Follows the bridge's outstanding agent update after a stored poll
   * (bridgeAgentUpdate.ts). Absent on a worker without update tracking.
   */
  trackUpdate?: (input: { target: BridgePollTarget; outcome: BridgeAgentPollOutcome }) => Promise<void>;
};

/**
 * The `bridge_agent.poll` job handler. An agent problem is never a job
 * failure: it is classified, stored on the bridge and the job completes, so
 * the timer re-arms it. Only a storage error throws (runner retry).
 */
export const createBridgeAgentPoll = ({
  repository,
  jobs,
  jobsEnabled,
  managementHosts,
  fetchImpl,
  timeoutMs = BRIDGE_AGENT_REQUEST_TIMEOUT_MS,
  now = () => new Date(),
  log = () => undefined,
  trackUpdate,
}: BridgeAgentPollOptions) =>
  async (job: OutboxJob): Promise<void> => {
    const parsed = bridgeAgentPollPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      await jobs.failJob(job.id, "bridge_agent.poll job payload is malformed");
      return;
    }
    // Queued while the gate was open, picked up by a worker that has it
    // closed: nothing is contacted.
    if (!bridgeJobsGate(jobsEnabled).ok) {
      await jobs.completeJob(job.id);
      return;
    }
    const { bridgeId } = parsed.data;
    const target = await repository.loadPollTarget(bridgeId);
    // Deleted or not enrolled (any more): nothing to poll.
    if (!target) {
      await jobs.completeJob(job.id);
      return;
    }
    const startedAt = now();
    let outcome: BridgeAgentPollOutcome;
    if (!isAllowedBridgeManagementUrl(target.apiUrl, managementHosts)) {
      outcome = { kind: "down", errorCode: "AGENT_URL_NOT_ALLOWED" };
    } else if (target.apiKey === null) {
      outcome = { kind: "down", errorCode: "AGENT_CREDENTIAL_UNREADABLE" };
    } else {
      outcome = await readBridgeAgentStatus(bridgeId, {
        baseUrl: target.apiUrl,
        apiKey: target.apiKey,
        fetchImpl,
        timeoutMs,
      });
    }
    const applied = await repository.recordPoll({
      bridgeId,
      enrolledAt: target.enrolledAt,
      startedAt,
      outcome,
    });
    if (applied === "discarded") {
      log(`bridge ${bridgeId}: poll result discarded (re-enrolled or a newer poll was stored)`);
    } else {
      // Capabilities change when the agent is replaced (an update adds
      // `update.v1`), so they are re-read after every successful poll.
      if (outcome.kind === "ok" && target.apiKey !== null) {
        const identity = await readBridgeAgentIdentity(bridgeId, {
          baseUrl: target.apiUrl,
          apiKey: target.apiKey,
          fetchImpl,
          timeoutMs,
        });
        if (identity.kind === "ok") {
          await repository.recordCapabilities({
            bridgeId,
            enrolledAt: target.enrolledAt,
            capabilities: identity.identity.capabilities,
          });
        }
      }
      await trackUpdate?.({ target, outcome });
    }
    await jobs.completeJob(job.id);
  };
