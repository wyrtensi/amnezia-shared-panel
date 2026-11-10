import { randomUUID } from "node:crypto";

import type { ProbeRunRequest, ProbeRunState } from "@amnezia/contracts";

import type { ProbeClient, ProbeClientOptions } from "./probeAgent.js";
import {
  ingestRun,
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
};

/** A target as the panel knows it now, with its decrypted config when usable. */
export type RunTarget = ReachabilityTarget & {
  config: string | null;
  expectedEgressIp: string | null;
};

export type IngestWrite = {
  runId: string;
  now: Date;
  outcomes: ProtocolOutcome[];
  states: Map<string, NodeState>;
  notices: Notice[];
  staleAlertedAt: Date | null;
  /** The run was a mass failure (shown on the status widget). */
  mass: boolean;
};

export interface ReachabilityRepository {
  loadProbe: () => Promise<ProbeRow | null>;
  /** Why the last contact with the probe failed. Never carries a secret. */
  recordProbeError: (message: string, at: Date) => Promise<void>;
  /**
   * Ensure one live service key per (node, protocol) wanted; revoke the rest.
   * `provisioning` counts the wanted keys created moments ago and not ready.
   */
  syncServiceKeys: (
    now: Date,
  ) => Promise<{ created: number; revoked: number; provisioning: number }>;
  listTargets: () => Promise<RunTarget[]>;
  markRunStarted: (runId: string, at: Date) => Promise<void>;
  /** Forget a run the probe will never report, so a new one can start. */
  abandonRun: (at: Date, reason: string) => Promise<void>;
  loadStates: () => Promise<Map<string, NodeState>>;
  /** Results, history, node states, outbox messages and the probe row, atomically. */
  ingest: (write: IngestWrite) => Promise<void>;
  setStaleAlert: (staleAlertedAt: Date | null, notices: Notice[]) => Promise<void>;
}

/**
 * A run the probe still reports as ours and unfinished is only given up after
 * this long: a large fleet is slow, but a run that never ends must not block
 * the next one forever.
 */
export const ABANDON_RUN_MS = 6 * 60 * 60 * 1_000;

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

    let latest: ProbeRunState | null;
    try {
      latest = await client.latestRun();
    } catch (error) {
      await repository.recordProbeError(message(error), at);
      log(`reachability: ${message(error)}`);
      await watchStale();
      return;
    }

    let currentRunId = probe.currentRunId;
    if (
      latest &&
      latest.finishedAt !== null &&
      latest.runId === probe.currentRunId &&
      latest.runId !== probe.lastIngestedRunId
    ) {
      const targets = await repository.listTargets();
      const previous = await repository.loadStates();
      const out = ingestRun({
        runId: latest.runId,
        now: at,
        label: probe.label,
        timeZone: probe.timeZone,
        failThreshold: probe.failThreshold,
        controlOk: latest.control.ok === true,
        targets,
        results: latest.results,
        previous,
      });
      const stale = staleTransition({ ...staleInput, ingestedNow: true });
      await repository.ingest({
        runId: latest.runId,
        now: at,
        outcomes: out.outcomes,
        states: out.states,
        notices: [...out.notices, ...stale.notices],
        staleAlertedAt: stale.staleAlertedAt,
        mass: out.massFailure,
      });
      currentRunId = null;
      log(`reachability: ingested run ${latest.runId}, ${out.notices.length} notice(s)`);
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

    const targets = await repository.listTargets();
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
          ...(target.expectedEgressIp ? { expectedEgressIp: target.expectedEgressIp } : {}),
        })),
    };
    try {
      const started = await client.startRun(request);
      if (started === "busy") {
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
