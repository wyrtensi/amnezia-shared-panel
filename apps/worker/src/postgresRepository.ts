import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  armAccessSyncRow,
  decryptSecret,
  encryptSecret,
  auditEvents,
  jobOutbox,
  nodeAgentReleases,
  nodeMetricsCurrent,
  nodeMetricsSamples,
  nodeServiceCheckResults,
  nodeServiceChecks,
  nodes,
  peerCurrent,
  peerSamples,
  portalPolicy,
  routeRuleVersions,
  trafficRollups,
  users,
  vpnKeys,
  type AccessSyncArmReason,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";
import type {
  AccessReconcileResult,
  OutboxJob,
  NodeAgentUpdateRequested,
  NodeCapacityRequested,
  NodeReconcileContext,
  NodeReconcileResult,
  WorkerKeyContext,
  WorkerRepository,
} from "./repository.js";
import type {
  MaintenanceRepository,
  RollupPeriod,
  TrafficRollup,
  TrafficSample,
} from "./maintenance.js";
import type {
  RuleProfile,
  RuleRepository,
  StoredRuleInput,
} from "./rules.js";
import { protocolsFromAgent } from "./nodeAgent.js";
import type {
  NodeServiceCheck,
  PreviousResult,
  ServiceCheckResultRow,
} from "./serviceChecks.js";
import {
  DEFAULT_METRICS_SAMPLE_SEC,
  shouldStoreMetricsSample,
  toNodeMetricsRow,
} from "./nodeMetrics.js";
import {
  DEFAULT_PEER_SAMPLE_INTERVAL_MS,
  shouldStoreSample,
  type NodeSnapshot,
  type PeerObservation,
  type TelemetryNode,
  type TelemetryRepository,
} from "./telemetry.js";

export type PostgresWorkerRepositoryOptions = {
  db: Database;
  keyring: EncryptionKeyring;
  activeKeyVersion: number;
  jobLeaseMs?: number;
  /**
   * How often a host-metrics history row is kept, in seconds. It decides how
   * fast node_metrics_samples grows, so it is an operator setting rather than a
   * constant - and it lives here rather than in nodeMetrics.ts so there is one
   * place it can be wrong.
   *
   * A function is asked before every snapshot, which is how an admin's edit
   * reaches the sampler without a restart. A plain number is still accepted and
   * is what the tests use.
   */
  metricsSampleSec?: number | (() => Promise<number>);
  /**
   * The floor on how often an UNCHANGED peer writes a peer_samples row. Same
   * shape and the same reason as metricsSampleSec above; a peer whose state
   * moved is always sampled regardless.
   */
  peerSampleSec?: number | (() => Promise<number>);
};

// The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`.
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const cleanReason = (reason: string): string =>
  reason.replace(/[\r\n\t]+/g, " ").slice(0, 2_000);

/**
 * A period option that may be a fixed number or a resolver, as one number.
 *
 * The resolver is the live-settings path and is expected not to throw (see
 * `periods.ts`, which swallows a failed read and hands back the last good
 * value). The catch here is the second line: a snapshot must be written even if
 * the panel cannot say how often to sample it, because losing the snapshot is
 * strictly worse than sampling it on the default period.
 */
