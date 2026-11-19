import { createHash, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";

import {
  bridgePanelDnsHostnameSchema,
  isIpLiteral,
  isIpv4Literal,
  isProbeStale,
  nodeServedProtocols,
  probeCapabilityInputOf,
  PROBE_STALE_GRACE_SEC,
  probeLevelsSchema,
  probeRunTargetSchema,
  probeSupportsBridgeMeasurement,
  REACHABILITY_NOTIFY_JOB_TYPE,
  REACHABILITY_WIDGET_JOB_TYPE,
  type ProbeBridgeRunTarget,
  type ProbeLevels,
  type ReachabilityStatus,
  type ReachabilityWidgetPayload,
  revokeJobDedupKey,
  type ProtocolKind,
} from "@amnezia/contracts";
import {
  advanceBridgeIncident,
  auditEvents,
  bridgeReachabilityState,
  EMPTY_BRIDGE_INCIDENT,
  decryptSecret,
  deterministicPeerLabel,
  jobOutbox,
  keyOwnerIsPerson,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodeVpnEndpoints,
  nodes,
  peerCurrent,
  portalPolicy,
  reachabilityProbe,
  reachabilityWidgetMessages,
  SERVICE_ACCOUNT_EMAIL,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";
import { inspectAwgVpnLink, renderAwgEndpointVpnLink, withAwg31TunnelMtu, type AwgEndpoint } from "@amnezia/vpn-config";

import type { CandidateOutcome, CandidateRun } from "./bridgeCandidateCheck.js";
import {
  EMPTY_CANDIDATE_SLOT,
  writeCandidateVerification,
} from "./bridgeCandidateRepository.js";
import { bridgeExternalVerdict, bridgeHostTargetId } from "./bridgeReachability.js";
import {
  alertClock,
  measuredViaBridge,
  reachabilityTargetId,
  type NodeState,
  type Notice,
  type ProtocolOutcome,
  type ReachabilityTarget,
} from "./reachability.js";
import type { WidgetNode } from "./reachabilityWidget.js";
import type {
  ReachabilityWidgetStore,
  SentWidgetMessage,
  StoredWidget,
} from "./reachabilityWidgetSender.js";
import type {
  CandidateSettle,
  IngestDecide,
  IngestRun,
  ProbeDispatchResult,
  ProbeDispatchScope,
  ProbeRow,
  ReachabilityRepository,
  RunTarget,
} from "./reachabilityTask.js";

export { SERVICE_ACCOUNT_EMAIL };

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** A failed service key is retried no sooner than this. */
const FAILED_KEY_RETRY_MS = 24 * 60 * 60 * 1_000;
const LIVE_KEY_STATES = ["provisioning", "active", "disabled"] as const;
/** A run waits this long at most for freshly created keys to provision. */
const PROVISIONING_WAIT_MS = 10 * 60 * 1_000;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PublicEndpoint = typeof nodeVpnEndpoints.$inferSelect;

const directNodeTargets = (
  target: RunTarget & { config: string },
  endpoints: readonly PublicEndpoint[],
  { host, port }: AwgEndpoint,
  keyId: string,
  mayReuseLegacy: boolean,
  allowReuseNodeTarget = true,
): RunTarget[] => {
  let nodeTarget: RunTarget = target;
  const additional: RunTarget[] = [];
  const { diagnostic, ...base } = target;
  for (const endpoint of endpoints) {
    if (!isIpv4Literal(endpoint.address)) continue;
    const reusesNodeTarget =
      allowReuseNodeTarget &&
      host === endpoint.address &&
      (diagnostic === true || (mayReuseLegacy && endpoint.ordinal === 1 && endpoint.revision === 0));
    const directEndpoint = {
      id: endpoint.id,
      address: endpoint.address,
      name: endpoint.name,
      checkedAt: endpoint.probeCheckedAt,
      reusesNodeTarget,
    };
    // Fence old replies without putting addresses, labels or key material in
    // the probe's logged target IDs. The prefix already carries the node's
    // bridge assignment revision.
    const identity = createHash("sha256")
      .update(JSON.stringify([endpoint.id, endpoint.revision, endpoint.address, port, keyId]))
      .digest("hex");
    const targetId = `${reachabilityTargetId(target.nodeId, "awg3", target.endpointRevision)}:direct:${identity}`;
    if (reusesNodeTarget) {
      nodeTarget = { ...target, directEndpoint, targetId: diagnostic ? targetId : target.targetId };
      continue;
    }
    const config = renderAwgEndpointVpnLink(target.config, { host: endpoint.address, port });
    if (!probeRunTargetSchema.shape.config.safeParse(config).success) continue;
    additional.push({
      ...base,
      config,
      directEndpoint,
      targetId,
      expectedEgressIp: isIpLiteral(target.expectedEgressIp ?? "") ? target.expectedEgressIp : null,
    });
  }
  return allowReuseNodeTarget ? [nodeTarget, ...additional] : additional;
};

const outboxRows = (notices: readonly Notice[]) =>
  notices.map((notice) => ({
    type: REACHABILITY_NOTIFY_JOB_TYPE,
    deduplicationKey: notice.dedupKey,
    payload: { text: notice.text },
  }));

/**
 * A widget refresh; completed rows keep their key, so each trigger is unique.
 * `notice` marks a run that also queued a node alert.
 */
const widgetRow = (trigger: string, notice = false) => ({
  type: REACHABILITY_WIDGET_JOB_TYPE,
  deduplicationKey: `${REACHABILITY_WIDGET_JOB_TYPE}:${trigger}`,
  payload: (notice ? { notice: true } : {}) satisfies ReachabilityWidgetPayload,
});

const STATUS_RANK = { ok: 0, failed: 1, error: 2 } as const;

/** Why a bridged AWG 3.1 target is not sent; it then reads as unknown. */
export const BRIDGE_UNSUPPORTED_REASON =
  "bridged path not measured: the probe lacks the bridge-measurement capability";
export const BRIDGE_UNRENDERABLE_REASON =
  "bridged path not measured: the service key is not an AWG 3.1 artifact the bridge endpoint applies to";

export class PostgresReachabilityRepository
  implements ReachabilityRepository, ReachabilityWidgetStore
{
  constructor(
    private readonly options: { db: Database; keyring: EncryptionKeyring },
  ) {}

  private probeApiKey = (row: typeof reachabilityProbe.$inferSelect): string => decryptSecret({
    ciphertext: row.credentialsCiphertext,
    nonce: row.credentialsNonce,
    authTag: row.credentialsAuthTag,
    keyVersion: row.credentialsKeyVersion,
  }, this.options.keyring);

  loadProbe = async (): Promise<ProbeRow | null> => {
    const [row] = await this.options.db
      .select()
      .from(reachabilityProbe)
      .where(eq(reachabilityProbe.id, 1))
      .limit(1);
    if (!row) return null;
    return {
      label: row.label,
      apiBaseUrl: row.apiBaseUrl,
      apiKey: this.probeApiKey(row),
      enabled: row.enabled,
      controlUrl: row.controlUrl,
      egressUrl: row.egressUrl,
      intervalSec: row.intervalSec,
      failThreshold: row.failThreshold,
      staleAfterSec: row.staleAfterSec,
      runRequestedAt: row.runRequestedAt,
      requestedRunId: row.requestedRunId,
      currentRunId: row.currentRunId,
      currentRunStartedAt: row.currentRunStartedAt,
      lastResultAt: row.lastResultAt,
      lastIngestedRunId: row.lastIngestedRunId,
      staleAlertedAt: row.staleAlertedAt,
      enabledAt: row.enabledAt,
      timeZone: row.timeZone,
      probeDirectWhenBridged: row.probeDirectWhenBridged,
      stealthMode: row.stealthMode,
      capabilities: row.capabilities ?? null,
      capabilitiesCheckedAt: row.capabilitiesCheckedAt,
      candidateRun:
        row.candidateRunId !== null &&
        row.candidateRouteId !== null &&
        row.candidateRegistrationMarker !== null &&
        row.candidateRequestedAt !== null &&
        row.candidateRunStartedAt !== null
          ? {
              runId: row.candidateRunId,
              routeId: row.candidateRouteId,
              registrationMarker: row.candidateRegistrationMarker,
              requestedAt: row.candidateRequestedAt,
              startedAt: row.candidateRunStartedAt,
            }
          : null,
    };
  };

  private updateProbe = (values: Partial<typeof reachabilityProbe.$inferInsert>, db: Database | Tx = this.options.db) =>
    db
      .update(reachabilityProbe)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(reachabilityProbe.id, 1));

  recordProbeError = async (message: string, at: Date): Promise<void> => {
    await this.updateProbe({ lastError: message.slice(0, 300), lastErrorAt: at });
  };

  recordProbeCapabilities = async (capabilities: string[], at: Date): Promise<void> => {
    await this.updateProbe({ capabilities, capabilitiesCheckedAt: at });
  };

  markRunStarted = async (runId: string, at: Date, db: Database | Tx = this.options.db): Promise<void> => {
    // Only over an empty slot: a second worker must not overwrite a run in
    // flight with one the probe refused.
    await db
      .update(reachabilityProbe)
      .set({
        currentRunId: runId,
        currentRunStartedAt: at,
        requestedRunId: sql`case when ${reachabilityProbe.requestedRunId} = ${runId} then null else ${reachabilityProbe.requestedRunId} end`,
        updatedAt: new Date(),
      })
      .where(and(eq(reachabilityProbe.id, 1), isNull(reachabilityProbe.currentRunId)));
  };

  withDispatchLock = async (
    expected: ProbeRow,
    dispatch: (scope: ProbeDispatchScope) => Promise<ProbeDispatchResult>,
  ): Promise<ProbeDispatchResult | "changed"> => this.options.db.transaction(async (tx) => {
    const [row] = await tx.select().from(reachabilityProbe)
      .where(eq(reachabilityProbe.id, 1)).for("no key update");
    if (
      !row?.enabled ||
      row.currentRunId !== null ||
      row.candidateRunId !== null ||
      row.currentRunStartedAt?.getTime() !== expected.currentRunStartedAt?.getTime() ||
      row.requestedRunId !== (expected.requestedRunId ?? null) ||
      row.runRequestedAt?.getTime() !== expected.runRequestedAt?.getTime() ||
      row.probeDirectWhenBridged !== expected.probeDirectWhenBridged ||
      row.stealthMode !== expected.stealthMode ||
      row.intervalSec !== expected.intervalSec ||
      row.staleAfterSec !== expected.staleAfterSec ||
      row.apiBaseUrl !== expected.apiBaseUrl ||
      row.controlUrl !== expected.controlUrl ||
      row.egressUrl !== expected.egressUrl ||
      this.probeApiKey(row) !== expected.apiKey
    ) {
      return "changed";
    }
    // Preserve probe -> node lock order. The only network request made by the
    // dispatch callback is startRun, with the probe client's request timeout.
    // Once a run is submitted it owns that snapshot until it finishes.
    return dispatch({
      capabilities: probeCapabilityInputOf(row.capabilities, row.capabilitiesCheckedAt),
      listTargets: (options) => this.loadTargets(tx, { lock: true, ...options }),
      listBridgeTargets: (bridgesWithAwg) => this.listBridgeTargets(bridgesWithAwg, tx),
      markRunStarted: (runId, at) => this.markRunStarted(runId, at, tx),
    });
  });

  abandonRun = async (at: Date, reason: string): Promise<void> => {
    await this.updateProbe({
      currentRunId: null,
      lastError: reason.slice(0, 300),
      lastErrorAt: at,
    });
  };

  private loadStates = async (db: Database | Tx): Promise<Map<string, NodeState>> => {
    const rows = await db.select().from(nodeReachabilityState);
    return new Map(
      rows.map((row) => [
        row.nodeId,
        {
          status: row.status,
          consecutiveFailures: row.consecutiveFailures,
          failingSince: row.failingSince,
          alertedAt: row.alertedAt,
          alertKind: row.alertKind,
          checkedAt: row.checkedAt,
          detail: row.detail,
        },
      ]),
    );
  };

  setStaleAlert = async (staleAlertedAt: Date | null, notices: Notice[]): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      await this.updateProbe({ staleAlertedAt }, tx);
      if (notices.length > 0) {
        await tx.insert(jobOutbox).values(outboxRows(notices)).onConflictDoNothing();
      }
      // Going stale redraws the widget as "no data"; coming back is an ingest,
      // which redraws it anyway.
      if (staleAlertedAt) {
        await tx
          .insert(jobOutbox)
          .values(widgetRow(`stale:${staleAlertedAt.toISOString()}`))
          .onConflictDoNothing();
      }
    });
  };

  finishCandidateRun = async (
    run: CandidateRun,
    outcome: CandidateOutcome,
  ): Promise<CandidateSettle> =>
    this.options.db.transaction(async (tx) => {
      // Claim it first, as `ingest` claims a regular run: only the tick that
      // frees the slot writes the result.
      const freed = await tx
        .update(reachabilityProbe)
        .set({ ...EMPTY_CANDIDATE_SLOT, updatedAt: new Date() })
        .where(
          and(eq(reachabilityProbe.id, 1), eq(reachabilityProbe.candidateRunId, run.runId)),
        )
        .returning({ id: reachabilityProbe.id });
      if (freed.length === 0) return "already-settled";
      const written = await writeCandidateVerification(tx, {
        routeId: run.routeId,
        registrationMarker: run.registrationMarker,
        requestedAt: run.requestedAt,
        outcome,
      });
      return written ? "written" : "discarded";
    });

  /**
   * Ingest one finished run in one transaction:
   *
   * 1. Claim the run (`current_run_id` cleared by exactly one ingest), so an
   *    overlapping worker cannot count it twice.
   * 2. Lock the probed node rows `FOR SHARE`, in id order, then read the
   *    targets as they are now, endpoint revision and active bridge route
   *    included (`loadTargets`). An assignment change holds its node row
   *    `FOR NO KEY UPDATE` from its revision bump through its evidence reset
   *    (`resetNodeEndpointEvidence`), so it either committed before the
   *    targets are read or waits for this commit: the assignment cannot
   *    change between classification and the writes below. No reachability
   *    row is touched before these locks (lock order: probe row, node rows,
   *    reachability rows; an activation never touches the probe row).
   * 3. Read the stored node states under the same locks and let `decide`
   *    classify the run against them. A result for another endpoint revision
   *    never matches a current target (`reachabilityTargetId`), so it is
   *    unknown: not stored, not counted, never a notice.
   * 4. Write results, states, history, notices and the widget refresh.
   */
  ingest = async (run: IngestRun, decide: IngestDecide): Promise<boolean> =>
    this.options.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(reachabilityProbe)
        .set({
          currentRunId: null,
          lastIngestedRunId: run.runId,
          lastResultAt: run.now,
          lastError: null,
          lastErrorAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(reachabilityProbe.id, 1), eq(reachabilityProbe.currentRunId, run.runId)))
        .returning({
          capabilities: reachabilityProbe.capabilities,
          capabilitiesCheckedAt: reachabilityProbe.capabilitiesCheckedAt,
          currentRunStartedAt: reachabilityProbe.currentRunStartedAt,
          probeDirectWhenBridged: reachabilityProbe.probeDirectWhenBridged,
          label: reachabilityProbe.label,
          failThreshold: reachabilityProbe.failThreshold,
          timeZone: reachabilityProbe.timeZone,
        });
      if (!claimed) return false;

      // The capability as it stood when the run was dispatched: a bridged
      // target that did go out is not discarded because the record aged
      // since, and one that could not go out reads unknown.
      const bridgeMeasurement = probeSupportsBridgeMeasurement(
        probeCapabilityInputOf(claimed.capabilities, claimed.capabilitiesCheckedAt),
        claimed.currentRunStartedAt ?? run.now,
      );
      const targets = await this.loadTargets(tx, {
        lock: true,
        bridgeMeasurement,
        runStartedAt: claimed.currentRunStartedAt ?? run.now,
        probeDirectWhenBridged: claimed.probeDirectWhenBridged,
      });
      const previous = await this.loadStates(tx);
      const write = await decide({ targets, previous });

      await this.updateProbe({ staleAlertedAt: write.staleAlertedAt, lastRunMass: write.mass }, tx);

      const endpointIds = new Set(
        targets.flatMap((target) => [
          ...(target.directEndpoint ? [target.directEndpoint.id] : []),
          ...(target.bridgedEndpointIds ?? []),
        ]),
      );
      const endpointNotices: Notice[] = [];
      if (write.endpointOutcomes.length > 0) {
        const relevantIds = write.endpointOutcomes
          .map((item) => item.endpointId)
          .filter((id) => endpointIds.has(id));
        const priorEndpoints = relevantIds.length > 0
          ? new Map(
              (
                await tx
                  .select()
                  .from(nodeVpnEndpoints)
                  .where(inArray(nodeVpnEndpoints.id, relevantIds))
              ).map((row) => [row.id, row]),
            )
          : new Map<string, PublicEndpoint>();
        const yesNo = (level: { ok: boolean | null } | undefined) =>
          level?.ok === true ? "да" : level?.ok === false ? "нет" : "—";
        for (const endpoint of write.endpointOutcomes) {
          if (!endpointIds.has(endpoint.endpointId)) continue;
          const prior = priorEndpoints.get(endpoint.endpointId);
          const previous = prior
            ? {
                consecutiveFailures: prior.probeConsecutiveFailures,
                failingSince: prior.probeFailingSince,
                alertedAt: prior.probeAlertedAt,
              }
            : EMPTY_BRIDGE_INCIDENT;
          // Track per-IP incident alerts for direct (non-bridged) endpoints.
          // Bridged endpoints share the node-level bridge alert, so record their
          // failure streak and failingSince for status display without paging again.
          const trackIncident =
            prior?.enabled === true &&
            prior.reachabilityEnabled &&
            !endpoint.isBridged &&
            !write.mass;
          const { state, notice } = trackIncident
            ? advanceBridgeIncident(previous, endpoint.status, run.now, claimed.failThreshold)
            : {
                state: {
                  consecutiveFailures:
                    endpoint.status === "ok"
                      ? 0
                      : endpoint.status === "failed"
                        ? previous.consecutiveFailures + 1
                        : previous.consecutiveFailures,
                  failingSince:
                    endpoint.status === "ok"
                      ? null
                      : endpoint.status === "failed"
                        ? previous.failingSince ?? run.now
                        : previous.failingSince,
                  alertedAt: endpoint.isBridged
                    ? null
                    : endpoint.status === "ok"
                      ? null
                      : previous.alertedAt,
                },
                notice: null,
              };
          await tx
            .update(nodeVpnEndpoints)
            .set({
              probeStatus: endpoint.status,
              probeLevels: endpoint.levels ?? null,
              probeCheckedAt: run.now,
              probeConsecutiveFailures: state.consecutiveFailures,
              probeFailingSince: state.failingSince,
              probeAlertedAt: state.alertedAt,
              probeDetail: endpoint.detail,
            })
            .where(eq(nodeVpnEndpoints.id, endpoint.endpointId));
          // Avoid duplicating the primary node alert when an endpoint reused
          // the primary node target; send dedicated per-IP alerts for every
          // separately probed address (e.g. secondary IPv4 listeners).
          if (notice && !endpoint.reusesNodeTarget && prior) {
            const openedAt = previous.alertedAt ?? run.now;
            const title = `Адрес ${prior.name} (${prior.address})`;
            endpointNotices.push({
              dedupKey: `${REACHABILITY_NOTIFY_JOB_TYPE}:endpoint-probe:${prior.id}:${openedAt.getTime()}:${notice}`,
              text:
                notice === "down"
                  ? `${title} недоступен из ${claimed.label}\n` +
                    `handshake: ${yesNo(endpoint.levels?.handshake)}, tcp/22: ${yesNo(endpoint.levels?.tcp)}, ping: ${yesNo(endpoint.levels?.ping)}\n` +
                    `с ${alertClock(state.failingSince ?? run.now, claimed.timeZone)}`
                  : `${title} снова доступен из ${claimed.label}`,
            });
          }
        }
      }

      // Every node here is locked, so none can be deleted before the commit.
      const nodeIds = new Set(targets.map((target) => target.nodeId));
      for (const nodeId of nodeIds) {
        const outcomes = write.outcomes.filter((o) => o.nodeId === nodeId);
        // Served protocols, obsolete ones included: a protocol the node no
        // longer serves leaves no stale row behind, while an obsolete result
        // simply is not written (the endpoint change already removed it).
        const protocols = outcomes.map((o) => o.protocol);
        await tx
          .delete(nodeReachabilityResults)
          .where(
            and(
              eq(nodeReachabilityResults.nodeId, nodeId),
              protocols.length > 0
                ? notInArray(nodeReachabilityResults.protocol, protocols)
                : undefined,
            ),
          );
        for (const outcome of outcomes) {
          if (outcome.obsolete) continue;
          const values = {
            nodeId,
            protocol: outcome.protocol,
            status: outcome.status,
            levels: (outcome.levels ?? {}) as Record<string, unknown>,
            egressIp: outcome.egressIp,
            detail: outcome.detail,
            runId: run.runId,
            checkedAt: run.now,
          };
          await tx
            .insert(nodeReachabilityResults)
            .values({
              ...values,
              failingSince: outcome.status === "failed" ? run.now : null,
            })
            .onConflictDoUpdate({
              target: [nodeReachabilityResults.nodeId, nodeReachabilityResults.protocol],
              // A failure streak keeps its start across an `error` run (an
              // older failed row without one falls back to its own check
              // time); only an `ok` result clears it, like the node state.
              set: {
                ...values,
                failingSince:
                  outcome.status === "failed"
                    ? sql`coalesce(${nodeReachabilityResults.failingSince},
                        case when ${nodeReachabilityResults.status} = 'failed'
                          then ${nodeReachabilityResults.checkedAt}
                          else excluded.checked_at end)`
                    : outcome.status === "error"
                      ? sql`${nodeReachabilityResults.failingSince}`
                      : null,
              },
            });
        }

        const state = write.states.get(nodeId);
        if (!state) continue;
        const direct = write.direct?.get(nodeId);
        const stateValues = {
          nodeId,
          status: state.status,
          consecutiveFailures: state.consecutiveFailures,
          failingSince: state.failingSince,
          alertedAt: state.alertedAt,
          alertKind: state.alertKind,
          checkedAt: run.now,
          detail: state.detail,
          ...(direct ? {
            directStatus: direct.status,
            directCheckedAt: run.now,
            directDetail: direct.detail,
          } : {}),
        };
        await tx
          .insert(nodeReachabilityState)
          .values(stateValues)
          .onConflictDoUpdate({ target: nodeReachabilityState.nodeId, set: stateValues });
        await tx.insert(nodeReachabilityHistory).values({
          nodeId,
          runId: run.runId,
          status: state.status,
          detail: state.detail,
          checkedAt: run.now,
        });
      }

      const bridgeNotices = await this.writeBridgeProbeStates(tx, run, targets, write.outcomes, claimed);
      const notices = [...write.notices, ...endpointNotices, ...bridgeNotices];
      if (notices.length > 0) {
        await tx.insert(jobOutbox).values(outboxRows(notices)).onConflictDoNothing();
      }
      await tx
        .insert(jobOutbox)
        .values(widgetRow(`run:${run.runId}`, notices.length > 0))
        .onConflictDoNothing();
      await tx
        .delete(nodeReachabilityHistory)
        .where(
          lt(
            nodeReachabilityHistory.checkedAt,
            new Date(run.now.getTime() - HISTORY_RETENTION_MS),
          ),
        );
      return true;
    });

  /** Found by its flag, never by its address alone. */
  private serviceAccountId = async (db: Database | Tx): Promise<string | null> => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.serviceAccount, true))
      .orderBy(users.createdAt)
      .limit(1);
    return row?.id ?? null;
  };

  listTargets = async (options: { bridgeMeasurement: boolean; probeDirectWhenBridged?: boolean }): Promise<RunTarget[]> =>
    this.options.db.transaction(
      (tx) => this.loadTargets(tx, { lock: false, ...options }),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

  listBridgeTargets = async (
    bridgesWithAwg: readonly string[],
    db: Database | Tx = this.options.db,
  ): Promise<ProbeBridgeRunTarget[]> => {
    const measured = new Set(bridgesWithAwg);
    const bridges = await db.select({
      id: vpnBridges.id,
      host: vpnBridges.publicIpv4,
      httpsHostname: vpnBridges.panelDnsHostname,
    }).from(vpnBridges)
      .where(and(
        eq(vpnBridges.reachabilityEnabled, true),
        measured.size === 0 ? undefined : sql`(
          ${vpnBridges.panelDnsHostname} IS NOT NULL OR ${notInArray(vpnBridges.id, [...measured])}
        )`,
      ))
      .orderBy(vpnBridges.id);
    return bridges.flatMap(({ id, host, httpsHostname: stored }) => {
      const httpsHostname = bridgePanelDnsHostnameSchema.safeParse(stored).data ?? null;
      if (!isIPv4(host) || (!httpsHostname && measured.has(id))) return [];
      return [{
        targetId: bridgeHostTargetId(id, host, httpsHostname),
        host,
        ...(httpsHostname ? { httpsHostname } : {}),
      }];
    }).slice(0, 200);
  };

  private writeBridgeProbeStates = async (
    tx: Tx,
    run: IngestRun,
    targets: readonly ReachabilityTarget[],
    outcomes: readonly ProtocolOutcome[],
    { label, failThreshold, timeZone }: { label: string; failThreshold: number; timeZone: string },
  ): Promise<Notice[]> => {
    const awgByNode = new Map(outcomes.filter(({ protocol, obsolete }) => protocol === "awg3" && !obsolete)
      .map((outcome) => [outcome.nodeId, outcome]));
    const awgByBridge = new Map<string, ProtocolOutcome[]>();
    for (const target of targets) {
      const bridgeId = target.bridgePath?.bridgeId;
      if (!bridgeId || !measuredViaBridge(target)) continue;
      const outcome = awgByNode.get(target.nodeId);
      if (!outcome) continue;
      const outcomes = awgByBridge.get(bridgeId) ?? [];
      outcomes.push(outcome);
      awgByBridge.set(bridgeId, outcomes);
    }
    const hostByTarget = new Map(run.bridgeResults?.map((result) => [result.targetId, result]));
    const bridgeIds = [...new Set([
      ...awgByBridge.keys(),
      ...[...hostByTarget.keys()].map((targetId) => targetId.split(":host:")[0] ?? ""),
    ])];
    if (bridgeIds.length === 0) return [];

    // The node locks held by ingest stabilize AWG route assignments. Lock
    // the bridges before reading incident state, in the route mutation order.
    const bridges = await tx.select({
      id: vpnBridges.id,
      name: vpnBridges.name,
      publicIpv4: vpnBridges.publicIpv4,
      panelDnsHostname: vpnBridges.panelDnsHostname,
      reachabilityEnabled: vpnBridges.reachabilityEnabled,
    }).from(vpnBridges)
      .where(inArray(sql<string>`${vpnBridges.id}::text`, bridgeIds))
      .orderBy(vpnBridges.id)
      .for("no key update");
    const notices: Notice[] = [];
    for (const bridge of bridges) {
      const awg = awgByBridge.get(bridge.id) ?? [];
      const httpsHostname = bridgePanelDnsHostnameSchema.safeParse(bridge.panelDnsHostname).data ?? null;
      const returned = hostByTarget.get(bridgeHostTargetId(bridge.id, bridge.publicIpv4, httpsHostname));
      const host = returned?.host === bridge.publicIpv4 ? returned : undefined;
      if (awg.length === 0 && !host) continue;
      const verdict = bridgeExternalVerdict(awg, host, httpsHostname);
      const [prior] = await tx.select().from(bridgeReachabilityState)
        .where(eq(bridgeReachabilityState.bridgeId, bridge.id));
      const previous = prior ? {
        consecutiveFailures: prior.probeConsecutiveFailures,
        failingSince: prior.probeFailingSince,
        alertedAt: prior.probeAlertedAt,
      } : EMPTY_BRIDGE_INCIDENT;
      const { state, notice } = bridge.reachabilityEnabled
        ? advanceBridgeIncident(previous, verdict.status, run.now, failThreshold)
        : { state: EMPTY_BRIDGE_INCIDENT, notice: null };
      const values = {
        probeStatus: verdict.status,
        probeLevels: host?.levels ?? null,
        probeCheckedAt: run.now,
        probeConsecutiveFailures: state.consecutiveFailures,
        probeFailingSince: state.failingSince,
        probeAlertedAt: state.alertedAt,
        probeDetail: verdict.detail?.slice(0, 300) ?? null,
      };
      await tx.insert(bridgeReachabilityState).values({ bridgeId: bridge.id, ...values })
        .onConflictDoUpdate({ target: bridgeReachabilityState.bridgeId, set: values });
      if (notice) {
        const openedAt = previous.alertedAt ?? run.now;
        const name = `Мост ${bridge.name} (${bridge.publicIpv4})`;
        notices.push({
          dedupKey: `${REACHABILITY_NOTIFY_JOB_TYPE}:bridge-probe:${bridge.id}:${openedAt.getTime()}:${notice}`,
          text: notice === "down"
            ? `${name} недоступен из ${label} (${values.probeDetail ?? "внешняя проверка"})\nс ` +
              alertClock(state.failingSince ?? run.now, timeZone)
            : `${name} снова доступен из ${label}`,
        });
      }
    }
    return notices;
  };

  /**
   * The targets as the panel knows them now. The node row, its endpoint
   * revision, its active bridge route and that bridge are read in ONE
   * statement, so a config is never paired with the revision of another
   * assignment. Dispatch uses a read-only snapshot for the address list and
   * service keys, too.
   *
   * With `lock` (see `ingest`), the node rows are first taken `FOR SHARE` in
   * id order by a statement of their own, and the join runs after it. A
   * single locking join is not enough: when it waits for an activation, READ
   * COMMITTED re-reads only the locked node row after that commit, while the
   * joined route and bridge rows stay as they were when the statement began,
   * so it would pair the new revision with the old route. Once the node rows
   * are locked nothing they key can change, and the join's fresh snapshot
   * sees the committed assignment.
   *
   * A bridged node's AWG 3.1 target carries the service-key artifact
   * rendered with the bridge endpoint, the same renderer user exports use. It
   * is not sent (unknown, never an alert) when the probe cannot measure a
   * bridged path or the artifact is not one the endpoint applies to; the
   * direct config is never sent under the bridged identity. Direct checks
   * on bridged nodes are dispatched only when enabled explicitly.
   */
  private loadTargets = async (
    db: Tx,
    options: { lock: boolean; bridgeMeasurement: boolean; probeDirectWhenBridged?: boolean; runStartedAt?: Date },
  ): Promise<RunTarget[]> => {
    let lockedIds: string[] | null = null;
    if (options.lock) {
      lockedIds = (
        await db
          .select({ id: nodes.id })
          .from(nodes)
          .where(eq(nodes.reachabilityEnabled, true))
          .orderBy(nodes.id)
          .for("share")
      ).map((row) => row.id);
      if (lockedIds.length === 0) return [];
    }
    const nodeRows = await db
      .select({
        id: nodes.id,
        name: nodes.name,
        protocol: nodes.protocol,
        capabilities: nodes.capabilities,
        enabledProtocols: nodes.enabledProtocols,
        publicIp: nodes.publicIp,
        publicHost: nodes.publicHost,
        endpointRevision: nodes.vpnEndpointRevision,
        bridgeId: vpnBridgeRoutes.bridgeId,
        bridgeName: vpnBridges.name,
        bridgeHost: vpnBridges.publicIpv4,
        bridgePort: vpnBridgeRoutes.publicUdpPort,
      })
      .from(nodes)
      .leftJoin(
        vpnBridgeRoutes,
        and(eq(vpnBridgeRoutes.nodeId, nodes.id), eq(vpnBridgeRoutes.state, "active")),
      )
      .leftJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .where(
        lockedIds === null
          ? eq(nodes.reachabilityEnabled, true)
          : inArray(nodes.id, lockedIds),
      )
      .orderBy(nodes.name);
    if (nodeRows.length === 0) return [];
    const [policyRow] = await db
      .select({ useBridge: portalPolicy.useBridge })
      .from(portalPolicy)
      .limit(1);
    const globalUseBridge = policyRow?.useBridge ?? false;
    const endpoints = await db
      .select()
      .from(nodeVpnEndpoints)
      .where(and(
        inArray(nodeVpnEndpoints.nodeId, nodeRows.map((node) => node.id)),
        eq(nodeVpnEndpoints.enabled, true),
        eq(nodeVpnEndpoints.reachabilityEnabled, true),
      ))
      .orderBy(nodeVpnEndpoints.ordinal);
    const endpointsByNode = new Map<string, PublicEndpoint[]>();
    for (const endpoint of endpoints) {
      const list = endpointsByNode.get(endpoint.nodeId) ?? [];
      list.push(endpoint);
      endpointsByNode.set(endpoint.nodeId, list);
    }
    const ownerId = await this.serviceAccountId(db);
    const keys = ownerId
      ? await db
          .select()
          .from(vpnKeys)
          .where(and(eq(vpnKeys.ownerId, ownerId), notInArray(vpnKeys.state, ["revoked", "revoking"])))
          .orderBy(desc(vpnKeys.createdAt))
      : [];

    return nodeRows.flatMap((node) =>
      nodeServedProtocols({
        protocol: node.protocol,
        capabilities: node.capabilities,
        enabledProtocols: node.enabledProtocols,
      }).flatMap((protocol): RunTarget[] => {
        const bridgePath = node.bridgeId !== null && node.bridgeName !== null &&
          node.bridgeHost !== null && isIPv4(node.bridgeHost) && node.bridgePort !== null
          ? { bridgeId: node.bridgeId, bridgeName: node.bridgeName, host: node.bridgeHost, port: node.bridgePort }
          : null;
        if (node.bridgeId !== null && protocol === "awg2" && !options.probeDirectWhenBridged) return [];
        const target: RunTarget = {
          targetId: reachabilityTargetId(node.id, protocol, node.endpointRevision),
          nodeId: node.id,
          nodeName: node.name,
          publicIp: node.publicIp ?? node.publicHost,
          protocol,
          endpointRevision: node.endpointRevision,
          bridgePath,
          unavailableReason: null,
          config: null,
          // The node's origin exit IP. Unknown is sent as an explicit null
          // only on a bridged path (reachabilityTask.ts), where the endpoint
          // host is the bridge and no fallback comparison makes sense.
          expectedEgressIp: node.publicIp,
        };
        const key = keys.find((k) => k.nodeId === node.id && k.protocol === protocol);
        if (node.bridgeId !== null && bridgePath === null) {
          return [{ ...target, unavailableReason: BRIDGE_UNRENDERABLE_REASON }];
        }
        if (!key) return [{ ...target, unavailableReason: "no service key yet" }];
        if (key.state === "provisioning") {
          return [{ ...target, unavailableReason: "service key is provisioning" }];
        }
        if (key.state === "failed") {
          return [{
            ...target,
            unavailableReason: `service key failed: ${key.failureReason ?? "unknown"}`.slice(0, 300),
          }];
        }
        if (key.state !== "active" || key.configCiphertext === null) {
          return [{ ...target, unavailableReason: `service key is ${key.state}` }];
        }
        const via = measuredViaBridge(target) ? target.bridgePath : null;
        const endpoints = endpointsByNode.get(node.id) ?? [];
        if (via && endpoints.length === 0 && !options.bridgeMeasurement && !options.probeDirectWhenBridged) {
          return [{ ...target, unavailableReason: BRIDGE_UNSUPPORTED_REASON }];
        }
        const savedConfig = decryptSecret(
          {
            ciphertext: key.configCiphertext,
            nonce: key.configNonce as string,
            authTag: key.configAuthTag as string,
            keyVersion: key.configKeyVersion as number,
          },
          this.options.keyring,
        );
        const config = protocol === "awg3" ? withAwg31TunnelMtu(savedConfig) : savedConfig;
        if (!via && (protocol !== "awg3" || endpoints.length === 0)) return [{ ...target, config }];
        const inspection = inspectAwgVpnLink(config);
        const mayReuseLegacy = options.runStartedAt === undefined || key.updatedAt < options.runStartedAt;
        if (!via) {
          // A reissued service key can have a different port even when the
          // legacy target ID and destination IP are the same.
          return inspection.kind === "awg31"
            ? directNodeTargets({ ...target, config }, endpoints, inspection.endpoint, key.id, mayReuseLegacy)
            : [{ ...target, config }];
        }
        // When public endpoints are configured on a bridged node, probe each
        // endpoint according to its effective bridge policy: bridged endpoints
        // share the node's bridged measurement, while direct endpoints are
        // probed directly at their own IPv4 address.
        if (endpoints.length > 0) {
          const bridgedEndpoints = endpoints.filter(
            (ep) => ep.bridgeMode === "bridge" || (ep.bridgeMode === "inherit" && globalUseBridge),
          );
          const directEndpoints = endpoints.filter(
            (ep) => ep.bridgeMode === "direct" || (ep.bridgeMode === "inherit" && !globalUseBridge),
          );
          if (bridgedEndpoints.length === 0) {
            return inspection.kind === "awg31"
              ? directNodeTargets(
                  { ...target, bridgePath: null, config },
                  directEndpoints,
                  inspection.endpoint,
                  key.id,
                  mayReuseLegacy,
                  true,
                )
              : [{ ...target, bridgePath: null, config }];
          }
          const bridgedEndpointIds = bridgedEndpoints.map((ep) => ep.id);
          const directTargets =
            directEndpoints.length > 0 && inspection.kind === "awg31"
              ? directNodeTargets(
                  { ...target, bridgePath: null, config },
                  directEndpoints,
                  inspection.endpoint,
                  key.id,
                  false,
                  false,
                )
              : [];
          const diagnostics =
            options.probeDirectWhenBridged && inspection.kind === "awg31"
              ? directNodeTargets(
                  { ...target, targetId: `${node.id}:awg3:direct`, diagnostic: true, config },
                  bridgedEndpoints,
                  inspection.endpoint,
                  key.id,
                  false,
                )
              : [];
          if (!options.bridgeMeasurement) {
            return [
              { ...target, bridgedEndpointIds, unavailableReason: BRIDGE_UNSUPPORTED_REASON },
              ...directTargets,
              ...diagnostics,
            ];
          }
          if (inspection.kind !== "awg31") {
            return [
              { ...target, bridgedEndpointIds, unavailableReason: BRIDGE_UNRENDERABLE_REASON },
              ...directTargets,
              ...diagnostics,
            ];
          }
          try {
            return [
              {
                ...target,
                bridgedEndpointIds,
                config: renderAwgEndpointVpnLink(config, { host: via.host, port: via.port }),
              },
              ...directTargets,
              ...diagnostics,
            ];
          } catch {
            return [
              { ...target, bridgedEndpointIds, unavailableReason: BRIDGE_UNRENDERABLE_REASON },
              ...directTargets,
              ...diagnostics,
            ];
          }
        }
        const diagnostics = options.probeDirectWhenBridged && inspection.kind === "awg31"
          ? directNodeTargets(
            { ...target, targetId: `${node.id}:awg3:direct`, diagnostic: true, config },
            endpoints, inspection.endpoint, key.id, false,
          )
          : [];
        if (!options.bridgeMeasurement) {
          return [{ ...target, unavailableReason: BRIDGE_UNSUPPORTED_REASON }, ...diagnostics];
        }
        if (inspection.kind !== "awg31") {
          return [{ ...target, unavailableReason: BRIDGE_UNRENDERABLE_REASON }, ...diagnostics];
        }
        try {
          return [{
            ...target,
            config: renderAwgEndpointVpnLink(config, { host: via.host, port: via.port }),
          }, ...diagnostics];
        } catch {
          return [{ ...target, unavailableReason: BRIDGE_UNRENDERABLE_REASON }, ...diagnostics];
        }
      }),
    );
  };

  syncServiceKeys = async (
    now: Date,
  ): Promise<{ created: number; revoked: number; provisioning: number }> =>
    this.options.db.transaction(async (tx) => {
      if (!(await this.serviceAccountId(tx))) {
        // The address is reserved (the API refuses it for people); if a row
        // with it exists anyway, it becomes the service account.
        await tx
          .insert(users)
          .values({
            email: SERVICE_ACCOUNT_EMAIL,
            displayName: "Reachability probe",
            role: "user",
            serviceAccount: true,
          })
          .onConflictDoUpdate({ target: users.email, set: { serviceAccount: true } });
      }
      const ownerId = (await this.serviceAccountId(tx)) as string;

      const nodeRows = await tx.select().from(nodes);
      const keys = await tx
        .select()
        .from(vpnKeys)
        .where(and(eq(vpnKeys.ownerId, ownerId), notInArray(vpnKeys.state, ["revoked"])))
        .orderBy(desc(vpnKeys.createdAt));

      const wanted = new Set<string>();
      let created = 0;
      let revoked = 0;
      let provisioning = 0;
      const [numbering] = await tx
        .select({ max: sql<number>`coalesce(max(${vpnKeys.keyNumber}), 0)` })
        .from(vpnKeys)
        .where(eq(vpnKeys.ownerId, ownerId));
      let keyNumber = Number(numbering?.max ?? 0);

      for (const node of nodeRows) {
        if (!node.reachabilityEnabled) continue;
        const protocols: ProtocolKind[] = nodeServedProtocols({
          protocol: node.protocol,
          capabilities: node.capabilities,
          enabledProtocols: node.enabledProtocols,
        });
        for (const protocol of protocols) {
          wanted.add(`${node.id}:${protocol}`);
          const mine = keys.filter((k) => k.nodeId === node.id && k.protocol === protocol);
          const live = mine.filter((k) => (LIVE_KEY_STATES as readonly string[]).includes(k.state));
          if (live.length > 0) {
            if (
              live.some(
                (k) =>
                  k.state === "provisioning" &&
                  now.getTime() - k.createdAt.getTime() < PROVISIONING_WAIT_MS,
              )
            ) {
              provisioning += 1;
            }
            continue;
          }
          const newest = mine[0];
          // A node that refused the key (for example, one that is gone) is not
          // asked again every run.
          if (
            newest?.state === "failed" &&
            now.getTime() - newest.updatedAt.getTime() < FAILED_KEY_RETRY_MS
          ) {
            continue;
          }
          // The failed attempts it replaces leave no rows behind: they never
          // reached the node, and a dead node would otherwise collect one per
          // protocol every day.
          const failedIds = mine.filter((k) => k.state === "failed").map((k) => k.id);
          if (failedIds.length > 0) {
            await tx.delete(vpnKeys).where(inArray(vpnKeys.id, failedIds));
          }
          const keyId = randomUUID();
          const labelSecret = decryptSecret(
            {
              ciphertext: node.labelSecretCiphertext,
              nonce: node.labelSecretNonce,
              authTag: node.labelSecretAuthTag,
              keyVersion: node.labelSecretKeyVersion,
            },
            this.options.keyring,
          );
          keyNumber += 1;
          await tx.insert(vpnKeys).values({
            id: keyId,
            ownerId,
            nodeId: node.id,
            nodeLabel: deterministicPeerLabel(keyId, Buffer.from(labelSecret, "base64")),
            protocol,
            state: "provisioning",
            deviceType: "unspecified",
            deviceLabel: "probe",
            keyNumber,
            routeProfile: "full_tunnel",
          });
          await tx.insert(jobOutbox).values({
            type: "vpn-key.provision",
            deduplicationKey: `vpn-key.provision:${keyId}`,
            payload: { keyId },
          });
          await tx.insert(auditEvents).values({
            actorType: "system",
            action: "reachability.key_created",
            targetType: "vpn_key",
            targetId: keyId,
            metadata: { nodeId: node.id, protocol },
          });
          created += 1;
          provisioning += 1;
        }
      }

      const unwanted = keys.filter(
        (k) =>
          (LIVE_KEY_STATES as readonly string[]).includes(k.state) &&
          !wanted.has(`${k.nodeId}:${k.protocol}`),
      );
      for (const key of unwanted) {
        await tx
          .update(vpnKeys)
          .set({ state: "revoking", updatedAt: now })
          .where(eq(vpnKeys.id, key.id));
        await tx.insert(jobOutbox).values({
          type: "vpn-key.revoke",
          deduplicationKey: revokeJobDedupKey(key.id, randomUUID()),
          payload: { keyId: key.id },
        });
        await tx.insert(auditEvents).values({
          actorType: "system",
          action: "reachability.key_revoked",
          targetType: "vpn_key",
          targetId: key.id,
          metadata: { nodeId: key.nodeId, protocol: key.protocol },
        });
        revoked += 1;
      }
      return { created, revoked, provisioning };
    });

  // --- Telegram status widget ------------------------------------------------

  loadWidgetSnapshot = async (now: Date) => {
    const db = this.options.db;
    const [probe] = await db
      .select()
      .from(reachabilityProbe)
      .where(eq(reachabilityProbe.id, 1))
      .limit(1);
    if (!probe || !probe.enabled) return null;

    // Nodes with checks on and a verdict; a deleted node took its state with it.
    const stateRows = await db
      .select({
        nodeId: nodes.id,
        name: nodes.name,
        status: nodeReachabilityState.status,
        failingSince: nodeReachabilityState.failingSince,
      })
      .from(nodeReachabilityState)
      .innerJoin(nodes, eq(nodes.id, nodeReachabilityState.nodeId))
      .where(eq(nodes.reachabilityEnabled, true));
    const nodeIds = stateRows.map((row) => row.nodeId);
    const [resultRows, onlineRows, handshakeRows, bridgedRows, endpointRows] =
      nodeIds.length === 0
        ? [[], [], [], [], []]
        : await Promise.all([
            db
              .select({
                nodeId: nodeReachabilityResults.nodeId,
                protocol: nodeReachabilityResults.protocol,
                status: nodeReachabilityResults.status,
                levels: nodeReachabilityResults.levels,
              })
              .from(nodeReachabilityResults)
              .where(inArray(nodeReachabilityResults.nodeId, nodeIds)),
            // Devices online now, people only: the probe's own keys are not users.
            db
              .select({
                nodeId: vpnKeys.nodeId,
                endpointId: vpnKeys.endpointId,
                online: sql<number>`count(*) filter (where ${peerCurrent.online})`,
              })
              .from(peerCurrent)
              .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
              .innerJoin(users, keyOwnerIsPerson(vpnKeys))
              .where(inArray(vpnKeys.nodeId, nodeIds))
              .groupBy(vpnKeys.nodeId, vpnKeys.endpointId),
            // A person's newest handshake on the node, as on the admin node
            // card. Revoked keys count: a node everyone was moved off keeps
            // saying when people last used it instead of going blank.
            db
              .select({
                nodeId: vpnKeys.nodeId,
                endpointId: vpnKeys.endpointId,
                at: sql<unknown>`max(${peerCurrent.latestHandshakeAt})`,
              })
              .from(peerCurrent)
              .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
              .innerJoin(users, keyOwnerIsPerson(vpnKeys))
              .where(inArray(vpnKeys.nodeId, nodeIds))
              .groupBy(vpnKeys.nodeId, vpnKeys.endpointId),
            // Nodes on a bridge: their verdict is the bridged AWG 3.1 path's.
            db
              .select({ nodeId: vpnBridgeRoutes.nodeId })
              .from(vpnBridgeRoutes)
              .where(
                and(
                  eq(vpnBridgeRoutes.state, "active"),
                  inArray(vpnBridgeRoutes.nodeId, nodeIds),
                ),
              ),
            db
              .select()
              .from(nodeVpnEndpoints)
              .where(inArray(nodeVpnEndpoints.nodeId, nodeIds))
              .orderBy(asc(nodeVpnEndpoints.ordinal), asc(nodeVpnEndpoints.address), asc(nodeVpnEndpoints.id)),
          ]);

    // One protocol's levels per node: the one that worked, else one that was
    // measured, else nothing. A bridged node shows its AWG 3.1 levels only,
    // the ones its verdict comes from.
    const bridged = new Set(bridgedRows.map((row) => row.nodeId));
    const best = new Map<string, { rank: number; levels: ProbeLevels | null }>();
    for (const row of resultRows) {
      if (bridged.has(row.nodeId) && row.protocol !== "awg3") continue;
      const parsed = probeLevelsSchema.safeParse(row.levels);
      const levels = parsed.success ? parsed.data : null;
      const rank = STATUS_RANK[row.status] + (levels ? 0 : 10);
      const current = best.get(row.nodeId);
      if (!current || rank < current.rank) best.set(row.nodeId, { rank, levels });
    }
    const online = new Map<string, number>();
    const onlineByEndpoint = new Map<string, number>();
    for (const row of onlineRows) {
      const count = Number(row.online);
      online.set(row.nodeId, (online.get(row.nodeId) ?? 0) + count);
      const key = `${row.nodeId}:${row.endpointId ?? "primary"}`;
      onlineByEndpoint.set(key, (onlineByEndpoint.get(key) ?? 0) + count);
    }
    // A raw `max(...)` gets no type parser: postgres-js may hand back a string.
    const toDate = (value: unknown): Date | null => {
      if (value instanceof Date) return value;
      if (typeof value !== "string" && typeof value !== "number") return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const laterDate = (a: Date | null | undefined, b: Date | null): Date | null => {
      if (!a) return b;
      if (!b) return a;
      return a.getTime() >= b.getTime() ? a : b;
    };
    const lastHandshake = new Map<string, Date | null>();
    const lastHandshakeByEndpoint = new Map<string, Date | null>();
    for (const row of handshakeRows) {
      const at = toDate(row.at);
      lastHandshake.set(row.nodeId, laterDate(lastHandshake.get(row.nodeId), at));
      const key = `${row.nodeId}:${row.endpointId ?? "primary"}`;
      lastHandshakeByEndpoint.set(key, laterDate(lastHandshakeByEndpoint.get(key), at));
    }
    const endpointsByNode = new Map<string, typeof endpointRows>();
    for (const ep of endpointRows) {
      const list = endpointsByNode.get(ep.nodeId) ?? [];
      list.push(ep);
      endpointsByNode.set(ep.nodeId, list);
    }

    const widgetNodes: WidgetNode[] = stateRows.flatMap((row): WidgetNode[] => {
      const nodeEndpoints = endpointsByNode.get(row.nodeId) ?? [];
      const probed = nodeEndpoints.filter(
        (ep) => ep.enabled && ep.reachabilityEnabled && ep.probeStatus !== null,
      );
      if (!bridged.has(row.nodeId) && nodeEndpoints.length >= 2 && probed.length > 0) {
        return probed.map((ep) => {
          const parsed = probeLevelsSchema.safeParse(ep.probeLevels);
          const epOnline =
            (onlineByEndpoint.get(`${row.nodeId}:${ep.id}`) ?? 0) +
            (ep.ordinal === 1 ? (onlineByEndpoint.get(`${row.nodeId}:primary`) ?? 0) : 0);
          const epHandshake = laterDate(
            lastHandshakeByEndpoint.get(`${row.nodeId}:${ep.id}`),
            ep.ordinal === 1 ? (lastHandshakeByEndpoint.get(`${row.nodeId}:primary`) ?? null) : null,
          );
          return {
            name: ep.name,
            status: ep.probeStatus as ReachabilityStatus,
            levels: parsed.success ? parsed.data : (ep.ordinal === 1 ? (best.get(row.nodeId)?.levels ?? null) : null),
            failingSince: ep.probeFailingSince,
            online: epOnline,
            lastPersonHandshakeAt: epHandshake,
          };
        });
      }
      return [{
        name: row.name,
        status: row.status,
        levels: best.get(row.nodeId)?.levels ?? null,
        failingSince: row.failingSince,
        online: online.get(row.nodeId) ?? 0,
        lastPersonHandshakeAt: lastHandshake.get(row.nodeId) ?? null,
      }];
    });
    const messageRows = await db
      .select()
      .from(reachabilityWidgetMessages)
      .orderBy(asc(reachabilityWidgetMessages.chatId));
    const widget: StoredWidget = {
      sharedId: probe.widgetSharedId,
      version: probe.widgetSharedId === null ? null : probe.widgetVersion,
      messages: messageRows.map((row) => ({
        chatId: row.chatId,
        messageId: row.messageId,
        widgetId: row.widgetId,
        sentAt: row.sentAt,
      })),
    };
    return {
      input: {
        label: probe.label,
        timeZone: probe.timeZone,
        checkedAt: probe.lastResultAt,
        nextAt: probe.currentRunStartedAt
          ? new Date(probe.currentRunStartedAt.getTime() + probe.intervalSec * 1_000)
          : null,
        staleLimitSec: Math.max(probe.staleAfterSec, probe.intervalSec + PROBE_STALE_GRACE_SEC),
        stale:
          probe.staleAlertedAt !== null ||
          isProbeStale({
            now,
            staleAfterSec: probe.staleAfterSec,
            intervalSec: probe.intervalSec,
            lastResultAt: probe.lastResultAt,
            since: probe.enabledAt,
          }),
        mass: probe.lastRunMass,
        nodes: widgetNodes,
      },
      widget,
    };
  };

  saveSharedWidget = async (
    shared: { sharedId: string; version: string },
    message: SentWidgetMessage,
  ): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      await this.updateProbe(
        { widgetSharedId: shared.sharedId, widgetVersion: shared.version, widgetUpdatedAt: message.sentAt },
        tx,
      );
      await this.upsertWidgetMessage(message, tx);
    });
  };

  saveWidgetMessage = async (message: SentWidgetMessage): Promise<void> => {
    await this.upsertWidgetMessage(message);
  };

  deleteWidgetMessage = async (chatId: string): Promise<void> => {
    await this.options.db
      .delete(reachabilityWidgetMessages)
      .where(eq(reachabilityWidgetMessages.chatId, chatId));
  };

  private upsertWidgetMessage = (message: SentWidgetMessage, db: Database | Tx = this.options.db) => {
    const values = {
      messageId: message.messageId,
      widgetId: message.widgetId,
      sentAt: message.sentAt,
    };
    return db
      .insert(reachabilityWidgetMessages)
      .values({ chatId: message.chatId, ...values })
      .onConflictDoUpdate({ target: reachabilityWidgetMessages.chatId, set: values });
  };

  recordWidgetResult = async (at: Date, error: string | null): Promise<void> => {
    await this.updateProbe(
      error === null
        ? { widgetUpdatedAt: at, widgetLastError: null }
        : { widgetLastError: error.slice(0, 300) },
    );
  };
}
