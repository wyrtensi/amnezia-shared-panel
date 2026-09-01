import type { NodeKeyLimits } from "@amnezia/contracts";
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
