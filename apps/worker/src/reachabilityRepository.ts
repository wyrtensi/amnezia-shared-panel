import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";

import {
  isProbeStale,
  nodeServedProtocols,
  PROBE_STALE_GRACE_SEC,
  probeLevelsSchema,
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
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";

import type { CandidateOutcome, CandidateRun } from "./bridgeCandidateCheck.js";
import {
  EMPTY_CANDIDATE_SLOT,
  writeCandidateVerification,
} from "./bridgeCandidateRepository.js";
import type { NodeState, Notice } from "./reachability.js";
import type { WidgetNode } from "./reachabilityWidget.js";
import type { ReachabilityWidgetStore, StoredWidget } from "./reachabilityWidgetSender.js";
import type {
  IngestWrite,
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

  loadStates = async (): Promise<Map<string, NodeState>> => {
    const rows = await this.options.db.select().from(nodeReachabilityState);
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

  finishCandidateRun = async (run: CandidateRun, outcome: CandidateOutcome): Promise<boolean> =>
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
      if (freed.length === 0) return false;
      return writeCandidateVerification(tx, {
        routeId: run.routeId,
        registrationMarker: run.registrationMarker,
        requestedAt: run.requestedAt,
        outcome,
      });
    });

  ingest = async (write: IngestWrite): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      // Claim the run first: only the ingest that clears `current_run_id`
      // writes anything, so an overlapping worker cannot count it twice.
      const claimed = await tx
        .update(reachabilityProbe)
        .set({
          currentRunId: null,
          lastIngestedRunId: write.runId,
          lastResultAt: write.now,
          lastError: null,
          lastErrorAt: null,
          staleAlertedAt: write.staleAlertedAt,
          lastRunMass: write.mass,
          updatedAt: new Date(),
        })
        .where(
          and(eq(reachabilityProbe.id, 1), eq(reachabilityProbe.currentRunId, write.runId)),
        )
        .returning({ id: reachabilityProbe.id });
      if (claimed.length === 0) return;

      const nodeIds = [...write.states.keys()];
      // A node deleted since the run started is skipped, not an error.
      const existing = new Set(
        nodeIds.length === 0
          ? []
          : (
              await tx
                .select({ id: nodes.id })
                .from(nodes)
                .where(inArray(nodes.id, nodeIds))
            ).map((row) => row.id),
      );

      for (const nodeId of existing) {
        const outcomes = write.outcomes.filter((o) => o.nodeId === nodeId);
        const protocols = outcomes.map((o) => o.protocol);
        // A protocol the node no longer serves leaves no stale row behind.
        await tx
          .delete(nodeReachabilityResults)
          .where(
            and(
              eq(nodeReachabilityResults.nodeId, nodeId),
              notInArray(nodeReachabilityResults.protocol, protocols),
            ),
          );
        for (const outcome of outcomes) {
          const values = {
            nodeId,
            protocol: outcome.protocol,
            status: outcome.status,
            levels: (outcome.levels ?? {}) as Record<string, unknown>,
            egressIp: outcome.egressIp,
            detail: outcome.detail,
            runId: write.runId,
            checkedAt: write.now,
          };
          await tx
            .insert(nodeReachabilityResults)
            .values(values)
            .onConflictDoUpdate({
              target: [nodeReachabilityResults.nodeId, nodeReachabilityResults.protocol],
              set: values,
            });
        }

        const state = write.states.get(nodeId) as NodeState;
        const stateValues = {
          nodeId,
          status: state.status,
          consecutiveFailures: state.consecutiveFailures,
          failingSince: state.failingSince,
          alertedAt: state.alertedAt,
          alertKind: state.alertKind,
          checkedAt: write.now,
          detail: state.detail,
        };
        await tx
          .insert(nodeReachabilityState)
          .values(stateValues)
          .onConflictDoUpdate({ target: nodeReachabilityState.nodeId, set: stateValues });
        await tx.insert(nodeReachabilityHistory).values({
          nodeId,
          runId: write.runId,
          status: state.status,
          detail: state.detail,
          checkedAt: write.now,
        });
      }

      if (write.notices.length > 0) {
        await tx.insert(jobOutbox).values(outboxRows(write.notices)).onConflictDoNothing();
      }
      await tx.insert(jobOutbox).values(widgetRow(`run:${write.runId}`)).onConflictDoNothing();
      await tx
        .delete(nodeReachabilityHistory)
        .where(
          lt(
            nodeReachabilityHistory.checkedAt,
            new Date(write.now.getTime() - HISTORY_RETENTION_MS),
          ),
        );
    });
  };

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

  listTargets = async (): Promise<RunTarget[]> => {
    const db = this.options.db;
    const nodeRows = await db
      .select()
      .from(nodes)
      .where(eq(nodes.reachabilityEnabled, true))
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
        const key = keys.find((k) => k.nodeId === node.id && k.protocol === protocol);
        let config: string | null = null;
        let unavailableReason: string | null = null;
        if (!key) unavailableReason = "no service key yet";
        else if (key.state === "provisioning") unavailableReason = "service key is provisioning";
        else if (key.state === "failed") {
          unavailableReason = `service key failed: ${key.failureReason ?? "unknown"}`.slice(0, 300);
        } else if (key.state !== "active" || key.configCiphertext === null) {
          unavailableReason = `service key is ${key.state}`;
        } else {
          config = decryptSecret(
            {
              ciphertext: key.configCiphertext,
              nonce: key.configNonce as string,
              authTag: key.configAuthTag as string,
              keyVersion: key.configKeyVersion as number,
            },
            this.options.keyring,
          );
        }
        return {
          targetId: `${node.id}:${protocol}`,
          nodeId: node.id,
          nodeName: node.name,
          publicIp: node.publicIp ?? node.publicHost,
          protocol,
          unavailableReason,
          config,
          expectedEgressIp: node.publicIp,
        };
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
    const [resultRows, onlineRows, handshakeRows] =
      nodeIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            db
              .select({
                nodeId: nodeReachabilityResults.nodeId,
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
          ]);

    // One protocol's levels per node: the one that worked, else one that was
    // measured, else nothing.
    const best = new Map<string, { rank: number; levels: ProbeLevels | null }>();
    for (const row of resultRows) {
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
