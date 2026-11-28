import { createHash, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";

import {
  bridgePanelDnsHostnameSchema,
  isIpLiteral,
  isIpv4Literal,
  isProbeStale,
  NODE_SYNC_EGRESS_JOB_TYPE,
  nodeRunsCheck,
  nodeServedProtocols,
  probeCapabilityInputOf,
  PROBE_STALE_GRACE_SEC,
  probeLevelsSchema,
  probeRunTargetSchema,
  probeSupportsBridgeMeasurement,
  REACHABILITY_NOTIFY_JOB_TYPE,
  REACHABILITY_WIDGET_JOB_TYPE,
  resolveAwgClientSettings,
  type AwgGeneratorSettings,
  type ProbeBridgeRunTarget,
  type ProbeLevels,
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
  nodeEgressServiceCheckResults,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodeEgressIps,
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
import {
  AwgClientConfigError,
  inspectAwgVpnLink,
  projectAwgClientConfig,
  renderAwgEndpointVpnLink,
  selectAwgClientProfile,
} from "@amnezia/vpn-config";

import type { CandidateOutcome, CandidateRun } from "./bridgeCandidateCheck.js";
import {
  EMPTY_CANDIDATE_SLOT,
  writeCandidateVerification,
} from "./bridgeCandidateRepository.js";
import { bridgeExternalVerdict, bridgeHostTargetId } from "./bridgeReachability.js";
import {
  formatEgressAutoRotateNotice,
  selectAutoRotateExitIp,
  shouldTriggerEgressAutoRotate,
} from "./egressAutoRotate.js";
import {
  alertClock,
  measuredViaBridge,
  reachabilityTargetId,
  type AddressState,
  type NodeState,
  type Notice,
  type ProtocolOutcome,
  type ReachabilityTarget,
  type TargetAddress,
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
const CLIENT_UNRENDERABLE_REASON = "service key client settings could not be applied";
/** A node with registered addresses, none of them enabled with checks on. */
export const NO_CHECKED_ADDRESS_REASON = "no address with checks on";

type ClientProjection = {
  config: string | null;
  fingerprint: string;
  usesLegacyIdentity: boolean;
};

/**
 * The probe measures what an address's ordinary users get: the address and
 * node levels only. User, key and device-type settings are set by hand for
 * particular people and devices and are never measured.
 */
const projectServiceConfig = (
  savedConfig: string,
  key: typeof vpnKeys.$inferSelect,
  node: { awgGenerator: AwgGeneratorSettings | null; awgMtu: number | null },
) => {
  const projections = new Map<string, ClientProjection>();
  return (endpoint?: PublicEndpoint): ClientProjection => {
    const resolved = resolveAwgClientSettings({ address: endpoint, node });
    const generator = resolved.awgGenerator;
    // An MTU set at a level is part of the identity; one that follows the
    // profile or the default is already fixed by it, so those identities
    // stay as they were before the MTU had its own setting.
    const mtu = resolved.mtuFrom === "address" || resolved.mtuFrom === "node" ? resolved.mtu : null;
    const settings = JSON.stringify([generator, mtu]);
    const cached = projections.get(settings);
    if (cached) return cached;
    let config: string | null;
    try {
      config = projectAwgClientConfig(savedConfig, {
        keyId: key.id,
        protocol: key.protocol,
        clientProfile: key.awgClientProfile,
        generator,
        mtu: resolved.mtu,
      });
    } catch (error) {
      if (!(error instanceof AwgClientConfigError)) throw error;
      config = null;
    }
    const projection = {
      config,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(mtu === null
          ? [key.id, key.configNonce, key.awgClientProfile, generator]
          : [key.id, key.configNonce, key.awgClientProfile, generator, { mtu }]))
        .digest("hex"),
      usesLegacyIdentity: generator === null && mtu === null && key.awgClientProfile === null,
    };
    projections.set(settings, projection);
    return projection;
  };
};

const projectedTargetId = (targetId: string, projection: ClientProjection) =>
  projection.usesLegacyIdentity ? targetId : `${targetId}:c${projection.fingerprint}`;

const toTargetAddress = (
  endpoint: PublicEndpoint,
  expectedEgressIp: string | null = null,
): TargetAddress => ({
  id: endpoint.id,
  ordinal: endpoint.ordinal,
  address: endpoint.address,
  name: endpoint.name,
  checkedAt: endpoint.probeCheckedAt,
  expectedEgressIp,
});

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One target per direct address: the service config projected with that
 * address's own profile and rendered for that address. The id fences old
 * replies without putting addresses, labels or key material in the probe's
 * logged target IDs: the prefix carries the node's bridge assignment revision
 * and the digest the address, its revision and the effective profile.
 */
const directAddressTargets = (
  base: RunTarget,
  endpoints: readonly PublicEndpoint[],
  port: number,
  project: ReturnType<typeof projectServiceConfig>,
): RunTarget[] => endpoints.filter((endpoint) => isIpv4Literal(endpoint.address)).map((endpoint) => {
  const projection = project(endpoint);
  let config: string | null = null;
  if (projection.config !== null) {
    try {
      const rendered = renderAwgEndpointVpnLink(projection.config, { host: endpoint.address, port });
      if (probeRunTargetSchema.shape.config.safeParse(rendered).success) config = rendered;
    } catch {
      config = null;
    }
  }
  const expectedEgressIp = isIpLiteral(base.expectedEgressIp ?? "") ? base.expectedEgressIp : null;
  const identity = digest([
    endpoint.id,
    endpoint.revision,
    endpoint.address,
    port,
    projection.fingerprint,
    expectedEgressIp,
  ]);
  return {
    ...base,
    targetId: `${reachabilityTargetId(base.nodeId, "awg3", base.endpointRevision)}:direct:${identity}`,
    config,
    unavailableReason: config === null ? CLIENT_UNRENDERABLE_REASON : null,
    addresses: [toTargetAddress(endpoint, expectedEgressIp)],
    expectedEgressIp,
  };
});

/**
 * Bridged addresses whose projected configs and expected egress IPs are
 * identical share one target rendered for the bridge; each distinct pair is a
 * target of its own.
 */
const bridgedAddressTargets = (
  base: RunTarget,
  endpoints: readonly PublicEndpoint[],
  via: NonNullable<RunTarget["bridgePath"]>,
  project: ReturnType<typeof projectServiceConfig>,
): RunTarget[] => {
  const expectedEgressIp = isIpLiteral(base.expectedEgressIp ?? "") ? base.expectedEgressIp : null;
  const groups = new Map<string, { projection: ClientProjection; endpoints: PublicEndpoint[] }>();
  for (const endpoint of endpoints) {
    const projection = project(endpoint);
    const profile = `${projection.config ?? projection.fingerprint}::${expectedEgressIp ?? ""}`;
    const group = groups.get(profile);
    if (group) group.endpoints.push(endpoint);
    else groups.set(profile, { projection, endpoints: [endpoint] });
  }
  return [...groups.values()].map(({ projection, endpoints: members }) => {
    let config: string | null = null;
    let reason: string | null = CLIENT_UNRENDERABLE_REASON;
    if (projection.config !== null) {
      try {
        config = renderAwgEndpointVpnLink(projection.config, { host: via.host, port: via.port });
        reason = null;
      } catch {
        reason = BRIDGE_UNRENDERABLE_REASON;
      }
    }
    const identity = digest([
      projection.fingerprint,
      [via.bridgeId, via.host, via.port],
      expectedEgressIp,
      members.map(({ id, revision }) => [id, revision]),
    ]);
    return {
      ...base,
      targetId: `${reachabilityTargetId(base.nodeId, "awg3", base.endpointRevision)}:bridge:${identity}`,
      config,
      unavailableReason: reason,
      addresses: members.map((endpoint) => toTargetAddress(endpoint, expectedEgressIp)),
      expectedEgressIp,
    };
  });
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
        probeDirectWhenBridged: claimed.probeDirectWhenBridged,
      });
      const previous = await this.loadStates(tx);
      // Address incidents as stored, read under the node locks like the
      // node states: an address edit takes its node's row lock first.
      const addressIds = [...new Set(targets.flatMap((target) => (target.addresses ?? []).map(({ id }) => id)))];
      const addressRows = addressIds.length > 0
        ? await tx.select().from(nodeVpnEndpoints).where(inArray(nodeVpnEndpoints.id, addressIds))
        : [];
      const previousAddresses = new Map<string, AddressState>(addressRows.map((row) => [row.id, {
        consecutiveFailures: row.probeConsecutiveFailures,
        failingSince: row.probeFailingSince,
        alertedAt: row.probeAlertedAt,
        alertKind: row.probeAlertKind,
      }]));
      const write = await decide({ targets, previous, previousAddresses });

      await this.updateProbe({ staleAlertedAt: write.staleAlertedAt, lastRunMass: write.mass }, tx);

      for (const outcome of write.addressOutcomes) {
        if (!previousAddresses.has(outcome.endpointId)) continue;
        await tx
          .update(nodeVpnEndpoints)
          .set({
            probeStatus: outcome.status,
            probeLevels: outcome.levels ?? null,
            probeCheckedAt: run.now,
            probeConsecutiveFailures: outcome.state.consecutiveFailures,
            probeFailingSince: outcome.state.failingSince,
            probeAlertedAt: outcome.state.alertedAt,
            probeAlertKind: outcome.state.alertKind,
            probeDetail: outcome.detail,
            probeObservedEgressIp: outcome.observedEgressIp ?? null,
            probeEgressMatch: outcome.egressMatch ?? null,
          })
          .where(eq(nodeVpnEndpoints.id, outcome.endpointId));
      }

      const rotationNotices: Notice[] = [];
      const rotatedNodeIds = new Set<string>();
      const outcomeByEndpointId = new Map(
        write.addressOutcomes.map((outcome) => [outcome.endpointId, outcome]),
      );
      const addressRowById = new Map(addressRows.map((row) => [row.id, row]));
      const candidateEndpointIds = write.mass
        ? []
        : addressRows
            .filter((row) => {
              if (!row.enabled || !row.egressAutoRotateEnabled) return false;
              const outcome = outcomeByEndpointId.get(row.id);
              return (
                outcome?.status === "failed" && outcome.state.alertedAt !== null
              );
            })
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((row) => row.id);

      if (candidateEndpointIds.length > 0) {
        const affectedNodeIds = [
          ...new Set(
            candidateEndpointIds
              .map((id) => addressRowById.get(id)?.nodeId)
              .filter((id): id is string => Boolean(id)),
          ),
        ];
        const [affectedNodes, allNodeEndpoints, allNodeExits, failingCheckRows] =
          await Promise.all([
            tx
              .select({
                id: nodes.id,
                name: nodes.name,
                egressMode: nodes.egressMode,
                egressDefaultIpId: nodes.egressDefaultIpId,
                checksEnabled: nodes.checksEnabled,
                disabledCheckIds: nodes.disabledCheckIds,
              })
              .from(nodes)
              .where(inArray(nodes.id, affectedNodeIds)),
            tx
              .select({
                id: nodeVpnEndpoints.id,
                nodeId: nodeVpnEndpoints.nodeId,
                ordinal: nodeVpnEndpoints.ordinal,
                name: nodeVpnEndpoints.name,
                address: nodeVpnEndpoints.address,
                egressIpId: nodeVpnEndpoints.egressIpId,
                enabled: nodeVpnEndpoints.enabled,
                egressAutoRotateEnabled: nodeVpnEndpoints.egressAutoRotateEnabled,
                egressAutoRotatePoolIds: nodeVpnEndpoints.egressAutoRotatePoolIds,
                egressAutoRotatedAt: nodeVpnEndpoints.egressAutoRotatedAt,
                probeStatus: nodeVpnEndpoints.probeStatus,
                probeAlertedAt: nodeVpnEndpoints.probeAlertedAt,
              })
              .from(nodeVpnEndpoints)
              .where(inArray(nodeVpnEndpoints.nodeId, affectedNodeIds)),
            tx
              .select({
                id: nodeEgressIps.id,
                nodeId: nodeEgressIps.nodeId,
                ipv4: nodeEgressIps.ipv4,
                label: nodeEgressIps.label,
                enabled: nodeEgressIps.enabled,
                hostState: nodeEgressIps.hostState,
              })
              .from(nodeEgressIps)
              .where(inArray(nodeEgressIps.nodeId, affectedNodeIds))
              .orderBy(asc(nodeEgressIps.routingTableId), asc(nodeEgressIps.ipv4)),
            tx
              .select({
                nodeId: nodeEgressIps.nodeId,
                egressIpId: nodeEgressServiceCheckResults.egressIpId,
                checkId: nodeEgressServiceCheckResults.checkId,
              })
              .from(nodeEgressServiceCheckResults)
              .innerJoin(
                nodeEgressIps,
                eq(nodeEgressIps.id, nodeEgressServiceCheckResults.egressIpId),
              )
              .where(
                and(
                  inArray(nodeEgressIps.nodeId, affectedNodeIds),
                  eq(nodeEgressServiceCheckResults.status, "failed"),
                ),
              ),
          ]);

        const affectedNodeById = new Map(affectedNodes.map((n) => [n.id, n]));
        const exitsByNode = new Map<string, typeof allNodeExits>();
        for (const exitRow of allNodeExits) {
          const list = exitsByNode.get(exitRow.nodeId) ?? [];
          list.push(exitRow);
          exitsByNode.set(exitRow.nodeId, list);
        }

        const failingCheckExitsByNode = new Map<string, Set<string>>();
        for (const checkRow of failingCheckRows) {
          const node = affectedNodeById.get(checkRow.nodeId);
          if (!node || !nodeRunsCheck(node, checkRow.checkId)) continue;
          const set = failingCheckExitsByNode.get(checkRow.nodeId) ?? new Set<string>();
          set.add(checkRow.egressIpId);
          failingCheckExitsByNode.set(checkRow.nodeId, set);
        }

        const siblingExitByGroup = new Map<string, Map<string, string | null>>();
        const unhealthyExitsByNode = new Map<string, Set<string>>();
        for (const ep of allNodeEndpoints) {
          const groupKey = `${ep.nodeId}:${ep.address}`;
          const group = siblingExitByGroup.get(groupKey) ?? new Map<string, string | null>();
          group.set(ep.id, ep.egressIpId ?? null);
          siblingExitByGroup.set(groupKey, group);

          const node = affectedNodeById.get(ep.nodeId);
          const epOutcome = outcomeByEndpointId.get(ep.id);
          const isUnhealthy =
            epOutcome?.status === "failed" ||
            (!epOutcome && ep.probeStatus === "failed" && ep.probeAlertedAt !== null);
          if (isUnhealthy && node) {
            const effectiveExitId = ep.egressIpId ?? node.egressDefaultIpId ?? null;
            if (effectiveExitId) {
              const set = unhealthyExitsByNode.get(ep.nodeId) ?? new Set<string>();
              set.add(effectiveExitId);
              unhealthyExitsByNode.set(ep.nodeId, set);
            }
          }
        }

        for (const epId of candidateEndpointIds) {
          const ep = addressRowById.get(epId);
          const outcome = outcomeByEndpointId.get(epId);
          if (!ep || !outcome) continue;
          const node = affectedNodeById.get(ep.nodeId);
          if (!node) continue;
          if (
            !shouldTriggerEgressAutoRotate({
              massFailure: write.mass,
              nodeEgressMode: node.egressMode,
              endpoint: ep,
              outcome,
              failThreshold: claimed.failThreshold,
              now: run.now,
            })
          ) {
            continue;
          }

          const groupKey = `${ep.nodeId}:${ep.address}`;
          const siblingMap = siblingExitByGroup.get(groupKey) ?? new Map<string, string | null>();
          const occupiedSiblingExitIds = new Set<string>();
          for (const [sibId, exitId] of siblingMap) {
            if (sibId !== ep.id && exitId) occupiedSiblingExitIds.add(exitId);
          }

          const selection = selectAutoRotateExitIp({
            endpoint: {
              id: ep.id,
              address: ep.address,
              egressIpId: ep.egressIpId ?? null,
              egressAutoRotatePoolIds: ep.egressAutoRotatePoolIds ?? [],
            },
            nodeEgressDefaultIpId: node.egressDefaultIpId ?? null,
            nodeExits: exitsByNode.get(ep.nodeId) ?? [],
            occupiedSiblingExitIds,
            failingExitCheckIds: failingCheckExitsByNode.get(ep.nodeId) ?? new Set<string>(),
            unhealthyEndpointExitIds: unhealthyExitsByNode.get(ep.nodeId) ?? new Set<string>(),
          });
          if (!selection) continue;

          siblingMap.set(ep.id, selection.nextExit.id);
          await tx
            .update(nodeVpnEndpoints)
            .set({
              egressIpId: selection.nextExit.id,
              egressAutoRotatedAt: run.now,
              revision: sql`${nodeVpnEndpoints.revision} + 1`,
              probeStatus: null,
              probeLevels: null,
              probeCheckedAt: null,
              probeConsecutiveFailures: 0,
              probeFailingSince: null,
              probeObservedEgressIp: null,
              probeEgressMatch: null,
              probeDetail: "auto-rotated exit IP; waiting for measurement",
            })
            .where(eq(nodeVpnEndpoints.id, ep.id));
          await tx.insert(auditEvents).values({
            actorType: "system",
            action: "node.endpoint_egress_auto_rotated",
            targetType: "node",
            targetId: ep.nodeId,
            metadata: {
              endpointId: ep.id,
              address: ep.address,
              previousExitIpId: selection.previousExit?.id ?? null,
              previousExitIpv4: selection.previousExit?.ipv4 ?? null,
              nextExitIpId: selection.nextExit.id,
              nextExitIpv4: selection.nextExit.ipv4,
              runId: run.runId,
            },
          });
          rotationNotices.push({
            dedupKey: `${REACHABILITY_NOTIFY_JOB_TYPE}:egress-auto-rotate:${ep.id}:${run.runId}`,
            text: formatEgressAutoRotateNotice({
              nodeName: node.name,
              endpointName: ep.name,
              address: ep.address,
              previousExit: selection.previousExit,
              nextExit: selection.nextExit,
            }),
          });
          rotatedNodeIds.add(ep.nodeId);
        }

        if (rotatedNodeIds.size > 0) {
          await tx.insert(jobOutbox).values(
            [...rotatedNodeIds].map((nodeId) => ({
              type: NODE_SYNC_EGRESS_JOB_TYPE,
              deduplicationKey: `${NODE_SYNC_EGRESS_JOB_TYPE}:${nodeId}:${randomUUID()}`,
              payload: { nodeId },
            })),
          );
          await tx
            .update(reachabilityProbe)
            .set({ runRequestedAt: run.now, updatedAt: new Date() })
            .where(eq(reachabilityProbe.id, 1));
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
          // The widget keeps a row per address on a node judged by them.
          addressBased: targets.some((target) =>
            target.nodeId === nodeId && !target.diagnostic && target.addresses !== undefined),
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

      if (rotatedNodeIds.size > 0) {
        await tx
          .delete(nodeReachabilityResults)
          .where(
            and(
              inArray(nodeReachabilityResults.nodeId, [...rotatedNodeIds]),
              eq(nodeReachabilityResults.protocol, "awg3"),
            ),
          );
      }

      const bridgeNotices = await this.writeBridgeProbeStates(tx, run, targets, write.outcomes, claimed);
      const notices = [...write.notices, ...bridgeNotices, ...rotationNotices];
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
    // A node's AWG 3 row is its bridge path evidence while it has an active
    // route (the best bridged measurement), counted once per node.
    const awgByBridge = new Map<string, ProtocolOutcome[]>();
    const counted = new Set<string>();
    for (const target of targets) {
      const bridgeId = target.bridgePath?.bridgeId;
      // A node with no address checked has no evidence about the bridge.
      if (!bridgeId || !measuredViaBridge(target) || counted.has(target.nodeId) ||
        target.unavailableReason === NO_CHECKED_ADDRESS_REASON) continue;
      const outcome = awgByNode.get(target.nodeId);
      if (!outcome) continue;
      counted.add(target.nodeId);
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
    options: { lock: boolean; bridgeMeasurement: boolean; probeDirectWhenBridged?: boolean },
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
        egressMode: nodes.egressMode,
        egressDefaultIpId: nodes.egressDefaultIpId,
        awgGenerator: nodes.awgGenerator,
        awgMtu: nodes.awgMtu,
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
    const nodeIds = nodeRows.map((node) => node.id);
    const [policyRow] = await db
      .select({ useBridge: portalPolicy.useBridge })
      .from(portalPolicy)
      .limit(1);
    const globalUseBridge = policyRow?.useBridge ?? false;
    const [endpoints, egressRows] = await Promise.all([
      db
        .select()
        .from(nodeVpnEndpoints)
        // Every registered address, so a node whose addresses all have checks
        // off is told apart from one that has none.
        .where(inArray(nodeVpnEndpoints.nodeId, nodeIds))
        .orderBy(nodeVpnEndpoints.ordinal),
      db.select().from(nodeEgressIps).where(inArray(nodeEgressIps.nodeId, nodeIds)),
    ]);
    const egressById = new Map(egressRows.map((row) => [row.id, row]));
    const endpointById = new Map(endpoints.map((ep) => [ep.id, ep]));
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

    const resolveEndpointExpectedEgress = (
      node: (typeof nodeRows)[number],
      endpoint: PublicEndpoint,
      defaultExitIpv4: string | null,
    ): string | null => {
      if (node.egressMode !== "routed") return node.publicIp;
      const exitId = endpoint.egressIpId ?? node.egressDefaultIpId ?? null;
      if (exitId) return egressById.get(exitId)?.ipv4 ?? defaultExitIpv4;
      return isIPv4(endpoint.address) ? endpoint.address : node.publicIp;
    };

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
        const defaultBucketId = node.egressMode === "routed" ? (node.egressDefaultIpId ?? null) : null;
        const defaultExitIpv4 =
          defaultBucketId ? (egressById.get(defaultBucketId)?.ipv4 ?? node.publicIp) : node.publicIp;
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
          // The node's default exit IP. Unknown is sent as an explicit null
          // only on a bridged path (reachabilityTask.ts), where the endpoint
          // host is the bridge and no fallback comparison makes sense.
          expectedEgressIp: defaultExitIpv4,
        };
        const registered = endpointsByNode.get(node.id) ?? [];
        const checked = protocol === "awg3"
          ? registered.filter((endpoint) => endpoint.enabled && endpoint.reachabilityEnabled)
          : [];
        // When the probe cannot look at the node at all, every address with
        // checks on reads unknown for that reason instead of its last verdict.
        const checkedAddresses = checked.map((endpoint) =>
          toTargetAddress(endpoint, resolveEndpointExpectedEgress(node, endpoint, defaultExitIpv4)),
        );
        const unavailable = (
          baseTarget: RunTarget,
          reason: string,
          addresses: TargetAddress[],
        ): RunTarget[] => [{
          ...baseTarget,
          unavailableReason: reason,
          ...(addresses.length > 0 ? { addresses } : {}),
        }];
        if (node.bridgeId !== null && bridgePath === null) {
          return unavailable(target, BRIDGE_UNRENDERABLE_REASON, checkedAddresses);
        }

        const via = measuredViaBridge(target) ? target.bridgePath : null;
        if (protocol === "awg3" && registered.length > 0 && checked.length > 0) {
          const nodeAwg3Keys = keys.filter((k) => k.nodeId === node.id && k.protocol === "awg3");
          const primaryEndpoint = registered.find((ep) => ep.ordinal === 1);
          const buckets = new Map<
            string,
            {
              bucketId: string | null;
              bKey: string;
              expectedEgressIp: string | null;
              disabledExit: boolean;
              endpoints: PublicEndpoint[];
            }
          >();
          for (const endpoint of checked) {
            const explicitExit = endpoint.egressIpId ? egressById.get(endpoint.egressIpId) : undefined;
            const disabledExit = node.egressMode === "routed" && explicitExit !== undefined && !explicitExit.enabled;
            const bucketId = node.egressMode === "routed" ? (endpoint.egressIpId ?? defaultBucketId) : null;
            const expectedEgressIp = resolveEndpointExpectedEgress(node, endpoint, defaultExitIpv4);
            const bKey =
              node.egressMode !== "routed"
                ? "__default__"
                : (bucketId ?? `implicit:${expectedEgressIp ?? endpoint.id}`);
            const bucket = buckets.get(bKey);
            if (bucket) {
              bucket.endpoints.push(endpoint);
              if (disabledExit) bucket.disabledExit = true;
            } else {
              buckets.set(bKey, {
                bucketId,
                bKey,
                expectedEgressIp,
                disabledExit,
                endpoints: [endpoint],
              });
            }
          }

          return [...buckets.values()].flatMap(({ bucketId, bKey, expectedEgressIp, disabledExit, endpoints: bucketEndpoints }) => {
            const bucketTarget: RunTarget = { ...target, expectedEgressIp };
            const bucketAddresses = bucketEndpoints.map((ep) => toTargetAddress(ep, expectedEgressIp));
            if (disabledExit) {
              return unavailable(bucketTarget, "assigned exit IP is disabled", bucketAddresses);
            }
            const matchesBucketKey = (k: (typeof nodeAwg3Keys)[number]): boolean => {
              const keyEp = k.endpointId ? endpointById.get(k.endpointId) : primaryEndpoint;
              if (keyEp && !keyEp.enabled) return false;
              const keyExitId = keyEp?.egressIpId ?? defaultBucketId;
              if (bucketId !== null) {
                return keyExitId === bucketId;
              }
              if (keyExitId !== null) return false;
              const keyImplicitIp =
                keyEp && isIPv4(keyEp.address) ? keyEp.address : node.publicIp;
              return `implicit:${keyImplicitIp ?? keyEp?.id ?? "default"}` === bKey;
            };
            const bucketKey =
              node.egressMode !== "routed"
                ? (nodeAwg3Keys.find((k) => k.endpointId === null) ?? nodeAwg3Keys[0])
                : nodeAwg3Keys.find(matchesBucketKey);

            if (!bucketKey) return unavailable(bucketTarget, "no service key yet", bucketAddresses);
            if (bucketKey.state === "provisioning") {
              return unavailable(bucketTarget, "service key is provisioning", bucketAddresses);
            }
            if (bucketKey.state === "failed") {
              return unavailable(
                bucketTarget,
                `service key failed: ${bucketKey.failureReason ?? "unknown"}`.slice(0, 300),
                bucketAddresses,
              );
            }
            if (bucketKey.state !== "active" || bucketKey.configCiphertext === null) {
              return unavailable(bucketTarget, `service key is ${bucketKey.state}`, bucketAddresses);
            }

            const savedConfig = decryptSecret(
              {
                ciphertext: bucketKey.configCiphertext,
                nonce: bucketKey.configNonce as string,
                authTag: bucketKey.configAuthTag as string,
                keyVersion: bucketKey.configKeyVersion as number,
              },
              this.options.keyring,
            );
            const inspection = inspectAwgVpnLink(savedConfig);
            const project = projectServiceConfig(savedConfig, bucketKey, node);
            if (inspection.kind === "awg31") {
              const bridged = via
                ? bucketEndpoints.filter((endpoint) =>
                    endpoint.bridgeMode === "bridge" ||
                    (endpoint.bridgeMode === "inherit" && globalUseBridge))
                : [];
              const port = inspection.endpoint.port;
              const directTargets = directAddressTargets(
                { ...bucketTarget, bridgePath: null, ...(via ? { nodeBridged: true as const } : {}) },
                bucketEndpoints.filter((endpoint) => !bridged.includes(endpoint)),
                port,
                project,
              );
              if (!via || bridged.length === 0) return directTargets;
              const diagnostics = options.probeDirectWhenBridged
                ? directAddressTargets(
                    { ...bucketTarget, diagnostic: true as const },
                    bridged,
                    port,
                    project,
                  )
                : [];
              if (!options.bridgeMeasurement) {
                return [{
                  ...bucketTarget,
                  targetId: `${bucketTarget.targetId}:bridge:${expectedEgressIp ?? "default"}`,
                  unavailableReason: BRIDGE_UNSUPPORTED_REASON,
                  addresses: bridged.map((ep) => toTargetAddress(ep, expectedEgressIp)),
                }, ...directTargets, ...diagnostics];
              }
              return [
                ...bridgedAddressTargets(bucketTarget, bridged, via, project),
                ...directTargets,
                ...diagnostics,
              ];
            }

            // Fallback when stored service key cannot be parsed per endpoint.
            const { config } = project();
            const configuredTarget = {
              ...bucketTarget,
              config,
              unavailableReason: config === null ? CLIENT_UNRENDERABLE_REASON : null,
            };
            if (!via) return [configuredTarget];
            return [{ ...bucketTarget, unavailableReason: BRIDGE_UNRENDERABLE_REASON }];
          });
        }

        const key =
          keys.find((k) => k.nodeId === node.id && k.protocol === protocol && k.endpointId === null) ??
          keys.find((k) => k.nodeId === node.id && k.protocol === protocol);
        if (!key) return unavailable(target, "no service key yet", checkedAddresses);
        if (key.state === "provisioning") {
          return unavailable(target, "service key is provisioning", checkedAddresses);
        }
        if (key.state === "failed") {
          return unavailable(
            target,
            `service key failed: ${key.failureReason ?? "unknown"}`.slice(0, 300),
            checkedAddresses,
          );
        }
        if (key.state !== "active" || key.configCiphertext === null) {
          return unavailable(target, `service key is ${key.state}`, checkedAddresses);
        }
        if (via && registered.length === 0 && !options.bridgeMeasurement && !options.probeDirectWhenBridged) {
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
        if (protocol !== "awg3") return [{ ...target, config: savedConfig }];
        const inspection = inspectAwgVpnLink(savedConfig);
        const project = projectServiceConfig(savedConfig, key, node);
        if (registered.length > 0 && inspection.kind === "awg31") {
          return [{ ...target, unavailableReason: NO_CHECKED_ADDRESS_REASON }];
        }
        // A node without registered addresses, or an artifact that cannot be
        // rendered per address: the node target, from the service key.
        // rendered per address: the node target, from the service key.
        const projection = project();
        const { config } = projection;
        const configuredTarget = {
          ...target,
          targetId: inspection.kind === "awg31" ? projectedTargetId(target.targetId, projection) : target.targetId,
          config,
          unavailableReason: config === null ? CLIENT_UNRENDERABLE_REASON : null,
        };
        if (!via) return [configuredTarget];
        const diagnostics = options.probeDirectWhenBridged && inspection.kind === "awg31"
          ? [{ ...configuredTarget, targetId: `${node.id}:awg3:direct`, diagnostic: true as const }]
          : [];
        if (!options.bridgeMeasurement) {
          return [{ ...target, unavailableReason: BRIDGE_UNSUPPORTED_REASON }, ...diagnostics];
        }
        if (inspection.kind !== "awg31") {
          return [{ ...target, unavailableReason: BRIDGE_UNRENDERABLE_REASON }, ...diagnostics];
        }
        if (config === null) return [configuredTarget, ...diagnostics];
        try {
          return [{
            ...configuredTarget,
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

      const [nodeRows, endpointRows, egressRows, keys] = await Promise.all([
        tx.select().from(nodes),
        tx
          .select()
          .from(nodeVpnEndpoints)
          .orderBy(asc(nodeVpnEndpoints.ordinal), asc(nodeVpnEndpoints.id)),
        tx.select().from(nodeEgressIps).where(eq(nodeEgressIps.enabled, true)),
        tx
          .select()
          .from(vpnKeys)
          .where(and(eq(vpnKeys.ownerId, ownerId), notInArray(vpnKeys.state, ["revoked"])))
          .orderBy(desc(vpnKeys.createdAt)),
      ]);
      const endpointById = new Map(endpointRows.map((ep) => [ep.id, ep]));
      const endpointsByNode = new Map<string, PublicEndpoint[]>();
      for (const ep of endpointRows) {
        const list = endpointsByNode.get(ep.nodeId) ?? [];
        list.push(ep);
        endpointsByNode.set(ep.nodeId, list);
      }
      const validExitIds = new Set(egressRows.map((row) => row.id));

      const keptLiveKeyIds = new Set<string>();
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
        const labelSecret = decryptSecret(
          {
            ciphertext: node.labelSecretCiphertext,
            nonce: node.labelSecretNonce,
            authTag: node.labelSecretAuthTag,
            keyVersion: node.labelSecretKeyVersion,
          },
          this.options.keyring,
        );
        const nodeEndpoints = endpointsByNode.get(node.id) ?? [];
        const primaryEndpoint = nodeEndpoints.find((ep) => ep.ordinal === 1);
        const defaultBucketId =
          node.egressDefaultIpId && validExitIds.has(node.egressDefaultIpId)
            ? node.egressDefaultIpId
            : null;
        const primaryImplicitIp =
          primaryEndpoint && isIPv4(primaryEndpoint.address) ? primaryEndpoint.address : node.publicIp;
        const defaultBucketKey =
          defaultBucketId ?? `implicit:${primaryImplicitIp ?? primaryEndpoint?.id ?? "default"}`;

        for (const protocol of protocols) {
          const isRoutedAwg3 = protocol === "awg3" && node.egressMode === "routed";
          const desiredBuckets: Array<{ bucketKey: string; representativeEndpointId: string | null }> = [];
          if (isRoutedAwg3) {
            const seenBuckets = new Set<string>();
            const checked = nodeEndpoints.filter(
              (ep) => ep.enabled && ep.reachabilityEnabled,
            );
            for (const ep of checked) {
              const exitId = ep.egressIpId && validExitIds.has(ep.egressIpId)
                ? ep.egressIpId
                : defaultBucketId;
              const expectedIp = isIPv4(ep.address) ? ep.address : node.publicIp;
              const bKey = exitId ?? `implicit:${expectedIp ?? ep.id}`;
              if (seenBuckets.has(bKey)) continue;
              seenBuckets.add(bKey);
              desiredBuckets.push({
                bucketKey: bKey,
                // Always pin routed probe keys to an enabled checked endpoint so
                // ordinal=1 exit mismatch or disabled siblings never misroute probes.
                representativeEndpointId: ep.id,
              });
            }
            if (desiredBuckets.length === 0) {
              desiredBuckets.push({ bucketKey: defaultBucketKey, representativeEndpointId: null });
            }
          } else {
            desiredBuckets.push({ bucketKey: "__single__", representativeEndpointId: null });
          }

          const mine = keys.filter((k) => k.nodeId === node.id && k.protocol === protocol);
          const firstLiveSingle = mine.find(
            (k) => k.endpointId === null && (LIVE_KEY_STATES as readonly string[]).includes(k.state),
          ) ?? mine.find((k) => (LIVE_KEY_STATES as readonly string[]).includes(k.state));
          const bucketOfKey = (key: typeof vpnKeys.$inferSelect): string => {
            if (!isRoutedAwg3) {
              if (key.endpointId === null) return "__single__";
              return firstLiveSingle?.id === key.id ? "__single__" : `extra:${key.id}`;
            }
            const keyEp = key.endpointId ? endpointById.get(key.endpointId) : primaryEndpoint;
            if (!keyEp || !keyEp.enabled) return "__disabled_ep__";
            const epExit = keyEp.egressIpId ?? null;
            const resolved = epExit && validExitIds.has(epExit) ? epExit : defaultBucketId;
            if (resolved) return resolved;
            const expectedIp = isIPv4(keyEp.address) ? keyEp.address : node.publicIp;
            return `implicit:${expectedIp ?? keyEp.id}`;
          };

          for (const { bucketKey, representativeEndpointId } of desiredBuckets) {
            const bucketKeys = mine.filter((k) => bucketOfKey(k) === bucketKey);
            const live = bucketKeys.filter((k) =>
              (LIVE_KEY_STATES as readonly string[]).includes(k.state),
            );
            if (live.length > 0) {
              const primary =
                (representativeEndpointId === null
                  ? live.find((k) => k.endpointId === null)
                  : undefined) ?? live[0]!;
              keptLiveKeyIds.add(primary.id);
              if (
                primary.state === "provisioning" &&
                now.getTime() - primary.createdAt.getTime() < PROVISIONING_WAIT_MS
              ) {
                provisioning += 1;
              }
              continue;
            }
            const newest = bucketKeys[0];
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
            const failedIds = bucketKeys.filter((k) => k.state === "failed").map((k) => k.id);
            if (failedIds.length > 0) {
              await tx.delete(vpnKeys).where(inArray(vpnKeys.id, failedIds));
            }
            const keyId = randomUUID();
            keptLiveKeyIds.add(keyId);
            keyNumber += 1;
            await tx.insert(vpnKeys).values({
              id: keyId,
              endpointId: representativeEndpointId,
              ownerId,
              nodeId: node.id,
              nodeLabel: deterministicPeerLabel(keyId, Buffer.from(labelSecret, "base64")),
              protocol,
              state: "provisioning",
              deviceType: "unspecified",
              deviceLabel: "probe",
              keyNumber,
              routeProfile: "full_tunnel",
              awgClientProfile: protocol === "awg3" ? selectAwgClientProfile(1) : null,
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
              metadata: { nodeId: node.id, protocol, endpointId: representativeEndpointId },
            });
            created += 1;
            provisioning += 1;
          }
        }
      }

      const unwanted = keys.filter(
        (k) =>
          (LIVE_KEY_STATES as readonly string[]).includes(k.state) &&
          !keptLiveKeyIds.has(k.id),
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
        addressBased: nodeReachabilityState.addressBased,
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
      // Every address is its own server: one row per address with checks on
      // when the latest run judged the node by its addresses, bridged nodes
      // too. An address waiting for its check after a change reads unknown.
      // A node without registered addresses or with a legacy artifact keeps
      // its node row.
      const checked = row.addressBased
        ? (endpointsByNode.get(row.nodeId) ?? []).filter((ep) => ep.enabled && ep.reachabilityEnabled)
        : [];
      if (checked.length > 0) {
        return checked.map((ep) => {
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
            entryGroup: `${row.nodeId}:${ep.address}`,
            entryName: ep.entryName || ep.name,
            status: ep.probeStatus ?? "error",
            // Its own levels only: the node's best row may be the bridge path.
            levels: parsed.success ? parsed.data : null,
            egressMatch: ep.probeEgressMatch,
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
      version: probe.widgetVersion,
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

  saveWidgetGeneration = async (
    generation: { sharedId: string | null; version: string },
    message: SentWidgetMessage,
  ): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      await this.updateProbe(
        { widgetSharedId: generation.sharedId, widgetVersion: generation.version, widgetUpdatedAt: message.sentAt },
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
