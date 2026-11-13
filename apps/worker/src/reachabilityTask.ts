import { randomUUID } from "node:crypto";

import {
  probeCapabilitiesDue,
  probeCapabilityInputOf,
  probeSupportsBridgeMeasurement,
  type ProbeRunRequest,
  type ProbeRunState,
} from "@amnezia/contracts";

import {
  candidateRunOutcome,
  candidateRunOverdue,
  type CandidateOutcome,
  type CandidateRun,
} from "./bridgeCandidateCheck.js";
import type { ProbeClient, ProbeClientOptions } from "./probeAgent.js";
import {
  ingestRun,
  measuredViaBridge,
  staleTransition,
  type NodeState,
  type Notice,
  type ProtocolOutcome,
  type ReachabilityTarget,
} from "./reachability.js";

/** The probe row with its API key decrypted. */
export type ProbeRow = {
  label: string;
  apiBaseUrl: string;
  apiKey: string;
  enabled: boolean;
  controlUrl: string;
  egressUrl: string;
  intervalSec: number;
  failThreshold: number;
  staleAfterSec: number;
  runRequestedAt: Date | null;
  currentRunId: string | null;
  /** When the newest run was started; kept after it is ingested. */
  currentRunStartedAt: Date | null;
  lastResultAt: Date | null;
  lastIngestedRunId: string | null;
  staleAlertedAt: Date | null;
  /** When monitoring (re)started; the stale clock never starts earlier. */
  enabledAt: Date;
  /** IANA zone for the times in alert texts. */
  timeZone: string;
  /**
   * The probe's stored capability list (`reachability_probe.capabilities`),
   * null when unknown. Read through `probeCapabilityInputOf`.
   */
  capabilities: unknown;
  /** When `capabilities` was read from the probe; null before the first read. */
  capabilitiesCheckedAt: Date | null;
  /** A bridge route candidate check holding the probe, if any. */
  candidateRun: CandidateRun | null;
};

/** A target as the panel knows it now, with its decrypted config when usable. */
export type RunTarget = ReachabilityTarget & {
  config: string | null;
  expectedEgressIp: string | null;
};

export type IngestRun = { runId: string; now: Date };

/** What an ingest classifies against, read under the node row locks. */
export type IngestContext = {
  /** The targets as they are now: endpoint revision and bridge route included. */
  targets: ReachabilityTarget[];
  previous: Map<string, NodeState>;
};

export type IngestWrite = {
  /** Obsolete outcomes (`ProtocolOutcome.obsolete`) are not stored. */
  outcomes: ProtocolOutcome[];
  states: Map<string, NodeState>;
  notices: Notice[];
  staleAlertedAt: Date | null;
  /** The run was a mass failure (shown on the status widget). */
  mass: boolean;
};

export type IngestDecide = (context: IngestContext) => IngestWrite | Promise<IngestWrite>;

/**
 * How a candidate settle ended: the result was stored on the route,
 * discarded (the route changed or was verified since the request), or the
 * slot had already been freed by another tick and nothing was written.
 */
export type CandidateSettle = "written" | "discarded" | "already-settled";

export interface ReachabilityRepository {
  loadProbe: () => Promise<ProbeRow | null>;
  /** Why the last contact with the probe failed. Never carries a secret. */
  recordProbeError: (message: string, at: Date) => Promise<void>;
  /**
   * Store the probe's capability names and when they were read. An empty list
   * is a legacy probe (no capability endpoint): it answered, and has none.
   */
  recordProbeCapabilities: (capabilities: string[], at: Date) => Promise<void>;
  /**
   * Ensure one live service key per (node, protocol) wanted; revoke the rest.
   * `provisioning` counts the wanted keys created moments ago and not ready.
   */
  syncServiceKeys: (
    now: Date,
  ) => Promise<{ created: number; revoked: number; provisioning: number }>;
  /**
   * The targets to dispatch. `bridgeMeasurement`: the probe can measure a
   * bridged path; without it a bridged AWG 3.1 target is not sent.
   */
  listTargets: (options: { bridgeMeasurement: boolean }) => Promise<RunTarget[]>;
  markRunStarted: (runId: string, at: Date) => Promise<void>;
  /** Forget a run the probe will never report, so a new one can start. */
  abandonRun: (at: Date, reason: string) => Promise<void>;
  /**
   * Claim the run, lock the probed node rows, read the current targets and
   * node states, classify with `decide`, and write results, history, node
   * states, outbox messages and the probe row, atomically. False when another
   * ingest claimed the run first (nothing written).
   */
  ingest: (run: IngestRun, decide: IngestDecide) => Promise<boolean>;
  setStaleAlert: (staleAlertedAt: Date | null, notices: Notice[]) => Promise<void>;
  /**
   * Free the probe from a candidate run and store its outcome on the route
   * only (see bridgeCandidateCheck.ts). Writes nothing to node status,
   * results, history or the outbox.
   */
  finishCandidateRun: (run: CandidateRun, outcome: CandidateOutcome) => Promise<CandidateSettle>;
}

