import type { AdminNode } from "@/components/admin/admin-data";

/**
 * One selectable/orderable server address in admin policy views.
 *
 * Multi-IP nodes expand into one target per public endpoint (keyed by endpoint
 * UUID). Nodes that have not registered any public endpoints yet fall back to a
 * single target keyed by `node.id` so older or AWG-2-only nodes stay manageable.
 */
export type PolicyTarget = {
  id: string;
  nodeId: string;
  name: string;
  address: string | null;
  nodeName: string;
  enabled: boolean;
  isEndpoint: boolean;
};

export const expandPolicyTargets = (
  nodes: readonly AdminNode[],
): PolicyTarget[] =>
  nodes.flatMap<PolicyTarget>((node) => {
    const endpoints = node.publicEndpoints ?? [];
    if (endpoints.length > 0) {
      return endpoints.map((endpoint) => ({
        id: endpoint.id,
        nodeId: node.id,
        name: endpoint.name,
        address: endpoint.publicAddress,
        nodeName: node.name,
        enabled: node.enabled && endpoint.enabled,
        isEndpoint: true,
      }));
    }
    return [
      {
        id: node.id,
        nodeId: node.id,
        name: node.name,
        address: node.publicIp ?? node.publicHost ?? null,
        nodeName: node.name,
        enabled: node.enabled,
        isEndpoint: false,
      },
    ];
  });

/**
 * Resolves the initial per-IP allowlist for policy editors.
 *
 * When `allowedEndpointIds` is explicitly set (including an empty list), use
 * it directly. Otherwise upgrade a legacy `allowedNodeIds` restriction into the
 * target ids belonging to those nodes. Null in both means "everything allowed".
 */
export const initialAllowedTargetIds = (
  targets: readonly PolicyTarget[],
  allowedEndpointIds: readonly string[] | null | undefined,
  allowedNodeIds: readonly string[] | null | undefined,
): string[] | null => {
  if (allowedEndpointIds !== null && allowedEndpointIds !== undefined) {
    return [...allowedEndpointIds];
  }
  if (allowedNodeIds !== null && allowedNodeIds !== undefined) {
    const allowed = new Set(allowedNodeIds);
    return targets
      .filter((target) => allowed.has(target.nodeId))
      .map((target) => target.id);
  }
  return null;
};

/**
 * Keeps the legacy `allowedNodeIds` column aligned with a per-IP allowlist so
 * older clients, quota checks, and single-IP filters see the same set of nodes.
 */
export const deriveAllowedNodeIds = (
  targets: readonly PolicyTarget[],
  allowedTargetIds: readonly string[] | null,
): string[] | null => {
  if (allowedTargetIds === null) return null;
  const selected = new Set(allowedTargetIds);
  const nodeIds: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (!selected.has(target.id) || seen.has(target.nodeId)) continue;
    seen.add(target.nodeId);
    nodeIds.push(target.nodeId);
  }
  return nodeIds;
};

/**
 * Resolves the initial explicit per-IP server order from saved `endpointOrder`,
 * falling back to expanding legacy `nodeOrder` when no endpoint order exists.
 */
export const initialEndpointOrder = (
  targets: readonly PolicyTarget[],
  endpointOrder: readonly string[] = [],
  nodeOrder: readonly string[] = [],
): string[] => {
  if (endpointOrder.length > 0) return [...endpointOrder];
  if (nodeOrder.length === 0) return [];
  const byNode = new Map<string, string[]>();
  for (const target of targets) {
    const list = byNode.get(target.nodeId) ?? [];
    list.push(target.id);
    byNode.set(target.nodeId, list);
  }
  const expanded: string[] = [];
  for (const nodeId of nodeOrder) {
    expanded.push(...(byNode.get(nodeId) ?? []));
  }
  return expanded;
};

/**
 * Resolves the initial per-IP recommended prefix, upgrading legacy
 * `recommendedNodeIds` only when `endpointOrder` has not been customized yet.
 */
export const initialRecommendedEndpointIds = (
  targets: readonly PolicyTarget[],
  endpointOrder: readonly string[] = [],
  recommendedEndpointIds: readonly string[] = [],
  recommendedNodeIds: readonly string[] = [],
): string[] => {
  if (recommendedEndpointIds.length > 0) return [...recommendedEndpointIds];
  if (endpointOrder.length > 0 || recommendedNodeIds.length === 0) return [];
  const byNode = new Map<string, string[]>();
  for (const target of targets) {
    const list = byNode.get(target.nodeId) ?? [];
    list.push(target.id);
    byNode.set(target.nodeId, list);
  }
  const expanded: string[] = [];
  for (const nodeId of recommendedNodeIds) {
    expanded.push(...(byNode.get(nodeId) ?? []));
  }
  return expanded;
};

/**
 * Derives `nodeOrder` and `recommendedNodeIds` from an explicit per-IP order
 * and its recommended prefix. Because `recommendedTargetIds` is a prefix of
 * `orderedTargetIds`, the unique owning nodes of that prefix are guaranteed to
 * form a valid prefix of the derived `nodeOrder`.
 */
export const deriveNodeOrderFromTargets = (
  targets: readonly PolicyTarget[],
  orderedTargetIds: readonly string[],
  recommendedTargetIds: readonly string[],
): { nodeOrder: string[]; recommendedNodeIds: string[] } => {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const nodeOrder: string[] = [];
  const seenNodes = new Set<string>();
  for (const targetId of orderedTargetIds) {
    const nodeId = byId.get(targetId)?.nodeId;
    if (!nodeId || seenNodes.has(nodeId)) continue;
    seenNodes.add(nodeId);
    nodeOrder.push(nodeId);
  }
  const recommendedNodeIds: string[] = [];
  const seenRec = new Set<string>();
  for (const targetId of recommendedTargetIds) {
    const nodeId = byId.get(targetId)?.nodeId;
    if (!nodeId || seenRec.has(nodeId)) continue;
    seenRec.add(nodeId);
    recommendedNodeIds.push(nodeId);
  }
  return { nodeOrder, recommendedNodeIds };
};
