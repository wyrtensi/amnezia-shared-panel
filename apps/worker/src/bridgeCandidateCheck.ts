import { randomUUID } from "node:crypto";

import {
  bridgeRouteCandidateCheckPayloadSchema,
  probeSupportsBridgeMeasurement,
  type BridgeCandidateCheckError,
  type ProbeCapabilityInput,
  type ProbeRunRequest,
  type ProbeRunState,
} from "@amnezia/contracts";
import { inspectAwgVpnLink, renderAwgEndpointVpnLink } from "@amnezia/vpn-config";

import { bridgeJobsGate } from "./config.js";
import type { ProbeClient, ProbeClientOptions } from "./probeAgent.js";
import type { ProbeRow } from "./reachabilityTask.js";
import type { OutboxJob, WorkerRepository } from "./repository.js";

/**
 * Probe candidate checks of a bridge route (optional AWG 3.1 node bridges).
 *
 * The outbox job renders the node's AWG 3.1 service-key artifact with the
 * route's draft endpoint and starts a one-target run on the external probe.
 * It never waits for the run: the reachability tick, which already polls the
 * probe every minute, settles it (`candidateRunOutcome`) and writes the
 * result to the route only. Node status, reachability results and history,
 * Telegram alerts and the widget never see a candidate run.
 *
 * Serialization with regular runs: the probe runs one run at a time and the
 * regular run and the candidate both use the node's service peer. A candidate
 * claims `reachability_probe.candidate_run_id` only while `current_run_id`
 * and the candidate slot are both empty (so it never replaces a regular run
 * that is in flight or not yet ingested), and the regular tick starts nothing
 * while a candidate holds the probe.
 */

/** A candidate run holding the probe. */
export type CandidateRun = {
  runId: string;
  routeId: string;
  /** The observed registration marker the check was queued for. */
  registrationMarker: string;
  requestedAt: Date;
  startedAt: Date;
};

export type CandidateOutcome = {
  result: "success" | "failure";
  error: BridgeCandidateCheckError | null;
  /** When the check concluded; stored as the route's `verifiedAt`. */
  checkedAt: Date;
};

/** What the job needs to know about the route it checks. */
export type CandidateContext = {
  routeId: string;
  nodeId: string;
  state: "draft" | "active" | "retiring";
  retiringSince: Date | null;
  bridgePublicIpv4: string;
  publicUdpPort: number;
  /** The node's origin exit IP, compared with the observed egress when known. */
  nodePublicIp: string | null;
  /** The node's active AWG 3 service-key artifact, decrypted; null when none. */
  serviceConfig: string | null;
};

export type CandidateResultWrite = {
  routeId: string;
  registrationMarker: string;
  requestedAt: Date;
  outcome: CandidateOutcome;
};

export interface BridgeCandidateRepository {
  loadCandidateContext: (routeId: string) => Promise<CandidateContext | null>;
  /** Take the probe for a candidate run; false when any run holds it. */
  claimCandidateRun: (run: CandidateRun) => Promise<boolean>;
  /** Give the probe back after a run that did not start. */
  releaseCandidateRun: (runId: string) => Promise<void>;
  /**
   * Store a result on the route, only while the route is still a draft or
   * retiring and was not demoted after the check was requested (a demotion
   * clears verification, ruling R11, and a late result must not restore it).
   */
  recordCandidateResult: (write: CandidateResultWrite) => Promise<void>;
}

/** The probe's target id of a candidate run; never a node target id. */
export const candidateTargetId = (routeId: string): string => `bridge-route:${routeId}`;

/** A run the probe no longer reports is given up after this long. */
export const CANDIDATE_LOST_GRACE_MS = 2 * 60 * 1_000;
/** A one-target run that is still unfinished after this long is given up. */
export const CANDIDATE_RUN_TIMEOUT_MS = 15 * 60 * 1_000;
/** Same as the outbox runner's default: the last attempt records the failure. */
export const CANDIDATE_MAX_ATTEMPTS = 10;

