import type { ReachabilityStatus } from "@amnezia/contracts";

export type BridgeIncident = {
  consecutiveFailures: number;
  failingSince: Date | null;
  alertedAt: Date | null;
};

export const EMPTY_BRIDGE_INCIDENT: BridgeIncident = {
  consecutiveFailures: 0,
  failingSince: null,
  alertedAt: null,
};

export const advanceBridgeIncident = (
  previous: BridgeIncident,
  status: ReachabilityStatus,
  now: Date,
  threshold: number,
): { state: BridgeIncident; notice: "down" | "up" | null } => {
  if (status === "error") return { state: previous, notice: null };
  if (status === "ok") {
    return { state: EMPTY_BRIDGE_INCIDENT, notice: previous.alertedAt ? "up" : null };
  }
  const consecutiveFailures = Math.min(previous.consecutiveFailures + 1, threshold);
  const opens = consecutiveFailures >= threshold && previous.alertedAt === null;
  return {
    state: {
      consecutiveFailures,
      failingSince: previous.failingSince ?? now,
      alertedAt: opens ? now : previous.alertedAt,
    },
    notice: opens ? "down" : null,
  };
};
