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