const resolveSeconds = async (
  option: number | (() => Promise<number>) | undefined,
  fallback: number,
): Promise<number> => {
  if (typeof option === "number") return option;
  if (option === undefined) return fallback;
  try {
    const value = await option();
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

export class PostgresWorkerRepository
  implements
    WorkerRepository,
    TelemetryRepository,
    MaintenanceRepository,
    RuleRepository
{
  constructor(private readonly options: PostgresWorkerRepositoryOptions) {}

  claimJob = async (): Promise<OutboxJob | null> =>
    this.options.db.transaction(async (tx) => {
      const now = new Date();
      const leaseCutoff = new Date(
        now.getTime() - (this.options.jobLeaseMs ?? 5 * 60_000),
      );
      const job = (
        await tx
          .select()
          .from(jobOutbox)
          .where(
            or(
              and(
                eq(jobOutbox.status, "pending"),
                lte(jobOutbox.availableAt, now),
              ),
              and(
                eq(jobOutbox.status, "processing"),
                or(
                  isNull(jobOutbox.lockedAt),
                  lte(jobOutbox.lockedAt, leaseCutoff),
                ),
              ),
            ),
          )
          .orderBy(asc(jobOutbox.availableAt), asc(jobOutbox.createdAt))
          .limit(1)
          .for("update", { skipLocked: true })
      )[0];
      if (!job) return null;
      const [claimed] = await tx
        .update(jobOutbox)
        .set({
          status: "processing",
          attempts: sql`${jobOutbox.attempts} + 1`,
          lockedAt: now,
          updatedAt: now,
        })
        .where(eq(jobOutbox.id, job.id))
        .returning();
      if (!claimed) return null;
      return {
        id: claimed.id,
        type: claimed.type,
        attempts: claimed.attempts,
        payload: claimed.payload,
      };
    });

  loadKeyContext = async (keyId: string): Promise<WorkerKeyContext | null> => {
    const row = (
      await this.options.db
        .select({ key: vpnKeys, node: nodes })
        .from(vpnKeys)
        .innerJoin(nodes, eq(nodes.id, vpnKeys.nodeId))
        .where(eq(vpnKeys.id, keyId))
        .limit(1)
    )[0];
    if (!row) return null;
    const apiKey = decryptSecret(
      {
        ciphertext: row.node.credentialsCiphertext,
        nonce: row.node.credentialsNonce,
        authTag: row.node.credentialsAuthTag,
        keyVersion: row.node.credentialsKeyVersion,
      },
      this.options.keyring,
    );
    return {
      keyId: row.key.id,
      state: row.key.state,
      nodeLabel: row.key.nodeLabel,
      protocol: row.key.protocol,
      publicKey: row.key.publicKey,
      node: {
        id: row.node.id,
        baseUrl: row.node.apiBaseUrl,
        apiKey,
      },
    };
  };

  loadNodeReconcileContext = async (
    nodeId: string,
  ): Promise<NodeReconcileContext | null> => {
    const node = (
      await this.options.db
        .select()
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1)
    )[0];
    if (!node) return null;
    const keys = await this.options.db
      .select({
        keyId: vpnKeys.id,
        nodeLabel: vpnKeys.nodeLabel,
        publicKey: vpnKeys.publicKey,
      })
      .from(vpnKeys)
      .where(
        and(
          eq(vpnKeys.nodeId, nodeId),
          inArray(vpnKeys.state, [
            "provisioning",
            "active",
            "disabled",
            "revoking",
          ]),
        ),
      );
    return {
      node: {
        id: node.id,
        baseUrl: node.apiBaseUrl,
        apiKey: decryptSecret(
          {
            ciphertext: node.credentialsCiphertext,
            nonce: node.credentialsNonce,
            authTag: node.credentialsAuthTag,
            keyVersion: node.credentialsKeyVersion,
          },
          this.options.keyring,
        ),
      },
      keys,
    };
  };

  completeNodeReconcile = async (
    result: NodeReconcileResult,
  ): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      const currentRows =
        result.managedKeyIds.length > 0
          ? await tx
              .select()
              .from(peerCurrent)
              .where(inArray(peerCurrent.keyId, result.managedKeyIds))
          : [];
      const previousByKeyId = new Map(
        currentRows.map((current) => [current.keyId, current] as const),
      );
      const observedByKeyId = new Map(
        result.peers.map((peer) => [peer.keyId, peer] as const),
      );
      for (const keyId of result.managedKeyIds) {
        const observed = observedByKeyId.get(keyId);
        const previous = previousByKeyId.get(keyId);
        await tx
          .insert(peerCurrent)
          .values({
            keyId,
            online: observed?.online ?? false,
            endpoint: observed?.endpoint ?? null,
            latestHandshakeAt:
              observed?.latestHandshakeAt ?? previous?.latestHandshakeAt ?? null,
            receivedBytes:
              observed?.receivedBytes ?? previous?.receivedBytes ?? 0n,
            sentBytes: observed?.sentBytes ?? previous?.sentBytes ?? 0n,
            observedAt: result.observedAt,
          })
          .onConflictDoUpdate({
            target: peerCurrent.keyId,
            set: {
              online: observed?.online ?? false,
              endpoint: observed?.endpoint ?? null,
              latestHandshakeAt:
                observed?.latestHandshakeAt ??
                previous?.latestHandshakeAt ??
                null,
              receivedBytes:
                observed?.receivedBytes ?? previous?.receivedBytes ?? 0n,
              sentBytes: observed?.sentBytes ?? previous?.sentBytes ?? 0n,
              observedAt: result.observedAt,
            },
          });
      }
      const mismatch =
        result.summary.missingManagedPeerCount > 0 ||
        result.summary.orphanNodePeerCount > 0;
      await tx
        .update(nodes)
        .set({
          lastSyncAt: result.observedAt,
          lastError: mismatch
            ? `Reconcile mismatch: missing=${result.summary.missingManagedPeerCount} orphan=${result.summary.orphanNodePeerCount}`
            : null,
          updatedAt: result.observedAt,
        })
        .where(eq(nodes.id, result.nodeId));
      await tx.insert(auditEvents).values({
        actorType: "system",
        action: "node.reconcile",
        targetType: "node",
        targetId: result.nodeId,
        metadata: { jobId: result.jobId, ...result.summary },
        createdAt: result.observedAt,
      });
      await tx
        .update(jobOutbox)
        .set({
          status: "completed",
          completedAt: result.observedAt,
          lockedAt: null,
          lastError: null,
          updatedAt: result.observedAt,
        })
        .where(eq(jobOutbox.id, result.jobId));
    });
  };

  completeNodeAgentUpdate = async (
    result: NodeAgentUpdateRequested,
  ): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      // The node has been asked, not updated. The outcome arrives through the
      // telemetry poll, which is also what clears this state if the node never
      // comes back with one.
      await tx
        .update(nodes)
        .set({
          agentUpdateState: "requested",
          agentUpdateImage: result.image,
          agentUpdateMessage: null,
          agentUpdateLog: "",
          agentUpdateAt: null,
          updatedAt: result.requestedAt,
        })
        .where(eq(nodes.id, result.nodeId));
      await tx.insert(auditEvents).values({
        actorType: "system",
        action: "node.agent-update.requested",
        targetType: "node",
        targetId: result.nodeId,
        metadata: { jobId: result.jobId, image: result.image },
        createdAt: result.requestedAt,
      });
      await tx
        .update(jobOutbox)
        .set({
          status: "completed",
          completedAt: result.requestedAt,
          lockedAt: null,
          lastError: null,
          updatedAt: result.requestedAt,
        })
        .where(eq(jobOutbox.id, result.jobId));
    });
  };

  completeNodeCapacityChange = async (
    result: NodeCapacityRequested,
  ): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      // The node has been asked, not changed. The outcome arrives through the
      // telemetry poll, which is also what clears this state if the node never
      // comes back with one.
      await tx
        .update(nodes)
        .set({
          capacityState: "requested",
          capacityRequestedPeers: result.maxPeers,
          capacityMessage: null,
          capacityLog: "",
          capacityAt: null,
          updatedAt: result.requestedAt,
        })
        .where(eq(nodes.id, result.nodeId));
      await tx.insert(auditEvents).values({
        actorType: "system",
        action: "node.set-capacity.requested",
        targetType: "node",
        targetId: result.nodeId,
        metadata: { jobId: result.jobId, maxPeers: result.maxPeers },
        createdAt: result.requestedAt,
      });
      await tx
        .update(jobOutbox)
        .set({
          status: "completed",
          completedAt: result.requestedAt,
          lockedAt: null,
          lastError: null,
          updatedAt: result.requestedAt,
        })
        .where(eq(jobOutbox.id, result.jobId));
    });
  };

  saveNodeAgentRelease = async (release: {
    repository: string;
    version: string;
    digest: string;
    resolvedAt: Date;
  }): Promise<void> => {
    await this.options.db
      .insert(nodeAgentReleases)
      .values(release)
      .onConflictDoUpdate({
        target: nodeAgentReleases.repository,
        set: {
          version: release.version,
          digest: release.digest,
          resolvedAt: release.resolvedAt,
        },
      });
  };

  // Disable one user and queue their keys for revocation, inside a transaction.
  // Shared by reconcileAccess (allowlist mode) and deactivateByEmail (targeted).
  private disableAndRevoke = async (
    tx: DbTransaction,
    user: { id: string; email: string },
  ): Promise<void> => {
    const revocableStates = [
      "provisioning",
      "active",
      "disabled",
      "failed",
    ] as const;
    await tx
      .update(users)
      .set({
        status: "disabled",
        disabledAt: new Date(),
        deactivationReason: "access_removed",
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const keysToRevoke = await tx
      .update(vpnKeys)
      .set({ state: "revoking", updatedAt: new Date() })
      .where(
        and(
          eq(vpnKeys.ownerId, user.id),
          inArray(vpnKeys.state, [...revocableStates]),
        ),
      )
      .returning({ id: vpnKeys.id });

    for (const key of keysToRevoke) {
      await tx
        .insert(jobOutbox)
        .values({
          type: "vpn-key.revoke",
          deduplicationKey: `vpn-key.revoke:${key.id}`,
          payload: { keyId: key.id },
        })
        .onConflictDoNothing();
    }

    await tx.insert(auditEvents).values({
      actorType: "system",
      action: "user.access_revoked",
      targetType: "user",
      targetId: user.id,
      metadata: {
        email: user.email,
        keysQueuedForRevoke: keysToRevoke.length,
      },
    });
  };

  reconcileAccess = async (
    allowedEmails: string[],
  ): Promise<AccessReconcileResult> => {
    // Guard: an empty allowlist almost always means the directory lookup failed.
    // Deactivating everyone in that case would be catastrophic, so do nothing.
    if (allowedEmails.length === 0) {
      return { deactivated: [], skippedAdmins: [] };
    }
    const allowed = new Set(allowedEmails.map((email) => email.toLowerCase()));

    return this.options.db.transaction(async (tx) => {
      const active = await tx
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.status, "active"));

      const deactivated: string[] = [];
      const skippedAdmins: string[] = [];

      for (const user of active) {
        if (allowed.has(user.email.toLowerCase())) continue;
        // Admins are never auto-disabled — losing the last admin would lock the
        // panel. They are surfaced for a human to offboard deliberately.
        if (user.role === "admin") {
          skippedAdmins.push(user.email);
          continue;
        }
        await this.disableAndRevoke(tx, user);
        deactivated.push(user.email);
      }

      return { deactivated, skippedAdmins };
    });
  };

  // Disable EXACTLY the given emails (active non-admins), revoking their keys.
  // Unlike reconcileAccess ("disable everyone not in the allowlist"), this
  // targets an explicit set, so a user created concurrently is never touched —
  // used by the two-way Access sync to honour a Cloudflare-side removal.
  deactivateByEmail = async (
    emails: string[],
  ): Promise<AccessReconcileResult> => {
    const targets = new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    );
    if (targets.size === 0) return { deactivated: [], skippedAdmins: [] };

    return this.options.db.transaction(async (tx) => {
      const active = await tx
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.status, "active"));

      const deactivated: string[] = [];
      const skippedAdmins: string[] = [];

      for (const user of active) {
        if (!targets.has(user.email.toLowerCase())) continue;
        if (user.role === "admin") {
          skippedAdmins.push(user.email);
          continue;
        }
        await this.disableAndRevoke(tx, user);
        deactivated.push(user.email);
      }

      return { deactivated, skippedAdmins };
    });
  };

  // Two-way Access sync baseline: the email set last reconciled with Cloudflare.
  getAccessSyncBaseline = async (): Promise<string[]> => {
    const [row] = await this.options.db
      .select({ emails: portalPolicy.cfAccessSyncedEmails })
      .from(portalPolicy)
      .limit(1);
    return row?.emails ?? [];
  };

  // Domains the operator has asked the panel to manage as `email_domain`
  // rules (cf_access_allowed_domains). NOT NULL default `[]`, so no fallback
  // is needed once the row exists; a missing row (Cloudflare never
  // configured) reads as "no domains desired".
  getAccessSyncDesiredDomains = async (): Promise<string[]> => {
    const [row] = await this.options.db
      .select({ domains: portalPolicy.cfAccessAllowedDomains })
      .from(portalPolicy)
      .limit(1);
    return row?.domains ?? [];
  };

  // Domain half of the two-way Access sync baseline: the domain set the panel
  // itself last wrote as `email_domain` rules. Mirrors getAccessSyncBaseline;
  // null until the first domain sync.
  getAccessSyncBaselineDomains = async (): Promise<string[]> => {
    const [row] = await this.options.db
      .select({ domains: portalPolicy.cfAccessSyncedDomains })
      .from(portalPolicy)
      .limit(1);
    return row?.domains ?? [];
  };

  setAccessSyncBaseline = async (
    emails: string[],
    domains: string[],
  ): Promise<void> => {
    // portal_policy is a singleton (id = true) that exists once Cloudflare has
    // been configured — the only path that calls this. Both baselines are
    // written in the SAME statement so a crash between them can never leave
    // one ahead of the other.
    await this.options.db
      .update(portalPolicy)
      .set({
        cfAccessSyncedEmails: emails,
        cfAccessSyncedDomains: domains,
        updatedAt: new Date(),
      })
      .where(eq(portalPolicy.id, true));
  };

  recordAccessSyncAborted = async (details: {
    candidates: string[];
    limit: number;
    activeCount: number;
    overAbsoluteCap: boolean;
    overMajority: boolean;
  }): Promise<void> => {
    await this.options.db.insert(auditEvents).values({
      actorType: "system",
      action: "access.sync_aborted",
      targetType: "access_policy",
      metadata: {
        candidateCount: details.candidates.length,
        // Capped so one anomalous run cannot write an unbounded audit row.
        candidates: details.candidates.slice(0, 50),
        limit: details.limit,
        // Which half of the blast-radius cap fired (either or both), and the
        // active-user count it was judged against — without these a
        // proportional-only abort reads as self-contradictory
        // (candidateCount under limit) to whoever opens this row.
        activeCount: details.activeCount,
        overAbsoluteCap: details.overAbsoluteCap,
        overMajority: details.overMajority,
      },
    });
  };

  // The upsert lives in @amnezia/db (armAccessSyncRow) because Task 4 arms the
  // same row from control-api's postgresRepository, inside the transaction of
  // the user mutation that triggers it -- two copies of this statement would
  // only ever drift.
  armAccessSync = async (reason: AccessSyncArmReason): Promise<void> => {
    await armAccessSyncRow(this.options.db, reason);
  };

  finishAccessSync = async (jobId: string, armId: string): Promise<void> => {
    // Complete only if nothing armed the row again while this run was in
    // flight. If something did, leave it pending so the change costs one more
    // run rather than an hour of staleness.
    await this.options.db
      .update(jobOutbox)
      .set({
        status: sql`CASE WHEN ${jobOutbox.payload} ->> 'armId' = ${armId} THEN 'completed'::outbox_status ELSE 'pending'::outbox_status END`,
        completedAt: sql`CASE WHEN ${jobOutbox.payload} ->> 'armId' = ${armId} THEN now() ELSE NULL END`,
        availableAt: sql`CASE WHEN ${jobOutbox.payload} ->> 'armId' = ${armId} THEN ${jobOutbox.availableAt} ELSE now() END`,
        attempts: 0,
        lockedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(jobOutbox.id, jobId));
  };

  getCloudflareConfig = async (): Promise<{
    accountId: string;
    appId: string;
    policyId: string;
    apiToken: string;
  } | null> => {
    const [row] = await this.options.db.select().from(portalPolicy).limit(1);
    if (
      !row?.cfAccessAccountId ||
      !row.cfAccessAppId ||
      !row.cfAccessPolicyId ||
      !row.cfApiTokenCiphertext ||
      !row.cfApiTokenNonce ||
      !row.cfApiTokenAuthTag ||
      row.cfApiTokenKeyVersion == null
    ) {
      return null;
    }
    const apiToken = decryptSecret(
      {
        ciphertext: row.cfApiTokenCiphertext,
        nonce: row.cfApiTokenNonce,
        authTag: row.cfApiTokenAuthTag,
        keyVersion: row.cfApiTokenKeyVersion,
      },
      this.options.keyring,
    );
    return {
      accountId: row.cfAccessAccountId,
      appId: row.cfAccessAppId,
      policyId: row.cfAccessPolicyId,
      apiToken,
    };
  };

  listActiveUserEmails = async (): Promise<string[]> => {
    const rows = await this.options.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.status, "active"));
    return rows.map((row) => row.email);
  };

  purgeOffboardedUsers = async (): Promise<{ deleted: string[] }> => {
    return this.options.db.transaction(async (tx) => {
      const disabled = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.status, "disabled"));
      const deleted: string[] = [];
      for (const user of disabled) {
        // Keys that may still hold a peer on a node block deletion; wait until
        // every key has finished revoking (only "revoked" rows may remain).
        const [live] = await tx
          .select({ value: count() })
          .from(vpnKeys)
          .where(
            and(
              eq(vpnKeys.ownerId, user.id),
              inArray(vpnKeys.state, [
                "provisioning",
                "active",
                "disabled",
                "revoking",
                "failed",
              ]),
            ),
          );
        if ((live?.value ?? 0) > 0) continue;
        // Delete only the revoked key rows (telemetry cascades), then the user.
        // Scoping to "revoked" means a key that raced into a live state since
        // the check above blocks the user delete (FK restrict) and the whole
        // transaction rolls back — the user is retried next cycle, never
        // half-deleted with a stranded peer.
        await tx
          .delete(vpnKeys)
          .where(and(eq(vpnKeys.ownerId, user.id), eq(vpnKeys.state, "revoked")));
        await tx.delete(users).where(eq(users.id, user.id));
        await tx.insert(auditEvents).values({
          actorType: "system",
          action: "user.deleted",
          targetType: "user",
          targetId: user.id,
          metadata: { email: user.email },
        });
        deleted.push(user.email);
      }
      return { deleted };
    });
  };

  completeProvision = async ({
    jobId,
    keyId,
    publicKey,
    vpnConfig,
  }: {
    jobId: string;
    keyId: string;
    publicKey: string;
    vpnConfig: string;
  }): Promise<void> => {
    const encrypted = encryptSecret(
      vpnConfig,
      this.options.keyring,
      this.options.activeKeyVersion,
    );
    await this.options.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(vpnKeys)
        .set({
          publicKey,
          state: "active",
          configCiphertext: encrypted.ciphertext,
          configNonce: encrypted.nonce,
          configAuthTag: encrypted.authTag,
          configKeyVersion: encrypted.keyVersion,
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(vpnKeys.id, keyId), eq(vpnKeys.state, "provisioning")))
        .returning({ id: vpnKeys.id });
      if (!updated) throw new Error("Provisioning key changed state before completion");
      await tx
        .update(jobOutbox)
        .set({
          status: "completed",
          completedAt: new Date(),
          lockedAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(jobOutbox.id, jobId));
    });
  };

  completeLifecycle = async (
    jobId: string,
    keyId: string,
    state: WorkerKeyContext["state"],
  ): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      await tx
        .update(vpnKeys)
        .set({
          state,
          revokedAt: state === "revoked" ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(eq(vpnKeys.id, keyId));
      await tx
        .update(jobOutbox)
        .set({
          status: "completed",
          completedAt: new Date(),
          lockedAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(jobOutbox.id, jobId));
    });
  };

  completeJob = async (jobId: string): Promise<void> => {
    await this.options.db
      .update(jobOutbox)
      .set({
        status: "completed",
        completedAt: new Date(),
        lockedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(jobOutbox.id, jobId));
  };

  retryJob = async (jobId: string, reason: string): Promise<void> => {
    const job = (
      await this.options.db
        .select({ attempts: jobOutbox.attempts })
        .from(jobOutbox)
        .where(eq(jobOutbox.id, jobId))
        .limit(1)
    )[0];
    const delaySeconds = Math.min(300, 2 ** Math.min(job?.attempts ?? 1, 8));
    await this.options.db
      .update(jobOutbox)
      .set({
        status: "pending",
        availableAt: new Date(Date.now() + delaySeconds * 1_000),
        lockedAt: null,
        lastError: cleanReason(reason),
        updatedAt: new Date(),
      })
      .where(eq(jobOutbox.id, jobId));
  };

  failJob = async (jobId: string, reason: string): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      const job = (
        await tx
          .select({ payload: jobOutbox.payload })
          .from(jobOutbox)
          .where(eq(jobOutbox.id, jobId))
          .limit(1)
      )[0];
      await tx
        .update(jobOutbox)
        .set({
          status: "failed",
          lockedAt: null,
          lastError: cleanReason(reason),
          updatedAt: new Date(),
        })
        .where(eq(jobOutbox.id, jobId));
      const keyId = job?.payload.keyId;
      if (typeof keyId === "string") {
        // `failed` means "this key never came into existence" -- a provision
        // that did not complete. A revoke that did not complete is a different
        // thing: the owner asked for the key to be gone, and the request is
        // still outstanding. Moving it to `failed` used to surface a key the
        // user had just deleted, labelled "Error", that could not be deleted
        // again. It stays in `revoking` and only records why the attempt
        // failed, so the retry paths still recognise it.
        await tx
          .update(vpnKeys)
          .set({
            state: "failed",
            failureReason: cleanReason(reason),
            updatedAt: new Date(),
          })
          .where(
            and(eq(vpnKeys.id, keyId), eq(vpnKeys.state, "provisioning")),
          );
        await tx
          .update(vpnKeys)
          .set({ failureReason: cleanReason(reason), updatedAt: new Date() })
          .where(and(eq(vpnKeys.id, keyId), eq(vpnKeys.state, "revoking")));
      }
    });
  };

  listTelemetryNodes = async (): Promise<TelemetryNode[]> => {
    const rows = await this.options.db
      .select({ node: nodes, key: vpnKeys })
      .from(nodes)
      .leftJoin(
        vpnKeys,
        and(
          eq(vpnKeys.nodeId, nodes.id),
          inArray(vpnKeys.state, ["active", "disabled", "revoking"]),
        ),
      )
      .where(eq(nodes.enabled, true))
      .orderBy(nodes.name);
    const result = new Map<string, TelemetryNode>();
    for (const row of rows) {
      let node = result.get(row.node.id);
      if (!node) {
        node = {
          id: row.node.id,
          baseUrl: row.node.apiBaseUrl,
          apiKey: decryptSecret(
            {
              ciphertext: row.node.credentialsCiphertext,
              nonce: row.node.credentialsNonce,
              authTag: row.node.credentialsAuthTag,
              keyVersion: row.node.credentialsKeyVersion,
            },
            this.options.keyring,
          ),
          keys: [],
          // Carried into the poll so it can tell whether this node's address is
          // already known and skip the DNS lookup.
          publicHost: row.node.publicHost,
          publicIp: row.node.publicIp,
          // Only a node with an update in flight is asked about one, so a fleet
          // with nothing to update costs no extra request per tick.
          agentUpdateState: row.node.agentUpdateState,
          // Same again for a capacity change in flight.
          capacityState: row.node.capacityState,
          // Whether this node takes part in service checks at all, and which it
          // skips. Read here rather than joined per check: the poll already has
          // the node row, and a check the node does not run must never be
          // dispatched to it.
          checksEnabled: row.node.checksEnabled,
          disabledCheckIds: row.node.disabledCheckIds ?? [],
        };
        result.set(row.node.id, node);
      }
      if (row.key) {
        node.keys.push({
          keyId: row.key.id,
          publicKey: row.key.publicKey,
          nodeLabel: row.key.nodeLabel,
        });
      }
    }
    return [...result.values()];
  };

  recordNodeSnapshot = async (snapshot: NodeSnapshot): Promise<void> => {
    // Resolved BEFORE the transaction opens, never inside it: the resolver
    // reads the panel's settings row, and doing that while this transaction
    // already holds a pool connection is how a small pool deadlocks itself.
    const metricsSampleMs =
      (await resolveSeconds(
        this.options.metricsSampleSec,
        DEFAULT_METRICS_SAMPLE_SEC,
      )) * 1_000;
    const peerSampleMs =
      (await resolveSeconds(
        this.options.peerSampleSec,
        DEFAULT_PEER_SAMPLE_INTERVAL_MS / 1_000,
      )) * 1_000;
    await this.options.db.transaction(async (tx) => {
      const node = (
        await tx.select().from(nodes).where(eq(nodes.id, snapshot.nodeId)).limit(1)
      )[0];
      if (!node) return;
      const supportedProtocols = protocolsFromAgent(snapshot.server.protocols);
      await tx
        .update(nodes)
        .set({
          capabilities: {
            ...node.capabilities,
            reportedMaxPeers: snapshot.server.maxPeers,
            reportedTotalPeers: snapshot.server.totalPeers,
            healthz: true,
            serverStatus: true,
            serverLoad: true,
            diskMetrics: snapshot.load.disk !== null,
            networkMetrics: snapshot.load.network !== null,
            dockerMetrics: snapshot.load.docker !== null,
            freeMemoryAtLeast200MiB:
              snapshot.load.memory.freeBytes >= 200 * 1024 * 1024,
            // Protocol availability reported by the node agent, used by the
            // control API to offer only the protocols a node actually runs.
            awg2: supportedProtocols.includes("awg2"),
            awg3: supportedProtocols.includes("awg3"),
          },
          // The host is what the node reported this poll, including null when
          // it stops reporting one, so it is written unconditionally.
          publicHost: snapshot.publicHost,
          // The IP is not: a null here means "no new answer" — either the
          // address was already known and no lookup was made, or the lookup
          // failed. Writing it would blank a good value and make the admin card
          // flicker between an address and "not resolved". The timestamp
          // records when the address was LEARNED, not how fresh it is; a node's
          // public address does not change, so there is nothing to go stale.
          ...(snapshot.publicIp === null
            ? {}
            : {
                publicIp: snapshot.publicIp,
                publicIpResolvedAt: snapshot.observedAt,
              }),
          // undefined means the node was not asked this tick, so the stored
          // state is left alone; null means the agent does not serve the route,
          // which ends the wait rather than leaving the card spinning forever.
          ...(snapshot.agentUpdate === undefined
            ? {}
            : snapshot.agentUpdate === null
              ? {
                  agentUpdateState: "failed" as const,
                  agentUpdateMessage:
                    "The node-agent does not serve /server/update",
                  agentUpdateAt: snapshot.observedAt,
                }
              : {
                  agentUpdateState: snapshot.agentUpdate.state,
                  agentUpdateImage:
                    snapshot.agentUpdate.image ?? node.agentUpdateImage,
                  agentUpdateMessage: snapshot.agentUpdate.message ?? null,
                  agentUpdateLog: snapshot.agentUpdate.log,
                  agentUpdateAt: snapshot.agentUpdate.updatedAt
                    ? new Date(snapshot.agentUpdate.updatedAt)
                    : null,
                }),
          // The same three cases for capacity.
          ...(snapshot.capacity === undefined
            ? {}
            : snapshot.capacity === null
              ? {
                  capacityState: "failed" as const,
                  capacityMessage:
                    "The node-agent does not serve /server/capacity",
                  capacityAt: snapshot.observedAt,
                }
              : {
                  capacityState: snapshot.capacity.state,
                  capacityRequestedPeers:
                    snapshot.capacity.requestedMaxPeers ??
                    node.capacityRequestedPeers,
                  capacityMessage: snapshot.capacity.message ?? null,
                  capacityLog: snapshot.capacity.log,
                  capacityAt: snapshot.capacity.updatedAt
                    ? new Date(snapshot.capacity.updatedAt)
                    : null,
                }),
          lastHealthAt: snapshot.observedAt,
          lastSyncAt: snapshot.observedAt,
          lastError: null,
          updatedAt: snapshot.observedAt,
        })
        .where(eq(nodes.id, snapshot.nodeId));

      // Host metrics: one current row per node, replaced every tick, plus a
      // downsampled history row. They are written inside the same transaction
      // as the node row above, so a card never shows a fresh lastHealthAt next
      // to metrics from the previous tick.
      const metricsRow = toNodeMetricsRow(snapshot);
      await tx
        .insert(nodeMetricsCurrent)
        .values(metricsRow)
        // nodeId is the conflict target, so setting it to the value it already
        // has is a no-op and the row can be reused as the update verbatim.
        .onConflictDoUpdate({
          target: nodeMetricsCurrent.nodeId,
          set: metricsRow,
        });

      const [latestSample] = await tx
        .select({ sampledAt: nodeMetricsSamples.sampledAt })
        .from(nodeMetricsSamples)
        .where(eq(nodeMetricsSamples.nodeId, snapshot.nodeId))
        .orderBy(desc(nodeMetricsSamples.sampledAt))
        .limit(1);
      if (
        shouldStoreMetricsSample(
          snapshot.observedAt,
          latestSample?.sampledAt ?? null,
          metricsSampleMs,
        )
      ) {
        // Deliberately a subset of the current row: this table grows per node
        // per period forever, and the rest is either constant or only
        // interesting as its latest value.
        await tx.insert(nodeMetricsSamples).values({
          nodeId: snapshot.nodeId,
          sampledAt: snapshot.observedAt,
          load1: metricsRow.load1 ?? null,
          memAvailableBytes: metricsRow.memAvailableBytes ?? null,
          swapUsedBytes: metricsRow.swapUsedBytes ?? null,
          diskUsedPercent: metricsRow.diskUsedPercent ?? null,
          agentPidsCurrent: metricsRow.agentPidsCurrent ?? null,
          awg3Peers: metricsRow.awg3Peers ?? null,
        });
      }

      const observedKeyIds = new Set(snapshot.peers.map((peer) => peer.keyId));
      const missingRows = await tx
        .select({ current: peerCurrent })
        .from(vpnKeys)
        .innerJoin(peerCurrent, eq(peerCurrent.keyId, vpnKeys.id))
        .where(
          and(
            eq(vpnKeys.nodeId, snapshot.nodeId),
            inArray(vpnKeys.state, ["active", "disabled", "revoking"]),
          ),
        );
      const observations = [...snapshot.peers];
      for (const { current } of missingRows) {
        if (observedKeyIds.has(current.keyId)) continue;
        observations.push({
          keyId: current.keyId,
          online: false,
          endpoint: null,
          latestHandshakeAt: current.latestHandshakeAt,
          receivedBytes: current.receivedBytes,
          sentBytes: current.sentBytes,
          observedAt: snapshot.observedAt,
        });
      }
      for (const observation of observations) {
        await this.storePeerObservation(tx, observation, peerSampleMs);
      }
    });
  };

  private readonly storePeerObservation = async (
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    observation: PeerObservation,
    peerSampleMs: number,
  ): Promise<void> => {
    const latestSample = (
      await tx
        .select()
        .from(peerSamples)
        .where(eq(peerSamples.keyId, observation.keyId))
        .orderBy(desc(peerSamples.sampledAt))
        .limit(1)
    )[0];
    await tx
      .insert(peerCurrent)
      .values({
        keyId: observation.keyId,
        online: observation.online,
        endpoint: observation.endpoint,
        latestHandshakeAt: observation.latestHandshakeAt,
        receivedBytes: observation.receivedBytes,
        sentBytes: observation.sentBytes,
        observedAt: observation.observedAt,
      })
      .onConflictDoUpdate({
        target: peerCurrent.keyId,
        set: {
          online: observation.online,
          endpoint: observation.endpoint,
          latestHandshakeAt: observation.latestHandshakeAt,
          receivedBytes: observation.receivedBytes,
          sentBytes: observation.sentBytes,
          observedAt: observation.observedAt,
        },
      });
    if (observation.latestHandshakeAt) {
      await tx
        .update(vpnKeys)
        .set({
          lastUsedAt: observation.latestHandshakeAt,
          updatedAt: observation.observedAt,
        })
        .where(eq(vpnKeys.id, observation.keyId));
    }
    const previous = latestSample
      ? {
          keyId: latestSample.keyId,
          online: latestSample.online,
          endpoint: latestSample.endpoint,
          latestHandshakeAt: latestSample.latestHandshakeAt,
          receivedBytes: latestSample.receivedBytes,
          sentBytes: latestSample.sentBytes,
          observedAt: latestSample.sampledAt,
        }
      : null;
    if (shouldStoreSample(observation, previous, peerSampleMs)) {
      await tx.insert(peerSamples).values({
        keyId: observation.keyId,
        online: observation.online,
        endpoint: observation.endpoint,
        latestHandshakeAt: observation.latestHandshakeAt,
        receivedBytes: observation.receivedBytes,
        sentBytes: observation.sentBytes,
        sampledAt: observation.observedAt,
      });
    }
  };

  recordNodeFailure = async (
    nodeId: string,
    observedAt: Date,
    reason: string,
  ): Promise<void> => {
    await this.options.db
      .update(nodes)
      .set({ lastError: cleanReason(reason), updatedAt: observedAt })
      .where(eq(nodes.id, nodeId));
  };

  listServiceChecks = async (): Promise<{
    checks: NodeServiceCheck[];
    previousByNode: Map<string, Map<string, PreviousResult>>;
  }> => {
    // Two reads per tick for the whole fleet, not two per node: the definitions
    // are shared, and the results table has one row per (node, check).
    const [definitions, results] = await Promise.all([
      this.options.db
        .select({
          id: nodeServiceChecks.id,
          name: nodeServiceChecks.name,
          probe: nodeServiceChecks.probe,
          assertions: nodeServiceChecks.assertions,
          intervalSec: nodeServiceChecks.intervalSec,
          enabled: nodeServiceChecks.enabled,
          nextDueAt: nodeServiceChecks.nextDueAt,
        })
        .from(nodeServiceChecks),
      this.options.db
        .select({
          nodeId: nodeServiceCheckResults.nodeId,
          checkId: nodeServiceCheckResults.checkId,
          status: nodeServiceCheckResults.status,
          checkedAt: nodeServiceCheckResults.checkedAt,
          failingSince: nodeServiceCheckResults.failingSince,
        })
        .from(nodeServiceCheckResults),
    ]);

    const previousByNode = new Map<string, Map<string, PreviousResult>>();
    for (const row of results) {
      const perNode =
        previousByNode.get(row.nodeId) ?? new Map<string, PreviousResult>();
      perNode.set(row.checkId, {
        status: row.status,
        checkedAt: row.checkedAt,
        failingSince: row.failingSince,
      });
      previousByNode.set(row.nodeId, perNode);
    }

    return {
      checks: definitions.map((row) => ({
        ...row,
        assertions: row.assertions ?? [],
      })),
      previousByNode,
    };
  };

  recordServiceCheckResults = async (
    rows: ServiceCheckResultRow[],
  ): Promise<void> => {
    if (rows.length === 0) return;
    // One row per (node, check): the latest result IS the schedule, so there is
    // no history table here and nothing to prune.
    await this.options.db
      .insert(nodeServiceCheckResults)
      .values(rows)
      .onConflictDoUpdate({
        target: [nodeServiceCheckResults.nodeId, nodeServiceCheckResults.checkId],
        set: {
          status: sql`excluded.status`,
          httpStatus: sql`excluded.http_status`,
          latencyMs: sql`excluded.latency_ms`,
          detail: sql`excluded.detail`,
          finalUrl: sql`excluded.final_url`,
          checkedAt: sql`excluded.checked_at`,
          failingSince: sql`excluded.failing_since`,
        },
      });
  };

  loadSamplesSince = async (since: Date): Promise<TrafficSample[]> => {
    const projection = {
      keyId: peerSamples.keyId,
      sampledAt: peerSamples.sampledAt,
      receivedBytes: peerSamples.receivedBytes,
      sentBytes: peerSamples.sentBytes,
    };
    const [baselines, samples] = await Promise.all([
      this.options.db
        .selectDistinctOn([peerSamples.keyId], projection)
        .from(peerSamples)
        .where(lt(peerSamples.sampledAt, since))
        .orderBy(peerSamples.keyId, desc(peerSamples.sampledAt)),
      this.options.db
      .select({
        keyId: peerSamples.keyId,
        sampledAt: peerSamples.sampledAt,
        receivedBytes: peerSamples.receivedBytes,
        sentBytes: peerSamples.sentBytes,
      })
      .from(peerSamples)
      .where(gte(peerSamples.sampledAt, since))
        .orderBy(peerSamples.keyId, peerSamples.sampledAt),
    ]);
    return [...baselines, ...samples].sort(
      (left, right) =>
        left.keyId.localeCompare(right.keyId) ||
        left.sampledAt.getTime() - right.sampledAt.getTime(),
    );
  };

  replaceRollups = async (
    period: RollupPeriod,
    rollups: TrafficRollup[],
  ): Promise<void> => {
    if (rollups.length === 0) return;
    const earliest = new Date(
      Math.min(...rollups.map((rollup) => rollup.bucketStart.getTime())),
    );
    await this.options.db.transaction(async (tx) => {
      await tx
        .delete(trafficRollups)
        .where(
          and(
            eq(trafficRollups.period, period),
            gte(trafficRollups.bucketStart, earliest),
          ),
        );
      await tx.insert(trafficRollups).values(rollups);
    });
  };

  deleteSamplesBefore = async (cutoff: Date): Promise<void> => {
    await this.options.db
      .delete(peerSamples)
      .where(lt(peerSamples.sampledAt, cutoff));
  };

  deleteNodeMetricsSamplesBefore = async (cutoff: Date): Promise<void> => {
    await this.options.db
      .delete(nodeMetricsSamples)
      .where(lt(nodeMetricsSamples.sampledAt, cutoff));
  };

  deleteRollupsBefore = async (
    period: RollupPeriod,
    cutoff: Date,
  ): Promise<void> => {
    await this.options.db
      .delete(trafficRollups)
      .where(
        and(
          eq(trafficRollups.period, period),
          lt(trafficRollups.bucketStart, cutoff),
        ),
      );
  };

  getLastKnownGoodRule = async (
    profile: RuleProfile,
  ): Promise<{
    version: string;
    etag: string | null;
  } | null> => {
    const row = (
      await this.options.db
        .select({
          version: routeRuleVersions.version,
          etag: routeRuleVersions.sourceEtag,
        })
        .from(routeRuleVersions)
        .where(
          and(
            eq(routeRuleVersions.profile, profile),
            eq(routeRuleVersions.status, "active"),
          ),
        )
        .orderBy(desc(routeRuleVersions.publishedAt))
        .limit(1)
    )[0];
    return row ?? null;
  };

  storeQuarantinedRule = async (input: StoredRuleInput): Promise<void> => {
    await this.options.db
      .insert(routeRuleVersions)
      .values({
        profile: input.profile,
        version: input.version,
        sourceUrl: input.sourceUrl,
        sourceEtag: input.etag,
        sourceChecksum: input.checksum,
        status: "quarantined",
        cidrCount: input.payload.cidrs.length,
        domainCount: input.payload.domains.length,
        payload: input.payload,
        validationReport: input.validationReport,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt,
      })
      .onConflictDoNothing();
  };

  activateRuleVersion = async (input: StoredRuleInput): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      await tx
        .update(routeRuleVersions)
        .set({ status: "superseded", updatedAt: input.fetchedAt })
        .where(
          and(
            eq(routeRuleVersions.profile, input.profile),
            eq(routeRuleVersions.status, "active"),
            ne(routeRuleVersions.version, input.version),
          ),
        );
      await tx
        .insert(routeRuleVersions)
        .values({
          profile: input.profile,
          version: input.version,
          sourceUrl: input.sourceUrl,
          sourceEtag: input.etag,
          sourceChecksum: input.checksum,
          status: "active",
          cidrCount: input.payload.cidrs.length,
          domainCount: input.payload.domains.length,
          payload: input.payload,
          validationReport: input.validationReport,
          publishedAt: input.fetchedAt,
          createdAt: input.fetchedAt,
          updatedAt: input.fetchedAt,
        })
        .onConflictDoUpdate({
          target: [routeRuleVersions.profile, routeRuleVersions.version],
          set: {
            status: "active",
            publishedAt: input.fetchedAt,
            updatedAt: input.fetchedAt,
          },
        });
    });
  };
}
