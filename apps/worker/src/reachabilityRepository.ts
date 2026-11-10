import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import {
  nodeServedProtocols,
  REACHABILITY_NOTIFY_JOB_TYPE,
  revokeJobDedupKey,
  type ProtocolKind,
} from "@amnezia/contracts";
import {
  auditEvents,
  decryptSecret,
  deterministicPeerLabel,
  jobOutbox,
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  nodes,
  reachabilityProbe,
  users,
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";

import type { NodeState, Notice } from "./reachability.js";
import type {
  IngestWrite,
  ProbeRow,
  ReachabilityRepository,
  RunTarget,
} from "./reachabilityTask.js";

/** The machine account that owns the probe's keys. `.invalid` never resolves. */
export const SERVICE_ACCOUNT_EMAIL = "reachability-probe@service.invalid";

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** A failed service key is retried no sooner than this. */
const FAILED_KEY_RETRY_MS = 24 * 60 * 60 * 1_000;
const LIVE_KEY_STATES = ["provisioning", "active", "disabled"] as const;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const outboxRows = (notices: readonly Notice[]) =>
  notices.map((notice) => ({
    type: REACHABILITY_NOTIFY_JOB_TYPE,
    deduplicationKey: notice.dedupKey,
    payload: { text: notice.text },
  }));

export class PostgresReachabilityRepository implements ReachabilityRepository {
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
      createdAt: row.createdAt,
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

  markRunStarted = async (runId: string, at: Date): Promise<void> => {
    await this.updateProbe({ currentRunId: runId, currentRunStartedAt: at });
  };

  abandonRun = async (at: Date): Promise<void> => {
    await this.updateProbe({
      currentRunId: null,
      lastError: "run abandoned: the probe did not finish it within 30 minutes",
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
    });
  };

  ingest = async (write: IngestWrite): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
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
      await this.updateProbe(
        {
          currentRunId: null,
          lastIngestedRunId: write.runId,
          lastResultAt: write.now,
          lastError: null,
          lastErrorAt: null,
          staleAlertedAt: write.staleAlertedAt,
        },
        tx,
      );
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

  private serviceAccountId = async (db: Database | Tx): Promise<string | null> => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SERVICE_ACCOUNT_EMAIL))
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

  syncServiceKeys = async (now: Date): Promise<{ created: number; revoked: number }> =>
    this.options.db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({
          email: SERVICE_ACCOUNT_EMAIL,
          displayName: "Reachability probe",
          role: "user",
          serviceAccount: true,
        })
        .onConflictDoNothing({ target: users.email });
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
          if (mine.some((k) => (LIVE_KEY_STATES as readonly string[]).includes(k.state))) continue;
          const newest = mine[0];
          // A node that refused the key (for example, one that is gone) is not
          // asked again every run.
          if (
            newest?.state === "failed" &&
            now.getTime() - newest.updatedAt.getTime() < FAILED_KEY_RETRY_MS
          ) {
            continue;
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
        }
      }

      const unwanted = keys.filter(
        (k) =>
          (k.state === "active" || k.state === "disabled") &&
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
      return { created, revoked };
    });
}