/**
 * A run the probe still reports as ours and unfinished is only given up after
 * this long: a large fleet is slow, but a run that never ends must not block
 * the next one forever.
 */
export const ABANDON_RUN_MS = 6 * 60 * 60 * 1_000;

/**
 * After a failed capability check the probe is not asked again for this long:
 * a probe that hangs would otherwise cost the request timeout on every tick.
 * The stored record keeps aging meanwhile (bridged paths turn unknown).
 */
export const CAPABILITY_RETRY_BACKOFF_MS = 5 * 60 * 1_000;

const message = (error: unknown) =>
  (error instanceof Error ? error.message : "unknown error").slice(0, 300);

/**
 * One tick of the reachability task: ingest a finished run, keep the stale
 * watch, keep the service keys in line, and start the next run when it is
 * due. A tick that cannot reach the probe records why and stops there: no
 * node state moves on a missing reply, and no run is abandoned or started
 * blind.
 */
export const createReachabilityTask = ({
  repository,
  createProbeClient,
  now = () => new Date(),
  newRunId = randomUUID,
  log = () => undefined,
}: {
  repository: ReachabilityRepository;
  createProbeClient: (options: ProbeClientOptions) => ProbeClient;
  now?: () => Date;
  newRunId?: () => string;
  log?: (line: string) => void;
}) => {
  let capabilityRetryAt = 0;
  return async (): Promise<void> => {
    const probe = await repository.loadProbe();
    if (!probe || !probe.enabled) return;
    const at = now();
    const client = createProbeClient({ baseUrl: probe.apiBaseUrl, apiKey: probe.apiKey });
    const staleInput = {
      now: at,
      label: probe.label,
      timeZone: probe.timeZone,
      staleAfterSec: probe.staleAfterSec,
      intervalSec: probe.intervalSec,
      lastResultAt: probe.lastResultAt,
      since: probe.enabledAt,
      staleAlertedAt: probe.staleAlertedAt,
    };
    const watchStale = async () => {
      const stale = staleTransition({ ...staleInput, ingestedNow: false });
      if (stale.notices.length > 0) {
        await repository.setStaleAlert(stale.staleAlertedAt, stale.notices);
      }
    };

    const settleCandidate = async (run: CandidateRun, outcome: CandidateOutcome) => {
      const settled = await repository.finishCandidateRun(run, outcome);
      const verdict = outcome.error ? `${outcome.result} ${outcome.error}` : outcome.result;
      log(
        settled === "written"
          ? `reachability: settled candidate run ${run.runId} (${verdict})`
          : settled === "discarded"
            ? `reachability: candidate run ${run.runId} for route ${run.routeId} settled (${verdict}) but its result was discarded (route changed or verified since the request)`
            : `reachability: candidate run ${run.runId} was already settled by another tick`,
      );
    };

    // Refreshed on a bounded interval. A failure keeps the old record, which
    // ages out (probeSupportsBridgeMeasurement), so a probe that is down is
    // unknown rather than legacy; it is not asked again before the backoff.
    let capabilityInput = probeCapabilityInputOf(probe.capabilities, probe.capabilitiesCheckedAt);
    if (probeCapabilitiesDue(probe.capabilitiesCheckedAt, at) && at.getTime() >= capabilityRetryAt) {
      try {
        const reported = await client.capabilities();
        const capabilities = reported === "legacy" ? [] : reported.capabilities;
        await repository.recordProbeCapabilities(capabilities, at);
        capabilityInput = { capabilities, checkedAt: at };
      } catch (error) {
        capabilityRetryAt = at.getTime() + CAPABILITY_RETRY_BACKOFF_MS;
        log(`reachability: capability check failed: ${message(error)}`);
      }
    }

    let latest: ProbeRunState | null;
    try {
      latest = await client.latestRun();
    } catch (error) {
      await repository.recordProbeError(message(error), at);
      log(`reachability: ${message(error)}`);
      // A candidate claim must not outlive its timeout because the probe is
      // unreachable: judged on the panel clock alone, it is given up.
      if (probe.candidateRun) {
        const overdue = candidateRunOverdue(probe.candidateRun, at);
        if (overdue) await settleCandidate(probe.candidateRun, overdue);
      }
      await watchStale();
      return;
    }

    // A bridge route candidate check holds the probe: settle it when it is
    // done, and start nothing of our own until it is (its run and ours would
    // share the node's service peer). Its result goes to the route only,
    // never to node status, results, history or alerts.
    if (probe.candidateRun) {
      const outcome = candidateRunOutcome(probe.candidateRun, latest, at);
      if (outcome === null) {
        await watchStale();
        return;
      }
      await settleCandidate(probe.candidateRun, outcome);
    }

    let currentRunId = probe.currentRunId;
    if (
      latest &&
      latest.finishedAt !== null &&
      latest.runId === probe.currentRunId &&
      latest.runId !== probe.lastIngestedRunId
    ) {
      const finished = latest;
      let notices = 0;
      // Classified inside the ingest transaction, against targets and states
      // read under the node row locks: an endpoint change cannot slip in
      // between and leave an obsolete outcome or alert behind.
      const ingested = await repository.ingest({ runId: finished.runId, now: at }, (context) => {
        const out = ingestRun({
          runId: finished.runId,
          now: at,
          label: probe.label,
          timeZone: probe.timeZone,
          failThreshold: probe.failThreshold,
          controlOk: finished.control.ok === true,
          targets: context.targets,
          results: finished.results,
          previous: context.previous,
        });
        const stale = staleTransition({ ...staleInput, ingestedNow: true });
        notices = out.notices.length;
        return {
          outcomes: out.outcomes,
          states: out.states,
          notices: [...out.notices, ...stale.notices],
          staleAlertedAt: stale.staleAlertedAt,
          mass: out.massFailure,
        };
      });
      currentRunId = null;
      if (ingested) log(`reachability: ingested run ${finished.runId}, ${notices} notice(s)`);
    } else {
      await watchStale();
    }

    let provisioning = 0;
    try {
      ({ provisioning } = await repository.syncServiceKeys(at));
    } catch (error) {
      // A key that cannot be created this tick shows up as an `error` target;
      // it must not stop the nodes that do have keys from being checked.
      log(`reachability: key sync failed: ${message(error)}`);
    }

    if (currentRunId !== null) {
      const ours = latest !== null && latest.runId === currentRunId;
      const startedAt = probe.currentRunStartedAt?.getTime() ?? at.getTime();
      if (!ours) {
        // The probe keeps its runs in memory: a restart loses ours for good.
        await repository.abandonRun(at, "run lost: the probe no longer reports it (restarted?)");
      } else if (at.getTime() - startedAt > ABANDON_RUN_MS) {
        await repository.abandonRun(at, "run abandoned: still unfinished after 6 hours");
      } else {
        return;
      }
    }

    const lastStart = probe.currentRunStartedAt;
    const due =
      lastStart === null ||
      at.getTime() - lastStart.getTime() >= probe.intervalSec * 1_000 ||
      (probe.runRequestedAt !== null && probe.runRequestedAt > lastStart);
    if (!due) return;
    if (provisioning > 0) {
      // Keys created moments ago are a provisioning round away from usable;
      // a run now would report those nodes as unknown for a whole period.
      log(`reachability: waiting for ${provisioning} service key(s) to provision`);
      return;
    }

    // Read once for the whole run: a legacy probe drops an explicit null, so
    // a bridged target is only sent to a probe that reports the capability.
    const bridgeMeasurement = probeSupportsBridgeMeasurement(capabilityInput, at);
    const targets = await repository.listTargets({ bridgeMeasurement });
    const runId = newRunId();
    const request: ProbeRunRequest = {
      runId,
      control: { url: probe.controlUrl },
      egress: { url: probe.egressUrl },
      targets: targets
        .filter((target) => target.config !== null)
        .map((target) => ({
          targetId: target.targetId,
          protocol: target.protocol,
          config: target.config as string,
          // Bridged: the endpoint host is the bridge, so the comparison
          // target is the node's origin exit IP or, when unknown, an explicit
          // null (report the observed egress uncompared). Direct: omitted
          // when unknown keeps the probe's endpoint-host fallback.
          ...(measuredViaBridge(target) && bridgeMeasurement
            ? { expectedEgressIp: target.expectedEgressIp }
            : target.expectedEgressIp
              ? { expectedEgressIp: target.expectedEgressIp }
              : {}),
        })),
    };
    try {
      const started = await client.startRun(request);
      if (started === "busy") {
        // A bridge candidate check may have taken the probe since this tick
        // read it; that run is the panel's own and is settled next tick.
        if ((await repository.loadProbe())?.candidateRun) {
          log("reachability: probe busy with a bridge candidate check, waiting");
          return;
        }
        await repository.recordProbeError("probe is busy with a run the panel did not start", at);
        return;
      }
      await repository.markRunStarted(runId, at);
      log(`reachability: started run ${runId} with ${request.targets.length} target(s)`);
    } catch (error) {
      await repository.recordProbeError(message(error), at);
      log(`reachability: ${message(error)}`);
    }
  };
};
