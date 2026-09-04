import type { KeyState, ProtocolKind } from "@amnezia/contracts";
import type { PeerObservation } from "./telemetry.js";

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
