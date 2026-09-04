import type { KeyState, ProtocolKind } from "@amnezia/contracts";
import type { AccessSyncArmReason } from "@amnezia/db";
import type { PeerObservation } from "./telemetry.js";

export type { AccessSyncArmReason };

export type OutboxJob = {
  id: string;
  type: string;
  attempts: number;
  payload: Record<string, unknown>;
};

export type WorkerKeyContext = {
  keyId: string;
  state: KeyState;
  nodeLabel: string;
  protocol: ProtocolKind;
  publicKey: string | null;
  node: {
    id: string;
    baseUrl: string;
    apiKey: string;
  };
};

export type NodeReconcileContext = {
  node: WorkerKeyContext["node"];
  keys: Array<{
    keyId: string;
    nodeLabel: string;
    publicKey: string | null;
  }>;
};

export type NodeReconcileSummary = {
  managedKeyCount: number;
  observedPeerCount: number;
  matchedPeerCount: number;
  missingManagedPeerCount: number;
  orphanNodePeerCount: number;
};

export type NodeReconcileResult = {
  jobId: string;
  nodeId: string;
  observedAt: Date;
  managedKeyIds: string[];
  peers: PeerObservation[];
  summary: NodeReconcileSummary;
};

export type NodeAgentUpdateRequested = {
  jobId: string;
  nodeId: string;
  image: string;
  requestedAt: Date;
};

export type NodeCapacityRequested = {
  jobId: string;
  nodeId: string;
  maxPeers: number;
  requestedAt: Date;
};

export type AccessReconcileResult = {
  /** Emails of accounts disabled because they are no longer allowed. */
  deactivated: string[];
  /** Admin accounts not in the allowlist, left untouched for manual review. */
  skippedAdmins: string[];
};

export interface WorkerRepository {
  claimJob: () => Promise<OutboxJob | null>;
  /**
   * Disable every active, non-admin user whose email is not in `allowedEmails`
   * (revoking their keys) — the deactivation half of Cloudflare Access sync.
   * Admins are never auto-disabled; an empty allowlist is treated as a
   * misconfiguration and changes nothing.
   */
  reconcileAccess: (allowedEmails: string[]) => Promise<AccessReconcileResult>;
  /**
   * Record that an Access sync run refused to disable an unexpectedly large set
   * of accounts. Written to the audit log so an operator sees it in the panel
   * rather than only in the worker's stdout. `overAbsoluteCap`/`overMajority`
   * say which half of the blast-radius cap fired (either or both) — without
   * them a proportional abort reads as self-contradictory (candidateCount
   * under limit) to whoever opens the row.
   */
  recordAccessSyncAborted: (details: {
    candidates: string[];
    limit: number;
    activeCount: number;
    overAbsoluteCap: boolean;
    overMajority: boolean;
  }) => Promise<void>;
  /**
   * Arm the single `access.sync` outbox row so the next poll runs a
   * reconciliation, coalescing a burst of changes into one run. A row already
   * pending or processing keeps its lifecycle columns -- the attempt in
   * flight is not disturbed -- but always gets a fresh marker, so a change
   * that lands mid-run causes one more run rather than being swallowed for an
   * hour. `reason` is recorded on the row for observability only.
   */
  armAccessSync: (reason: AccessSyncArmReason) => Promise<void>;
  /**
   * Complete the Access-sync job, but only if `armId` still matches the
   * row's current marker. If something armed the row again while this run
   * was in flight, leave it pending instead of completing it -- the change
   * costs one more run rather than being lost until the next hourly tick.
   */
  finishAccessSync: (jobId: string, armId: string) => Promise<void>;
  loadKeyContext: (keyId: string) => Promise<WorkerKeyContext | null>;
  loadNodeReconcileContext: (
    nodeId: string,
  ) => Promise<NodeReconcileContext | null>;
  completeNodeReconcile: (result: NodeReconcileResult) => Promise<void>;
  /** Mark the node as asked to update, and finish the job that asked. */
  completeNodeAgentUpdate: (
    result: NodeAgentUpdateRequested,
  ) => Promise<void>;
  completeNodeCapacityChange: (
    result: NodeCapacityRequested,
  ) => Promise<void>;
  /** Store the release the panel currently offers nodes, keyed by repository. */
  saveNodeAgentRelease: (release: {
    repository: string;
    version: string;
    digest: string;
    resolvedAt: Date;
  }) => Promise<void>;
  completeProvision: (result: {
    jobId: string;
    keyId: string;
    publicKey: string;
    vpnConfig: string;
  }) => Promise<void>;
  completeLifecycle: (
    jobId: string,
    keyId: string,
    state: KeyState,
  ) => Promise<void>;
  completeJob: (jobId: string) => Promise<void>;
  retryJob: (jobId: string, reason: string) => Promise<void>;
  failJob: (jobId: string, reason: string) => Promise<void>;
}
