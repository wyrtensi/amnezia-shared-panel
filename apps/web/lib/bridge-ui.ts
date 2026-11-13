import {
  BRIDGE_ERROR_CODES,
  BRIDGE_OBSERVATION_STALE_MS_DEFAULT,
  BRIDGE_VERIFICATION_VALIDITY_MS,
  type NodeBridgeRoute,
} from "@amnezia/contracts";
import { ApiClientError } from "@/lib/api";

/**
 * Presentation helpers for the bridge screens. Pure and free of React.
 *
 * Nothing here decides whether an action is allowed: the Control API owns
 * every guard. These helpers only choose labels, links and message keys.
 */

export type NodesTab = "nodes" | "bridges";

export const parseNodesTab = (raw: string | null | undefined): NodesTab =>
  raw === "bridges" ? "bridges" : "nodes";

export const NODES_PATH = "/admin/nodes";
export const nodesTabHref = (tab: NodesTab): string =>
  tab === "bridges" ? `${NODES_PATH}?tab=bridges` : NODES_PATH;

export const NODE_ROUTES_ANCHOR = "node-routes";

/** Link to the route editor with a node preselected. */
export const nodeRouteEditorHref = (nodeId: string): string =>
  `/admin/policy?node=${encodeURIComponent(nodeId)}#${NODE_ROUTES_ANCHOR}`;

/** What the AWG service listens on in the standard node deployment. */
export const DEFAULT_LOCAL_TARGET = "127.0.0.1:51890/udp";

export const bridgeEntry = (ip: string, port: number): string => `${ip}:${port}`;

/** How many routes (one UDP port each) a pool of `[start, end]` can hold. */
export const poolCapacity = (start: number, end: number): number =>
  Number.isInteger(start) && Number.isInteger(end) && end >= start
    ? end - start + 1
    : 0;

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  ...BRIDGE_ERROR_CODES,
  "CONFIRMATION_REQUIRED",
]);

/** Codes after which the editor's data is stale and must be reloaded. */
const REFETCH_CODES: ReadonlySet<string> = new Set([
  "BRIDGE_REVISION_CONFLICT",
  "BRIDGE_ROUTE_UNVERIFIED",
  "BRIDGE_OBSERVATION_STALE",
  "BRIDGE_CONFIG_UNSUPPORTED",
  "BRIDGE_ROUTE_NOT_FOUND",
  "BRIDGE_ROUTE_ACTIVE",
  "BRIDGE_CHECK_PENDING",
]);

export const bridgeErrorKey = (code: string): string | null =>
  KNOWN_ERROR_CODES.has(code) ? `bridge.err.${code}` : null;

/**
 * A readable message for a failed bridge request, and whether the caller
 * should reload its data because the failure means it was looking at stale
 * state. Unknown codes fall back to the API's own message.
 */
export const describeBridgeError = (
  cause: unknown,
  t: (key: string) => string,
  fallbackKey = "bridge.err.generic",
): { code: string | null; message: string; refetch: boolean } => {
  if (cause instanceof ApiClientError) {
    const key = bridgeErrorKey(cause.code);
    return {
      code: cause.code,
      message: key ? t(key) : cause.message || t(fallbackKey),
      refetch: REFETCH_CODES.has(cause.code),
    };
  }
  return {
    code: null,
    message: cause instanceof Error && cause.message ? cause.message : t(fallbackKey),
    refetch: false,
  };
};

export type RouteObservation = {
  /** `unknown` covers both "never observed" and "observation too old". */
  status: "online" | "offline" | "unknown";
  marker: string | null;
  observedAt: string | null;
};

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

/**
 * Display-only reading of the stored observation. It mirrors the API's
 * freshness rule closely enough to label a value Unknown rather than show a
 * stale "online"; the activation guard itself runs on the server.
 */
export const routeObservation = (
  route: NodeBridgeRoute,
  now: number,
  staleMs: number = BRIDGE_OBSERVATION_STALE_MS_DEFAULT,
): RouteObservation => {
  const unknown: RouteObservation = {
    status: "unknown",
    marker: null,
    observedAt: route.observedAt,
  };
  const bridgeAt = ms(route.bridgeLastObservedAt);
  const routeAt = ms(route.observedAt);
  if (
    route.bridgeManagementStatus !== "ok" ||
    bridgeAt === null ||
    routeAt === null ||
    now - bridgeAt > staleMs ||
    routeAt < bridgeAt ||
    route.observedOnline === null
  ) {
    return unknown;
  }
  return {
    status: route.observedOnline ? "online" : "offline",
    marker: route.observedRegistrationMarker,
    observedAt: route.observedAt,
  };
};

export type VerificationView =
  | { status: "none" }
  | { status: "failed"; method: string | null; error: string | null; at: string | null }
  | { status: "expired"; method: string | null; at: string | null }
  | { status: "marker_changed"; method: string | null; at: string | null }
  | { status: "valid"; method: string | null; at: string | null };

/** The verification as the route editor describes it; the API decides what activates. */
export const routeVerification = (
  route: NodeBridgeRoute,
  now: number,
): VerificationView => {
  if (route.verificationResult === null) return { status: "none" };
  const at = route.verifiedAt;
  if (route.verificationResult === "failure") {
    return {
      status: "failed",
      method: route.verificationMethod,
      error: route.verificationError,
      at,
    };
  }
  const verifiedMs = ms(at);
  if (verifiedMs === null || now - verifiedMs > BRIDGE_VERIFICATION_VALIDITY_MS) {
    return { status: "expired", method: route.verificationMethod, at };
  }
  if (
    route.observedRegistrationMarker !== null &&
    route.verifiedRegistrationMarker !== route.observedRegistrationMarker
  ) {
    return { status: "marker_changed", method: route.verificationMethod, at };
  }
  return { status: "valid", method: route.verificationMethod, at };
};

/**
 * Whether the bridge host still needs its one-time setup. A bridge that has
 * reported at least once, or that already carries an active or retiring
 * route, was configured earlier: adding another node must not repeat it.
 */
export const bridgeNeedsHostSetup = (bridge: {
  lastObservedAt: string | null;
  routes: ReadonlyArray<{ state: "draft" | "active" | "retiring" }>;
}): boolean =>
  bridge.lastObservedAt === null &&
  bridge.routes.every((route) => route.state === "draft");

export type BadgeTone = "success" | "outline" | "warning" | "destructive";

/** Badge tone for a route's registration; Unknown is neutral, never a failure. */
export const registrationTone = (
  status: "online" | "offline" | "unknown",
): BadgeTone =>
  status === "online" ? "success" : status === "offline" ? "destructive" : "outline";

/** Badge tone for the AWG-path evidence, kept apart from management status. */
export const verificationTone = (
  status: "none" | "valid" | "unknown" | "marker_changed" | "expired" | "failed",
): BadgeTone =>
  status === "valid"
    ? "success"
    : status === "failed"
      ? "destructive"
      : status === "none"
        ? "outline"
        : "warning";
