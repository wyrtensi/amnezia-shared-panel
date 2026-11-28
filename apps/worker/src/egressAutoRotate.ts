/** Default minimum wait before rotating the same endpoint a second time in an ongoing outage. */
export const EGRESS_AUTO_ROTATE_COOLDOWN_MS = 60_000;

export type AutoRotateExitRecord = {
  id: string;
  ipv4: string;
  label: string | null;
  enabled: boolean;
  hostState: string;
};

export type AutoRotateEndpointRecord = {
  id: string;
  address: string;
  egressIpId: string | null;
  egressAutoRotatePoolIds: readonly string[];
};

/**
 * Decide whether an endpoint's probe outcome should trigger Exit IP auto-rotation.
 * Fires on the exact tick a per-endpoint reachability outage alert opens, or again
 * after the cooldown if the newly assigned Exit IP also reaches `failThreshold`
 * consecutive failures while an incident remains open.
 */
export const shouldTriggerEgressAutoRotate = (input: {
  massFailure: boolean;
  nodeEgressMode: string | null | undefined;
  endpoint: {
    enabled: boolean;
    egressAutoRotateEnabled: boolean;
    egressAutoRotatedAt: Date | null;
  };
  outcome: {
    status: string;
    state: {
      consecutiveFailures: number;
      alertedAt: Date | null;
    };
  };
  failThreshold: number;
  now: Date;
  cooldownMs?: number;
}): boolean => {
  if (input.massFailure) return false;
  if (!input.endpoint.enabled || !input.endpoint.egressAutoRotateEnabled) return false;
  if (input.nodeEgressMode !== "routed") return false;
  if (input.outcome.status !== "failed" || input.outcome.state.alertedAt === null) {
    return false;
  }
  if (input.outcome.state.alertedAt.getTime() === input.now.getTime()) {
    return true;
  }
  const cooldownMs = input.cooldownMs ?? EGRESS_AUTO_ROTATE_COOLDOWN_MS;
  return (
    input.outcome.state.consecutiveFailures >= input.failThreshold &&
    input.endpoint.egressAutoRotatedAt !== null &&
    input.now.getTime() - input.endpoint.egressAutoRotatedAt.getTime() >= cooldownMs
  );
};

/**
 * Pick the next eligible Exit IP from the endpoint's auto-rotation pool in
 * round-robin order after its current effective Exit IP, respecting active host
 * state, sibling `(address, egressIpId)` uniqueness, and unhealthy exits.
 */
export const selectAutoRotateExitIp = <TExit extends AutoRotateExitRecord>(input: {
  endpoint: AutoRotateEndpointRecord;
  nodeEgressDefaultIpId: string | null;
  nodeExits: readonly TExit[];
  occupiedSiblingExitIds: ReadonlySet<string>;
  failingExitCheckIds: ReadonlySet<string>;
  unhealthyEndpointExitIds: ReadonlySet<string>;
}): { previousExit: TExit | null; nextExit: TExit } | null => {
  const poolIds = input.endpoint.egressAutoRotatePoolIds;
  if (poolIds.length === 0) return null;

  const exitById = new Map(input.nodeExits.map((exit) => [exit.id, exit]));
  const currentExitId = input.endpoint.egressIpId ?? input.nodeEgressDefaultIpId ?? null;
  const previousExit = currentExitId ? (exitById.get(currentExitId) ?? null) : null;

  const currentIdx = currentExitId ? poolIds.indexOf(currentExitId) : -1;
  const orderedIds =
    currentIdx >= 0
      ? [...poolIds.slice(currentIdx + 1), ...poolIds.slice(0, currentIdx)]
      : [...poolIds];

  const seen = new Set<string>();
  const eligible: TExit[] = [];
  for (const candidateId of orderedIds) {
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    if (candidateId === currentExitId) continue;
    const exit = exitById.get(candidateId);
    if (!exit || !exit.enabled || exit.hostState !== "active") continue;
    if (input.occupiedSiblingExitIds.has(exit.id)) continue;
    if (input.unhealthyEndpointExitIds.has(exit.id)) continue;
    eligible.push(exit);
  }

  if (eligible.length === 0) return null;
  const chosen = eligible.find((exit) => !input.failingExitCheckIds.has(exit.id)) ?? eligible[0]!;
  return { previousExit, nextExit: chosen };
};

/** Format a Telegram operational notice when an endpoint rotates to a healthy Exit IP. */
export const formatEgressAutoRotateNotice = (input: {
  nodeName: string;
  endpointName: string;
  address: string;
  previousExit: { ipv4: string; label?: string | null } | null;
  nextExit: { ipv4: string; label?: string | null };
}): string => {
  const formatExit = (exit: { ipv4: string; label?: string | null } | null): string =>
    exit ? (exit.label ? `${exit.ipv4} (${exit.label})` : exit.ipv4) : "—";
  return (
    `🔄 Авторотация Exit IP: ${input.nodeName} — ${input.endpointName} (${input.address})\n` +
    `${formatExit(input.previousExit)} → ${formatExit(input.nextExit)}`
  );
};
