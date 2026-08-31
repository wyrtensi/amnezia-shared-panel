export type ProtocolKind = "awg2" | "awg3";

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
  keyCount: number;
  perNode?: Array<{ nodeId: string; used: number }>;
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
  protocol: ProtocolKind;
  maxPeers: number;
  supportedProtocols?: ProtocolKind[];
  selectableProtocols?: ProtocolKind[];
  lastHealthAt?: string | null;
};

export type KeyTraffic = { receivedBytes: string; sentBytes: string };

export type KeyView = {
  id: string;
  nodeId: string;
  state: string;
  protocol: string;
  deviceType: string;
  deviceLabel?: string | null;
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
