import {
  BRIDGE_ERROR_CODES,
  type BridgeRouteVerification,
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

/**
 * Badge tone for the AWG-path evidence (candidate verification of a draft or
 * retiring route, or the regular AWG 3.1 result of an active one), kept apart
 * from management status. The values themselves come from the API.
 */
export const verificationTone = (verification: BridgeRouteVerification): BadgeTone => {
  switch (verification.status) {
    case "valid":
    case "ok":
      return "success";
    case "failed":
      return "destructive";
    case "none":
      return "outline";
    case "unknown":
      return verification.kind === "awg_path" ? "outline" : "warning";
    default:
      return "warning";
  }
};

/** Message key for a verification: candidate states and AWG path states differ. */
export const verificationLabelKey = (verification: BridgeRouteVerification): string =>
  verification.kind === "awg_path"
    ? `bridge.awg.${verification.status}`
    : `bridge.ver.${verification.status}`;

/** When the evidence behind a verification was produced, if it has a time. */
export const verificationTime = (verification: BridgeRouteVerification): string | null =>
  verification.kind === "awg_path" ? verification.checkedAt : verification.verifiedAt;
