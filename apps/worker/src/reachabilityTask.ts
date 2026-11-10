import { randomUUID } from "node:crypto";

import type { ProbeRunRequest } from "@amnezia/contracts";

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
  createdAt: Date;
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
};

export interface ReachabilityRepository {
  loadProbe: () => Promise<ProbeRow | null>;
  /** Why the last contact with the probe failed. Never carries a secret. */
  recordProbeError: (message: string, at: Date) => Promise<void>;
  /** Ensure one live service key per (node, protocol) wanted; revoke the rest. */
  syncServiceKeys: (now: Date) => Promise<{ created: number; revoked: number }>;
  listTargets: () => Promise<RunTarget[]>;
  markRunStarted: (runId: string, at: Date) => Promise<void>;
  /** Forget a run the probe never finished, so a new one can start. */
  abandonRun: (at: Date) => Promise<void>;
  loadStates: () => Promise<Map<string, NodeState>>;
  /** Results, history, node states, outbox messages and the probe row, atomically. */
  ingest: (write: IngestWrite) => Promise<void>;
  setStaleAlert: (staleAlertedAt: Date | null, notices: Notice[]) => Promise<void>;
}

/** A run still in flight after this long is abandoned. */
export const ABANDON_RUN_MS = 30 * 60 * 1_000;

const message = (error: unknown) =>
  (error instanceof Error ? error.message : "unknown error").slice(0, 300);

/**
 * One tick of the reachability task: ingest a finished run, keep the stale
 * watch, and start the next run when it is due. Every failure to reach the
 * probe is recorded and nothing else: no node state moves on a missing reply.
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

    let currentRunId = probe.currentRunId;
    let ingested = false;
    try {
      const latest = await client.latestRun();
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
          failThreshold: probe.failThreshold,
          controlOk: latest.control.ok === true,
          targets,
          results: latest.results,
          previous,
        });
        const stale = staleTransition({
          now: at,
          label: probe.label,
          staleAfterSec: probe.staleAfterSec,
          lastResultAt: probe.lastResultAt,
          createdAt: probe.createdAt,
          staleAlertedAt: probe.staleAlertedAt,
          ingestedNow: true,
        });
        await repository.ingest({
          runId: latest.runId,
          now: at,
          outcomes: out.outcomes,
          states: out.states,
          notices: [...out.notices, ...stale.notices],
          staleAlertedAt: stale.staleAlertedAt,
        });
        ingested = true;
        currentRunId = null;
        log(`reachability: ingested run ${latest.runId}, ${out.notices.length} notice(s)`);
      }
    } catch (error) {
      await repository.recordProbeError(message(error), at);
      log(`reachability: ${message(error)}`);
    }

    if (!ingested) {
      const stale = staleTransition({
        now: at,
        label: probe.label,
        staleAfterSec: probe.staleAfterSec,
        lastResultAt: probe.lastResultAt,
        createdAt: probe.createdAt,
        staleAlertedAt: probe.staleAlertedAt,
        ingestedNow: false,
      });
      if (stale.notices.length > 0) {
        await repository.setStaleAlert(stale.staleAlertedAt, stale.notices);
      }
    }

    if (
      currentRunId !== null &&
      probe.currentRunStartedAt !== null &&
      at.getTime() - probe.currentRunStartedAt.getTime() > ABANDON_RUN_MS
    ) {
      await repository.abandonRun(at);
      currentRunId = null;
    }
    if (currentRunId !== null) return;

    const lastStart = probe.currentRunStartedAt;
    const due =
      lastStart === null ||
      at.getTime() - lastStart.getTime() >= probe.intervalSec * 1_000 ||
      (probe.runRequestedAt !== null && probe.runRequestedAt > lastStart);
    if (!due) return;

    try {
      await repository.syncServiceKeys(at);
    } catch (error) {
      // A key that cannot be created this tick shows up as an `error` target;
      // it must not stop the nodes that do have keys from being checked.
      log(`reachability: key sync failed: ${message(error)}`);
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
