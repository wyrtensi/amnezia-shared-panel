import type { KeyLimitMode, NodeKeyLimits } from "@amnezia/contracts";
import { effectiveKeyLimit } from "@amnezia/db";

/**
 * Everything needed to answer "may this user use that node, and how many keys
 * may they hold on it?". Built once per request from the user row and the
 * policy that already resolved the per-user override over the global default.
 */
export type NodeQuotaContext = {
  /** Org-wide `portal_policy.default_key_limit`. */
  defaultKeyLimit: number;
  /** `users.key_limit_override` — the user's flat limit on every node. */
  keyLimitOverride: number | null | undefined;
  /** `users.node_key_limits` — per-node limits that beat the flat override. */
  nodeKeyLimits: NodeKeyLimits | null | undefined;
};

/**
 * Per-node key limit, resolved in this order:
 *   per-node entry > user flat override > global default.
 *
 * `0` is a meaningful limit (no keys on that node), so every step uses `??` and
 * never a truthiness check.
 */
export const resolveNodeKeyLimit = (
  context: NodeQuotaContext,
  nodeId: string,
): number =>
  context.nodeKeyLimits?.[nodeId] ??
  effectiveKeyLimit(context.defaultKeyLimit, context.keyLimitOverride);

/**
 * The shared pool in global mode: the user's flat override, else the global
 * default. Per-node entries are dormant in that mode and never consulted.
 */
export const resolvePoolKeyLimit = (context: NodeQuotaContext): number =>
  effectiveKeyLimit(context.defaultKeyLimit, context.keyLimitOverride);

/** How many quota-counted keys the user already holds, on the node and overall. */
export type KeyUsage = {
  keysOnNode: number;
  keysTotal: number;
};

/**
 * Whether one more key may be created on `nodeId`, given the effective mode:
 *   per_node: keys on that node < that node's resolved limit;
 *   global:   keys on every node together < the pool.
 * Node capacity (`nodes.maxPeers`) is a separate check and not part of this.
 */
export const hasRoomForKey = (
  context: NodeQuotaContext,
  mode: KeyLimitMode,
  nodeId: string,
  usage: KeyUsage,
): boolean =>
  mode === "global"
    ? usage.keysTotal < resolvePoolKeyLimit(context)
    : usage.keysOnNode < resolveNodeKeyLimit(context, nodeId);

/**
 * Whether the node is offered to this user, given the resolved
 * `policy.allowedNodeIds`. A null/absent list means "all nodes"; an empty list
 * means the user has no node at all.
 */
export const isNodeAvailable = (
  allowedNodeIds: readonly string[] | null | undefined,
  nodeId: string,
): boolean => allowedNodeIds == null || allowedNodeIds.includes(nodeId);

/** The node ids that carry an explicit per-node limit for this user. */
export const nodeIdsWithExplicitLimit = (
  nodeKeyLimits: NodeKeyLimits | null | undefined,
): string[] => Object.keys(nodeKeyLimits ?? {});

/** A pending quota request, reduced to what approving it needs. */
export type ApprovableQuotaRequest = {
  requestedLimit: number;
  /** Target server, or null for "every server". */
  nodeId: string | null;
};

/** The user columns an approval rewrites, plus what the audit log records. */
export type QuotaApproval = {
  keyLimitOverride: number | null;
  nodeKeyLimits: NodeKeyLimits | null;
  /** Per-node entries dropped so the grant cannot be shadowed. */
  clearedNodeLimitCount: number;
  /**
   * True when a per-server request was approved while the user's effective
   * mode is global: the target server is meaningless there, so the grant
   * raised the pool instead. Surfaced in the audit log and the admin UI.
   */
  targetCoerced: boolean;
};

/**
 * What approving a quota request writes on the user row.
 *
 * An approval is a deliberate admin decision, so the granted number must
 * actually hold and must never be shadowed by an earlier per-node value.
 *
 * Per-node mode:
 * - Target = one server: set `nodeKeyLimits[nodeId]`, keeping every other entry
 *   and the flat override untouched. A per-node entry already beats the flat
 *   override, so nothing else is needed.
 * - Target = every server: set the flat override AND clear the per-node
 *   entries, which would otherwise keep overriding the grant on exactly the
 *   servers the admin just said yes to.
 *
 * Global mode: the number is the pool, so the flat override is set whatever
 * the request targeted; per-node entries are dormant there and are left as
 * they are so switching back to per-node mode restores them. A request that
 * still names a server (created before the mode changed) is reported as
 * coerced.
 *
 * This concerns the number of keys only — node availability
 * (`policyOverride.allowedNodeIds`) is never widened here.
 */
export const resolveQuotaApproval = (
  current: {
    keyLimitOverride: number | null | undefined;
    nodeKeyLimits: NodeKeyLimits | null | undefined;
  },
  request: ApprovableQuotaRequest,
  mode: KeyLimitMode,
): QuotaApproval => {
  const existing = current.nodeKeyLimits ?? {};
  if (mode === "global") {
    return {
      keyLimitOverride: request.requestedLimit,
      nodeKeyLimits: current.nodeKeyLimits ?? null,
      clearedNodeLimitCount: 0,
      targetCoerced: request.nodeId !== null,
    };
  }
  if (request.nodeId === null) {
    return {
      keyLimitOverride: request.requestedLimit,
      nodeKeyLimits: null,
      clearedNodeLimitCount: Object.keys(existing).length,
      targetCoerced: false,
    };
  }
  return {
    keyLimitOverride: current.keyLimitOverride ?? null,
    nodeKeyLimits: { ...existing, [request.nodeId]: request.requestedLimit },
    clearedNodeLimitCount: 0,
    targetCoerced: false,
  };
};