/**
 * What the panel knows about the probe's capabilities. Nothing reports them
 * yet (Task 4a adds the probe's typed capability response), so this is
 * unknown, which `probeSupportsBridgeMeasurement` treats as unsupported.
 */
export const probeCapabilityInput = (_probe: ProbeRow): ProbeCapabilityInput => ({
  capabilities: null,
});

/**
 * The verdict of a finished candidate run. A bridged path is judged on the
 * real AWG handshake and HTTP through the tunnel; ping and TCP against the
 * bridge's UDP port say nothing about it. A failed control fetch means the
 * probe itself could not be trusted, which is not a pass either.
 */
export const classifyCandidateRun = (
  run: ProbeRunState,
  routeId: string,
  at: Date,
): CandidateOutcome => {
  const finished = run.finishedAt ? new Date(run.finishedAt) : at;
  const checkedAt = Number.isNaN(finished.getTime()) ? at : finished;
  const failure = (error: BridgeCandidateCheckError): CandidateOutcome => ({
    result: "failure",
    error,
    checkedAt,
  });
  if (run.control.ok !== true) return failure("PROBE_CONTROL_FAILED");
  const result = run.results.find((entry) => entry.targetId === candidateTargetId(routeId));
  if (!result || result.status !== "done") return failure("PROBE_TARGET_ERROR");
  if (result.levels.handshake.ok !== true) return failure("AWG_HANDSHAKE_FAILED");
  if (result.levels.http.ok !== true) return failure("HTTP_THROUGH_TUNNEL_FAILED");
  return { result: "success", error: null, checkedAt };
};

/**
 * What the reachability tick does with a candidate run holding the probe:
 * settle it with its verdict, give it up when lost or overdue, or keep
 * waiting (`null`).
 */
export const candidateRunOutcome = (
  run: CandidateRun,
  latest: ProbeRunState | null,
  at: Date,
): CandidateOutcome | null => {
  const age = at.getTime() - run.startedAt.getTime();
  if (latest && latest.runId === run.runId) {
    if (latest.finishedAt !== null) return classifyCandidateRun(latest, run.routeId, at);
    if (age > CANDIDATE_RUN_TIMEOUT_MS) {
      return { result: "failure", error: "PROBE_RUN_TIMEOUT", checkedAt: at };
    }
    return null;
  }
  // The probe keeps runs in memory, so a restart loses ours. A claim made a
  // moment ago by another worker may simply not have reached the probe yet.
  if (age > CANDIDATE_LOST_GRACE_MS) {
    return { result: "failure", error: "PROBE_RUN_LOST", checkedAt: at };
  }
  return null;
};

export type BridgeCandidateCheckOptions = {
  candidates: BridgeCandidateRepository;
  loadProbe: () => Promise<ProbeRow | null>;
  jobs: Pick<WorkerRepository, "completeJob" | "failJob">;
  createProbeClient: (options: ProbeClientOptions) => ProbeClient;
  /** `VPN_BRIDGE_JOBS_ENABLED` as this worker reads it. */
  jobsEnabled: boolean;
  /** Capability lookup; defaults to the shared one. Tests force it. */
  supportsBridgeMeasurement?: (probe: ProbeCapabilityInput) => boolean;
  now?: () => Date;
  newRunId?: () => string;
  maxAttempts?: number;
  log?: (line: string) => void;
};

