import {
  BRIDGE_VERIFICATION_VALIDITY_MS,
  bridgeFrpProxyName,
  type BridgeErrorCode,
  type BridgeManagementStatus,
  type BridgeRouteState,
  type BridgeVerificationMethod,
  type BridgeVerificationResult,
} from "@amnezia/contracts";

/**
 * Pure decision rules for bridge route activation and release. They read only
 * stored rows, so the Control API applies them inside the transaction that
 * holds the node and route locks, and unit tests can pin every branch.
 *
 * Observation contract (filled by the bridge-agent poller, Task 5): on every
 * successful poll the poller stamps the bridge's `lastObservedAt` and, in the
 * same write, every held route of that bridge with `observedAt` set to the
 * same poll time. `observedOnline` is true only when frps reported a
 * registration whose proxy name equals the route's `frpProxyName` AND whose
 * remote port equals the route's `publicUdpPort`; the marker of that
 * registration goes to `observedRegistrationMarker`. A route the poll did not
 * see gets `observedOnline = false` (or null) with the fresh `observedAt`.
 * The schema has no observed-name or observed-port column for that reason.
 */

export type GuardBridge = {
  managementStatus: BridgeManagementStatus;
  lastObservedAt: Date | null;
};

export type GuardRoute = {
  id: string;
  state: BridgeRouteState;
  frpProxyName: string;
  observedOnline: boolean | null;
  observedRegistrationMarker: string | null;
  observedAt: Date | null;
  verificationMethod: BridgeVerificationMethod | null;
  verifiedRegistrationMarker: string | null;
  verifiedAt: Date | null;
  verificationResult: BridgeVerificationResult | null;
};

export type GuardFailure = {
  code: BridgeErrorCode;
  message: string;
};

/**
 * Whether the bridge's latest observation is current: the agent is enrolled
 * and answering (`ok`) and its last successful poll is within the stale
 * window. A pending, down, stale, mismatched or unsupported bridge is Unknown.
 */
export const isBridgeObservationFresh = (
  bridge: GuardBridge,
  now: Date,
  staleMs: number,
): boolean =>
  bridge.managementStatus === "ok" &&
  bridge.lastObservedAt !== null &&
  now.getTime() - bridge.lastObservedAt.getTime() <= staleMs;

/**
 * Whether the route's observation was written by the bridge's latest poll.
 * The poller stamps every held route with the poll time, so a route stamped
 * before the bridge's last observation was not covered by it.
 */
const isRouteCoveredByLatestPoll = (route: GuardRoute, bridge: GuardBridge): boolean =>
  route.observedAt !== null &&
  bridge.lastObservedAt !== null &&
  route.observedAt.getTime() >= bridge.lastObservedAt.getTime();

/**
 * Activation guard, parts (b) and (c) of the constraint; (a) route ownership
 * and state and (d) the endpoint revision are checked by the caller first.
 *
 * (b) The latest observation is fresh and reports this route online under
 *     its own proxy name (derived from the route id) with a registration
 *     marker. Otherwise BRIDGE_OBSERVATION_STALE.
 * (c) A successful verification of this route, bound to the marker the latest
 *     observation reports, no older than 30 minutes. Otherwise
 *     BRIDGE_ROUTE_UNVERIFIED.
 */
export const checkActivationGuard = (
  route: GuardRoute,
  bridge: GuardBridge,
  now: Date,
  staleMs: number,
): GuardFailure | null => {
  if (
    !isBridgeObservationFresh(bridge, now, staleMs) ||
    !isRouteCoveredByLatestPoll(route, bridge)
  ) {
    return {
      code: "BRIDGE_OBSERVATION_STALE",
      message: "The bridge has no current observation of this route",
    };
  }
  if (
    route.observedOnline !== true ||
    route.frpProxyName !== bridgeFrpProxyName(route.id) ||
    !route.observedRegistrationMarker
  ) {
    return {
      code: "BRIDGE_OBSERVATION_STALE",
      message: "The latest bridge observation does not report this route online",
    };
  }
  const verifiedAt = route.verifiedAt?.getTime();
  if (
    route.verificationResult !== "success" ||
    route.verificationMethod === null ||
    verifiedAt === undefined ||
    now.getTime() - verifiedAt > BRIDGE_VERIFICATION_VALIDITY_MS ||
    route.verifiedRegistrationMarker !== route.observedRegistrationMarker
  ) {
    return {
      code: "BRIDGE_ROUTE_UNVERIFIED",
      message:
        "The route needs a successful verification of its current registration within the last 30 minutes",
    };
  }
  return null;
};

/**
 * Release guard for a draft or retiring route (the caller refuses an active
 * one). A route is released only when the bridge observation is fresh
 * (`ok` and within the stale window), the route was covered by that latest
 * poll (`observedAt >= lastObservedAt`) and that poll did not report the
 * route's proxy name and port online (`observedOnline` is not true).
 * Anything else is Unknown and keeps the reservation:
 * BRIDGE_OBSERVATION_STALE. One exception, for a draft on a never-enrolled
 * bridge, is described inside.
 */
export const checkReleaseGuard = (
  route: GuardRoute,
  bridge: GuardBridge,
  now: Date,
  staleMs: number,
): GuardFailure | null => {
  // Exception (ruling R9): a DRAFT on a bridge that was never enrolled
  // (`pending_enrollment` and no observation ever stored) may be released on
  // the operator's confirmation alone. Before enrollment there is no
  // observation source at all, so the fresh-absent rule could never be met,
  // and the bridge could never be deleted either (a held route blocks it). A
  // retiring route has carried user traffic and keeps the full rule.
  if (
    route.state === "draft" &&
    bridge.managementStatus === "pending_enrollment" &&
    bridge.lastObservedAt === null
  ) {
    return null;
  }
  if (
    !isBridgeObservationFresh(bridge, now, staleMs) ||
    !isRouteCoveredByLatestPoll(route, bridge)
  ) {
    return {
      code: "BRIDGE_OBSERVATION_STALE",
      message:
        "The bridge has no current observation of this route, so the reservation is kept",
    };
  }
  if (route.observedOnline === true) {
    return {
      code: "BRIDGE_OBSERVATION_STALE",
      message:
        "The bridge still reports this route's forwarding online; remove it on the node first",
    };
  }
  return null;
};
