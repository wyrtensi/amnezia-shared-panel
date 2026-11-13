import {
  BRIDGE_VERIFICATION_VALIDITY_MS,
  type AdminOverviewBridge,
  type Bridge,
  type BridgeManagementStatus,
  type BridgeRouteRegistration,
  type BridgeRouteVerification,
} from "@amnezia/contracts";
import {
  isBridgeObservationFresh,
  isRouteCoveredByLatestPoll,
  type GuardBridge,
  type GuardRoute,
} from "./bridgeGuards.js";

/**
 * Pure admin read model for bridge routes: what the stored bridge-agent
 * observation says about one route, kept apart from management reachability
 * (the bridge's own status) and from end-to-end AWG evidence (verification).
 * Reads only stored rows, with the same freshness and coverage rules the
 * activation and release guards use, so what an admin sees as Unknown is
 * exactly what those guards refuse on.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * A stored `ok` bridge whose last observation is older than the stale window
 * (or that has none) reads as `stale`; the poller never stores `stale`.
 */
export const effectiveManagementStatus = (
  bridge: GuardBridge,
  now: Date,
  staleMs: number,
): BridgeManagementStatus =>
  bridge.managementStatus === "ok" && !isBridgeObservationFresh(bridge, now, staleMs)
    ? "stale"
    : bridge.managementStatus;

export const routeRegistration = (
  route: GuardRoute,
  bridge: GuardBridge,
  now: Date,
  staleMs: number,
): BridgeRouteRegistration => {
  const observedAt = iso(route.observedAt);
  if (
    !isBridgeObservationFresh(bridge, now, staleMs) ||
    !isRouteCoveredByLatestPoll(route, bridge) ||
    route.observedOnline === null
  ) {
    return { status: "unknown", marker: null, observedAt };
  }
  return route.observedOnline
    ? { status: "online", marker: route.observedRegistrationMarker, observedAt }
    : { status: "offline", marker: null, observedAt };
};

export const routeVerification = (
  route: GuardRoute,
  registration: BridgeRouteRegistration,
  now: Date,
): BridgeRouteVerification => {
  const base = {
    method: route.verificationMethod,
    verifiedAt: iso(route.verifiedAt),
  };
  if (route.verificationResult === null) {
    return { status: "none", method: null, verifiedAt: null, error: null };
  }
  if (route.verificationResult === "failure") {
    return {
      status: "failed",
      ...base,
      // Bounded code written by the verifier; read through from the row.
      error: route.verificationError ?? null,
    };
  }
  const verifiedAt = route.verifiedAt?.getTime();
  if (verifiedAt === undefined) {
    return { status: "expired", ...base, error: null };
  }
  // The 30-minute window gates activation. Nothing re-verifies an active
  // route afterwards (checks target draft and retiring routes), so an active
  // route's evidence stays valid for as long as it is bound to the
  // registration observed online now; a changed marker still invalidates it.
  if (
    route.state !== "active" &&
    now.getTime() - verifiedAt > BRIDGE_VERIFICATION_VALIDITY_MS
  ) {
    return { status: "expired", ...base, error: null };
  }
  if (registration.status !== "online") {
    return { status: "unknown", ...base, error: null };
  }
  return {
    status:
      registration.marker !== null &&
      registration.marker === route.verifiedRegistrationMarker
        ? "valid"
        : "marker_changed",
    ...base,
    error: null,
  };
};

/** Per-bridge counters for the overview Bridges block, from the computed bridge read model. */
export const overviewBridgeOf = (bridge: Bridge): AdminOverviewBridge => {
  const active = bridge.routes.filter((route) => route.state === "active");
  return {
    id: bridge.id,
    name: bridge.name,
    managementStatus: bridge.managementStatus,
    lastObservedAt: bridge.lastObservedAt,
    activeRoutes: active.length,
    verifiedActiveRoutes: active.filter((route) => route.verification.status === "valid")
      .length,
  };
};