/** The outbox handler of `bridge_route_candidate_check`. */
export const createBridgeCandidateCheck = ({
  candidates,
  loadProbe,
  jobs,
  createProbeClient,
  jobsEnabled,
  supportsBridgeMeasurement = probeSupportsBridgeMeasurement,
  now = () => new Date(),
  newRunId = randomUUID,
  maxAttempts = CANDIDATE_MAX_ATTEMPTS,
  log = () => undefined,
}: BridgeCandidateCheckOptions) => {
  return async (job: OutboxJob): Promise<void> => {
    const parsed = bridgeRouteCandidateCheckPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      // Retrying cannot fix a payload.
      await jobs.failJob(job.id, "bridge_route_candidate_check job payload is malformed");
      return;
    }
    const payload = parsed.data;
    const requestedAt = new Date(payload.requestedAt);
    const finish = async (error: BridgeCandidateCheckError) => {
      await candidates.recordCandidateResult({
        routeId: payload.routeId,
        registrationMarker: payload.registrationMarker,
        requestedAt,
        outcome: { result: "failure", error, checkedAt: now() },
      });
      log(`bridge candidate check ${payload.routeId}: ${error}`);
      await jobs.completeJob(job.id);
    };
    // The probe is taken: try again later, and record the reason on the
    // last attempt so the setup status shows why no result came.
    const busy = async (error: BridgeCandidateCheckError) => {
      if (job.attempts >= maxAttempts) {
        await finish(error);
        return;
      }
      throw new Error(`bridge candidate check: ${error}`);
    };

    const gate = bridgeJobsGate(jobsEnabled);
    if (!gate.ok) {
      await finish(gate.code);
      return;
    }
    const probe = await loadProbe();
    if (!probe || !probe.enabled) {
      await finish("PROBE_UNAVAILABLE");
      return;
    }
    if (!supportsBridgeMeasurement(probeCapabilityInput(probe))) {
      await finish("BRIDGE_UNSUPPORTED_CAPABILITY");
      return;
    }

    const context = await candidates.loadCandidateContext(payload.routeId);
    if (
      !context ||
      context.nodeId !== payload.nodeId ||
      context.state === "active" ||
      (context.retiringSince !== null && context.retiringSince > requestedAt)
    ) {
      // Released, activated or demoted since the check was queued: nothing
      // is left to verify for this request.
      log(`bridge candidate check ${payload.routeId}: route changed, skipped`);
      await jobs.completeJob(job.id);
      return;
    }
    if (context.serviceConfig === null) {
      await finish("SERVICE_KEY_UNAVAILABLE");
      return;
    }
    if (inspectAwgVpnLink(context.serviceConfig).kind !== "awg31") {
      await finish("SERVICE_KEY_NOT_AWG31");
      return;
    }
    let config: string;
    try {
      config = renderAwgEndpointVpnLink(context.serviceConfig, {
        host: context.bridgePublicIpv4,
        port: context.publicUdpPort,
      });
    } catch {
      await finish("SERVICE_KEY_NOT_AWG31");
      return;
    }

    if (probe.currentRunId !== null || probe.candidateRun !== null) {
      await busy("PROBE_BUSY");
      return;
    }
    const run: CandidateRun = {
      runId: newRunId(),
      routeId: payload.routeId,
      registrationMarker: payload.registrationMarker,
      requestedAt,
      startedAt: now(),
    };
    if (!(await candidates.claimCandidateRun(run))) {
      await busy("PROBE_BUSY");
      return;
    }
    const request: ProbeRunRequest = {
      runId: run.runId,
      control: { url: probe.controlUrl },
      egress: { url: probe.egressUrl },
      targets: [
        {
          targetId: candidateTargetId(payload.routeId),
          protocol: "awg3",
          // Grants VPN access: sent, never logged.
          config,
          ...(context.nodePublicIp ? { expectedEgressIp: context.nodePublicIp } : {}),
        },
      ],
    };
    const client = createProbeClient({ baseUrl: probe.apiBaseUrl, apiKey: probe.apiKey });
    let started: { runId: string } | "busy";
    try {
      started = await client.startRun(request);
    } catch {
      await candidates.releaseCandidateRun(run.runId);
      await busy("PROBE_START_FAILED");
      return;
    }
    if (started === "busy") {
      await candidates.releaseCandidateRun(run.runId);
      await busy("PROBE_BUSY");
      return;
    }
    log(`bridge candidate check ${payload.routeId}: started run ${run.runId}`);
    await jobs.completeJob(job.id);
  };
};
