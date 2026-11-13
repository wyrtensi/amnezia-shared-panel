import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";

import {
  isProbeStale,
  nodeServedProtocols,
  probeCapabilityInputOf,
  PROBE_STALE_GRACE_SEC,
  probeLevelsSchema,
  probeSupportsBridgeMeasurement,
  REACHABILITY_NOTIFY_JOB_TYPE,
  REACHABILITY_WIDGET_JOB_TYPE,
  type ProbeLevels,
  revokeJobDedupKey,
  type ProtocolKind,
} from "@amnezia/contracts";
import {
  auditEvents,
  decryptSecret,
  deterministicPeerLabel,
  jobOutbox,
  keyOwnerIsPerson,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodes,
  peerCurrent,
  reachabilityProbe,
  SERVICE_ACCOUNT_EMAIL,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";
import { inspectAwgVpnLink, renderAwgEndpointVpnLink } from "@amnezia/vpn-config";

import type { CandidateOutcome, CandidateRun } from "./bridgeCandidateCheck.js";
import {
  EMPTY_CANDIDATE_SLOT,
  writeCandidateVerification,
} from "./bridgeCandidateRepository.js";
import {
  measuredViaBridge,
  reachabilityTargetId,
  type NodeState,
  type Notice,
} from "./reachability.js";
import type { WidgetNode } from "./reachabilityWidget.js";
import type { ReachabilityWidgetStore, StoredWidget } from "./reachabilityWidgetSender.js";
import type {
  CandidateSettle,
  IngestDecide,
  IngestRun,
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

const outboxRows = (notices: readonly Notice[]) =>
  notices.map((notice) => ({
    type: REACHABILITY_NOTIFY_JOB_TYPE,
    deduplicationKey: notice.dedupKey,
    payload: { text: notice.text },
  }));

/** A widget refresh; completed rows keep their key, so each trigger is unique. */
const widgetRow = (trigger: string) => ({
  type: REACHABILITY_WIDGET_JOB_TYPE,
  deduplicationKey: `${REACHABILITY_WIDGET_JOB_TYPE}:${trigger}`,
  payload: {},
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
      apiKey: decryptSecret(
        {
          ciphertext: row.credentialsCiphertext,
          nonce: row.credentialsNonce,
          authTag: row.credentialsAuthTag,
          keyVersion: row.credentialsKeyVersion,
        },
        this.options.keyring,
      ),
      enabled: row.enabled,
      controlUrl: row.controlUrl,
      egressUrl: row.egressUrl,
      intervalSec: row.intervalSec,
      failThreshold: row.failThreshold,
      staleAfterSec: row.staleAfterSec,
      runRequestedAt: row.runRequestedAt,
      currentRunId: row.currentRunId,
      currentRunStartedAt: row.currentRunStartedAt,
      lastResultAt: row.lastResultAt,
      lastIngestedRunId: row.lastIngestedRunId,
      staleAlertedAt: row.staleAlertedAt,
      enabledAt: row.enabledAt,
      timeZone: row.timeZone,
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

  markRunStarted = async (runId: string, at: Date): Promise<void> => {
    // Only over an empty slot: a second worker must not overwrite a run in
    // flight with one the probe refused.
    await this.options.db
      .update(reachabilityProbe)
      .set({ currentRunId: runId, currentRunStartedAt: at, updatedAt: new Date() })
      .where(and(eq(reachabilityProbe.id, 1), isNull(reachabilityProbe.currentRunId)));
  };

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
        });
      if (!claimed) return false;

      // The capability as it stood when the run was dispatched: a bridged
      // target that did go out is not discarded because the record aged
      // since, and one that could not go out reads unknown.
      const bridgeMeasurement = probeSupportsBridgeMeasurement(
        probeCapabilityInputOf(claimed.capabilities, claimed.capabilitiesCheckedAt),
        claimed.currentRunStartedAt ?? run.now,
      );
      const targets = await this.loadTargets(tx, { lock: true, bridgeMeasurement });
      const previous = await this.loadStates(tx);
      const write = await decide({ targets, previous });

      await this.updateProbe({ staleAlertedAt: write.staleAlertedAt, lastRunMass: write.mass }, tx);

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
              // A failure streak keeps its start (an older row without one
              // falls back to its own check time); a non-failed result clears it.
              set: {
                ...values,
                failingSince:
                  outcome.status === "failed"
                    ? sql`case when ${nodeReachabilityResults.status} = 'failed'
                        then coalesce(${nodeReachabilityResults.failingSince}, ${nodeReachabilityResults.checkedAt})
                        else excluded.checked_at end`
                    : null,
              },
            });
        }

        const state = write.states.get(nodeId);
        if (!state) continue;
        const stateValues = {
          nodeId,
          status: state.status,
          consecutiveFailures: state.consecutiveFailures,
          failingSince: state.failingSince,
          alertedAt: state.alertedAt,
          alertKind: state.alertKind,
          checkedAt: run.now,
          detail: state.detail,
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

      if (write.notices.length > 0) {
        await tx.insert(jobOutbox).values(outboxRows(write.notices)).onConflictDoNothing();
      }
      await tx.insert(jobOutbox).values(widgetRow(`run:${run.runId}`)).onConflictDoNothing();
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

  listTargets = async (options: { bridgeMeasurement: boolean }): Promise<RunTarget[]> =>
    this.loadTargets(this.options.db, { lock: false, ...options });

  /**
   * The targets as the panel knows them now. The node row, its endpoint
   * revision, its active bridge route and that bridge are read in ONE
   * statement, so a config is never paired with the revision of another
   * assignment (unlocked, two reads could straddle an activation and label a
   * Direct config with the bridged revision).
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
   * direct config is never sent under the bridged identity. AWG 2 keeps the
   * direct path and its direct config.
   */
  private loadTargets = async (
    db: Database | Tx,
    options: { lock: boolean; bridgeMeasurement: boolean },
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
      }).map((protocol): RunTarget => {
        const target: RunTarget = {
          targetId: reachabilityTargetId(node.id, protocol, node.endpointRevision),
          nodeId: node.id,
          nodeName: node.name,
          publicIp: node.publicIp ?? node.publicHost,
          protocol,
          endpointRevision: node.endpointRevision,
          bridgePath:
            node.bridgeName !== null && node.bridgeHost !== null && node.bridgePort !== null
              ? { bridgeName: node.bridgeName, host: node.bridgeHost, port: node.bridgePort }
              : null,
          unavailableReason: null,
          config: null,
          // The node's origin exit IP. Unknown is sent as an explicit null
          // only on a bridged path (reachabilityTask.ts), where the endpoint
          // host is the bridge and no fallback comparison makes sense.
          expectedEgressIp: node.publicIp,
        };
        const key = keys.find((k) => k.nodeId === node.id && k.protocol === protocol);
        if (!key) return { ...target, unavailableReason: "no service key yet" };
        if (key.state === "provisioning") {
          return { ...target, unavailableReason: "service key is provisioning" };
        }
        if (key.state === "failed") {
          return {
            ...target,
            unavailableReason: `service key failed: ${key.failureReason ?? "unknown"}`.slice(0, 300),
          };
        }
        if (key.state !== "active" || key.configCiphertext === null) {
          return { ...target, unavailableReason: `service key is ${key.state}` };
        }
        const via = measuredViaBridge(target) ? target.bridgePath : null;
        if (via && !options.bridgeMeasurement) {
          return { ...target, unavailableReason: BRIDGE_UNSUPPORTED_REASON };
        }
        const config = decryptSecret(
          {
            ciphertext: key.configCiphertext,
            nonce: key.configNonce as string,
            authTag: key.configAuthTag as string,
            keyVersion: key.configKeyVersion as number,
          },
          this.options.keyring,
        );
        if (!via) return { ...target, config };
        if (inspectAwgVpnLink(config).kind !== "awg31") {
          return { ...target, unavailableReason: BRIDGE_UNRENDERABLE_REASON };
        }
        try {
          return {
            ...target,
            config: renderAwgEndpointVpnLink(config, { host: via.host, port: via.port }),
          };
        } catch {
          return { ...target, unavailableReason: BRIDGE_UNRENDERABLE_REASON };
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
    const [resultRows, onlineRows, handshakeRows, bridgedRows] =
      nodeIds.length === 0
        ? [[], [], [], []]
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
                online: sql<number>`count(*) filter (where ${peerCurrent.online})`,
              })
              .from(peerCurrent)
              .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
              .innerJoin(users, keyOwnerIsPerson(vpnKeys))
              .where(inArray(vpnKeys.nodeId, nodeIds))
              .groupBy(vpnKeys.nodeId),
            // A person's newest handshake on the node, as on the admin node
            // card. Revoked keys count: a node everyone was moved off keeps
            // saying when people last used it instead of going blank.
            db
              .select({
                nodeId: vpnKeys.nodeId,
                at: sql<unknown>`max(${peerCurrent.latestHandshakeAt})`,
              })
              .from(peerCurrent)
              .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
              .innerJoin(users, keyOwnerIsPerson(vpnKeys))
              .where(inArray(vpnKeys.nodeId, nodeIds))
              .groupBy(vpnKeys.nodeId),
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
    const online = new Map(onlineRows.map((row) => [row.nodeId, Number(row.online)]));
    // A raw `max(...)` gets no type parser: postgres-js may hand back a string.
    const toDate = (value: unknown): Date | null => {
      if (value instanceof Date) return value;
      if (typeof value !== "string" && typeof value !== "number") return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const lastHandshake = new Map(handshakeRows.map((row) => [row.nodeId, toDate(row.at)]));

    const widgetNodes: WidgetNode[] = stateRows.map((row) => ({
      name: row.name,
      status: row.status,
      levels: best.get(row.nodeId)?.levels ?? null,
      failingSince: row.failingSince,
      online: online.get(row.nodeId) ?? 0,
      lastPersonHandshakeAt: lastHandshake.get(row.nodeId) ?? null,
    }));
    const widget: StoredWidget | null =
      probe.widgetMessageId !== null && probe.widgetChatId !== null && probe.widgetVersion !== null
        ? {
            messageId: probe.widgetMessageId,
            chatId: probe.widgetChatId,
            version: probe.widgetVersion,
          }
        : null;
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

  saveWidget = async (widget: StoredWidget, at: Date): Promise<void> => {
    await this.updateProbe({
      widgetMessageId: widget.messageId,
      widgetChatId: widget.chatId,
      widgetVersion: widget.version,
      widgetUpdatedAt: at,
    });
  };

  recordWidgetResult = async (at: Date, error: string | null): Promise<void> => {
    await this.updateProbe(
      error === null
        ? { widgetUpdatedAt: at, widgetLastError: null }
        : { widgetLastError: error.slice(0, 300) },
    );
  };
}
