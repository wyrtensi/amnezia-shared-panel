/**
 * The "healthy nodes" metric of the admin overview. It reads only the VPN
 * node counters (`overview.nodes`): bridges arrive in their own `bridges`
 * block and never count here.
 */
export const nodesHealthyValue = (
  overview: { nodes?: { healthy: number; total: number } } | null | undefined,
  fallbackNodeCount: number,
): string =>
  overview?.nodes
    ? `${overview.nodes.healthy}/${overview.nodes.total}`
    : `${fallbackNodeCount}`;
