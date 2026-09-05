import type { InstallGuideVideos } from "@amnezia/contracts";

export type ProtocolKind = "awg2" | "awg3";

// How a user's key limit is counted: separately on each server, or as one
// shared pool across all of them. Mirrors the contract's `keyLimitModeSchema`.
export type KeyLimitMode = "per_node" | "global";

export type PortalPolicy = {
  allowKeyCreation?: boolean;
  allowNodeSelection?: boolean;
  allowRouteProfileSelection?: boolean;
  allowCustomRoutes?: boolean;
  allowConfigRedownload?: boolean;
  allowQrDownload?: boolean;
  allowConfDownload?: boolean;
  allowSelfRevoke?: boolean;
  showPublicKey?: boolean;
  showLastUsed?: boolean;
  showTraffic?: boolean;
  allowedProtocols?: ProtocolKind[];
  keyLimitMode?: KeyLimitMode;
  // Sourced from the contract rather than restated: this file is a hand-written
  // mirror of PortalPolicy, and a per-audience map is exactly the shape that
  // drifts silently when it is copied.
  installGuideVideos?: InstallGuideVideos | null;
};

// Per-user extra routes layered on a split-tunnel profile's base feed.
export type CustomRouteList = { cidrs: string[]; domains: string[] };
export type CustomRoutes = {
  ru_whitelist: CustomRouteList;
  ru_blacklist: CustomRouteList;
};

export const EMPTY_CUSTOM_ROUTES: CustomRoutes = {
  ru_whitelist: { cidrs: [], domains: [] },
  ru_blacklist: { cidrs: [], domains: [] },
};

export type Me = {
  id: string;
  email: string;
  displayName: string | null;
  role: "user" | "admin";
  keyLimit: number;
  // Absent only on older payloads; treat as "per_node".
  keyLimitMode?: KeyLimitMode;
  keyCount: number;
  // Per-node quota. In per-node mode `limit` is that node's effective limit; in
  // global mode every entry carries the pool. Absent only on older payloads,
  // where `keyLimit` is the fallback.
  perNode?: Array<{ nodeId: string; used: number; limit?: number }>;
  policy: PortalPolicy;
  customRoutes?: CustomRoutes;
};

// Per-node traffic totals for Today / 7 days / Month, all at once.
export type TrafficPair = { receivedBytes: string; sentBytes: string };
export type NodeTraffic = {
  nodeId: string;
  today: TrafficPair;
  week: TrafficPair;
  month: TrafficPair;
};

/** A check as an ADMIN sees it, with every node's verdict in full. */
export type AdminServiceCheck = {
  id: string;
  name: string;
  probe: { kind: string; url?: string; method?: string };
  assertions: Array<Record<string, unknown>>;
  intervalSec: number;
  enabled: boolean;
  results?: Array<{
    nodeId: string;
    nodeName: string;
    // ok / failed / error, and the three stay distinct here: an admin needs to
    // know the node could not look, which the user surface collapses.
    status: "ok" | "failed" | "error";
    httpStatus: number | null;
    latencyMs: number | null;
    detail: string | null;
    finalUrl: string | null;
    checkedAt: string;
    failingSince: string | null;
  }>;
};

/** One service check on one server, as a user is shown it: a name and a word. */
export type ServiceCheckSummary = {
  name: string;
  state: "works" | "unavailable" | "unknown";
};

/**
 * Host metrics as of the node's last poll. Every field is nullable in both
 * directions: an agent that predates a field omits it, and one that cannot read
 * it reports null. A zero would read as a measurement, so the card shows a dash.
 */
export type AdminNodeMetrics = {
  observedAt: string;
  agentLatencyMs: number | null;
  uptimeSec: number | null;
  cpuCores: number | null;
  load1: number | null;
  memTotalBytes: string | null;
  memAvailableBytes: string | null;
  swapTotalBytes: string | null;
  swapUsedBytes: string | null;
  diskTotalBytes: string | null;
  diskAvailableBytes: string | null;
  diskUsedPercent: number | null;
  agentPidsCurrent: number | null;
  agentPidsMax: number | null;
  awg3Up: boolean | null;
  awg3Peers: number | null;
  awg2Up: boolean | null;
  awg2Peers: number | null;
  listenPorts: number[] | null;
};

/**
 * Derived from the newest peer handshake, never probed. The panel cannot reach
 * a node's public endpoint, so a real user's connection succeeding is the
 * evidence - which is why this is shown as "last handshake N minutes ago"
 * rather than as a reachability verdict.
 */
export type NodeEndpointSignal = {
  status: "reachable" | "stale" | "unknown";
  lastHandshakeAt: string | null;
};

export type NodeView = {
  id: string;
  name: string;
  /**
   * Set by the global policy. Presentation only: it decides whether the badge
   * is drawn, never where the node appears — the API sends the list already in
   * the admin's order.
   */
  recommended?: boolean;
  protocol: ProtocolKind;
  maxPeers: number;
  supportedProtocols?: ProtocolKind[];
  selectableProtocols?: ProtocolKind[];
  lastHealthAt?: string | null;
  /**
   * Service checks for this server. Present only when the portal policy's
   * showNodeStatus is on, which is why it is optional rather than nullable -
   * "this panel does not show them" is a different statement from "this server
   * has none". It carries `checks` and nothing else: node health is already
   * shown from enabled/lastError/lastHealthAt, and a second vocabulary for the
   * same thing is what the narrowing exists to prevent.
   */
  status?: { checks: ServiceCheckSummary[] };
  /**
   * Where clients reach this node — the resolved IPv4 when the panel has one,
   * else the host the node reported. Present only when the portal policy's
   * showNodeAddress is on for this user; absent otherwise, which is why it is
   * optional rather than nullable.
   */
  publicAddress?: string | null;
};

export type KeyTraffic = { receivedBytes: string; sentBytes: string };

export type KeyView = {
  id: string;
  nodeId: string;
  state: string;
  protocol: string;
  deviceType: string;
  deviceLabel?: string | null;
  keyNumber?: number | null;
  /**
   * The operator-only note on the key.
   *
   * Optional because the SERVER decides whether it exists: `/api/keys` carries
   * it only when the caller is an administrator looking at their own key, and
   * leaves the property off the payload entirely for anyone else. A regular
   * user's key never has this field, which is why a real person's name is safe
   * in it — the note is not sent and then hidden, it is not sent.
   */
  internalName?: string | null;
  routeProfile: string;
  rulesOutdated?: boolean;
  createdAt: string;
  lastUsedAt?: string | null;
  traffic?: KeyTraffic;
};

export type RouteProfile = "full_tunnel" | "ru_whitelist" | "ru_blacklist";

export type RouteProfileAvailability = {
  profile: RouteProfile;
  available: boolean;
  activeVersion: string | null;
};
