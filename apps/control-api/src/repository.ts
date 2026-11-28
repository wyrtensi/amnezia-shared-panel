import type {
  AwgConfigLevelName,
  AwgGeneratorSettings,
  AccessSyncStatus,
  AdminReachabilityView,
  Bridge,
  BridgeRotationEvidence,
  CreateBridgeRequest,
  DeleteBridgeResult,
  BridgeAgentUpdateView,
  BridgeRollbackPreflight,
  RequestBridgeAgentUpdate,
  RequestBridgeAgentUpdateResult,
  InfrastructureItem,
  BridgeEligibility,
  NodeBridgeRoute,
  NodeBridgeRoutes,
  PrepareBridgeRouteRequest,
  PrepareBridgeRouteResult,
  ReleaseBridgeRouteResult,
  UpdateBridgeRequest,
  UpdateBridgeRouteTransportRequest,
  VerifyBridgeRouteRequest,
  VerifyBridgeRouteResult,
  AdminReassignKeyEndpointRequest,
  CreateNodeEgressIpRequest,
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateKeyRequest,
  CreateUserRequest,
  CustomRoutes,
  DeleteNodeOptions,
  DeviceType,
  GlobalRoutes,
  KeyNameDisplay,
  KeyState,
  NodeEgressIp,
  NodeEgressMode,
  NodeEgressModeState,
  NodeIpv6RejectStubState,
  NotifyKeyUpdateRequest,
  NotifyKeyUpdateResult,
  NoticeAcks,
  NoticeKind,
  PortalPolicy,
  QuotaRequest,
  RouteProfile,
  RulesRefreshStatus,
  SwapNodeEgressIpRequest,
  UpdateNodeEgressIpRequest,
  UpdateNodeEgressModeRequest,
  UpdateNodeIpv6RejectStubRequest,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
  UpsertReachabilityProbeRequest,
  ResolvedAwgClientSettings,
} from "@amnezia/contracts";
import type { EncryptedSecret } from "@amnezia/db";
import type { NodeEgressVerifyTarget } from "./nodeEgressVerifier.js";
import type {
  Actor,
  IdentityClaim,
  KeyView,
  ReachabilityHistoryEntry,
  ReachabilityHistoryQuery,
  ReachabilityProbeView,
} from "./service.js";
import type { AwgClientProfileV1 } from "./awgClientProfile.js";
import type { BridgeRouteTarget } from "./bridgeRepository.js";
import type { RulePayload } from "./vpnConfig.js";

export type ActiveRule = {
  versionId: string;
  version: string;
  payload: RulePayload;
};

export type StoredKeyConfig = {
  id: string;
  ownerId: string;
  /** The VPN node that issued the key. */
  nodeId: string;
  deviceLabel: string | null;
  // Per-owner key number and the node's user-facing name. Which of them end up
  // in the client-visible connection name is decided by `nameDisplay`.
  keyNumber: number | null;
  nodeDisplayName: string;
  directAddress?: string;
  nameDisplay: KeyNameDisplay;
  encrypted: EncryptedSecret;
  policy: PortalPolicy;
  routeProfile: RouteProfile;
  appliedRuleVersionId: string | null;
  activeRule: ActiveRule | null;
  customRoutes: CustomRoutes | null;
  state: KeyState;
  /** The protocol the key was issued with; decides Direct versus bridge. */
  protocol: "awg2" | "awg3";
  /**
   * The node's active bridge route as public host and UDP port, read in the
   * same statement as the key; null while the node is Direct.
   */
  bridgeEndpoint: { host: string; port: number } | null;
  /** The saved AWG 3.1 client profile, unvalidated; null when none. */
  awgClientProfile: unknown;
  /** The resolved profile and MTU (`resolveAwgClientSettings`). */
  awgGenerator?: AwgGeneratorSettings | null;
  awgMtu?: number;
  /** Which level the resolved profile and MTU come from. */
  awgSettingsFrom?: {
    profileFrom: AwgConfigLevelName | null;
    mtuFrom: AwgConfigLevelName | "profile" | "default";
  };
  /** Key target platform; used to project mobile-safe IPv6 reject stub ULA. */
  deviceType?: DeviceType;
  /** Observed/desired IPv6 active-reject stub status on the key's node. */
  nodeIpv6RejectStub?: {
    enabled: boolean;
    state: NodeIpv6RejectStubState;
    prefix: string;
  } | null;
  /** Per-exit DNS override resolved from the key's endpoint or node default exit IP. */
  egressDns?: {
    dns1: string;
    dns2: string | null;
  } | null;
};

/**
 * The node's probe key as a sample for the parameters view, with only the
 * address and node levels resolved (what the probe measures).
 */
export type ServiceKeyConfig = {
  keyId: string;
  encrypted: EncryptedSecret;
  protocol: "awg3";
  /** The saved AWG 3.1 client profile, unvalidated; null when none. */
  awgClientProfile: unknown;
  settings: ResolvedAwgClientSettings;
};

/** The locked row a config refresh draws its new profile for. */
export type ConfigRefreshSnapshot = {
  awgGenerator?: AwgGeneratorSettings | null;
  awgMtu?: number;
  keyId: string;
  encrypted: EncryptedSecret;
  awgClientProfile: unknown;
  revision: number;
};

export type TrafficPair = { receivedBytes: string; sentBytes: string };
export type NodeTrafficPeriods = {
  nodeId: string;
  today: TrafficPair;
  week: TrafficPair;
  month: TrafficPair;
};

export type RouteProfileAvailability = {
  profile: RouteProfile;
  available: boolean;
  activeVersion: string | null;
};

export type AuditInput = {
  actorUserId: string | null;
  actorType: "user" | "system";
  action: string;
  targetType: string;
  targetId: string | null;
  metadata?: Record<string, unknown>;
};

export interface ControlRepository {
  resolveIdentity: (claim: IdentityClaim) => Promise<Actor>;
  getMe: (actor: Actor) => Promise<Record<string, unknown>>;
  /** Record that the caller answered one of the panel's two interruptions. */
  ackNotice: (actor: Actor, kind: NoticeKind) => Promise<NoticeAcks>;
  listNodes: (actor: Actor) => Promise<unknown[]>;
  listKeys: (actor: Actor) => Promise<KeyView[]>;
  createProvisioningKey: (
    actor: Actor,
    request: CreateKeyRequest,
    options?: { allowBridgeSelection?: boolean },
  ) => Promise<{ id: string; state: KeyState }>;
  findKeyConfig: (keyId: string) => Promise<StoredKeyConfig | null>;
  /** `PostgresControlRepository.findServiceKeyConfig`. */
  findServiceKeyConfig: (nodeId: string, endpointId: string | null) => Promise<ServiceKeyConfig | null>;
  /**
   * Admin-wide route additions/exclusions applied to every split-tunnel export.
   * Returns the empty set when no admin has configured any.
   */
  getGlobalRoutes: () => Promise<GlobalRoutes>;
  recordConfigExport: (
    keyId: string,
    format: string,
    hash: string,
    context: {
      key: StoredKeyConfig;
      globalRoutes: GlobalRoutes | null;
      markRuleVersion: boolean;
      markConfigDelivered?: boolean;
    },
  ) => Promise<boolean>;
  listRouteProfiles: () => Promise<RouteProfileAvailability[]>;
  getRuleVersion: (id: string) => Promise<unknown>;
  /** State of the manual "check the route feeds now" job. */
  getRulesRefreshStatus: () => Promise<RulesRefreshStatus>;
  /** State of the single `access.sync` outbox row, "idle" when never armed. */
  getAccessSyncStatus: () => Promise<AccessSyncStatus>;
  diffRuleVersions: (baseId: string, nextId: string) => Promise<unknown>;
  enqueueOwnRevoke: (actor: Actor, keyId: string) => Promise<void>;
  enqueueOwnRotate: (actor: Actor, keyId: string) => Promise<void>;
  /**
   * Commit a new client profile for the caller's own active key, only while
   * `refreshToken` still matches the locked row. `prepare` runs inside the
   * transaction on that row's snapshot and returns the profile to save, or
   * throws to roll everything back. The profile and its audit event are one
   * commit; no node, job or capacity check is involved.
   */
  refreshOwnConfigProfile: (
    actor: Actor,
    keyId: string,
    refreshToken: string,
    prepare: (snapshot: ConfigRefreshSnapshot) => AwgClientProfileV1,
  ) => Promise<{ revision: number }>;
  /**
   * Set the caller's own key's device label and, only when that actually
   * changes the connection name the client shows (`composeKeyDisplayName`
   * with this key's own `nameDisplay` flags), queue the same rotate that
   * `enqueueOwnRotate` does. A label that is not part of the displayed name,
   * or a rename to text that composes to the same string, is a plain update:
   * nothing about the exported config would differ, so forcing the old one
   * to stop working would have no visible payoff.
   */
  renameOwnKey: (
    actor: Actor,
    keyId: string,
    deviceLabel: string,
  ) => Promise<{ id: string; state: KeyState; reissued: boolean }>;
  updateOwnCustomRoutes: (
    actor: Actor,
    routes: CustomRoutes,
  ) => Promise<CustomRoutes>;
  listQuotaRequests: (actor: Actor) => Promise<unknown[]>;
  createQuotaRequest: (
    actor: Actor,
    request: QuotaRequest,
  ) => Promise<{ id: string; status: string }>;
  getAdminOverview: (actor: Actor) => Promise<Record<string, unknown>>;
  trafficSeries: (options: {
    ownerId?: string;
    days: number;
  }) => Promise<
    Array<{ date: string; receivedBytes: string; sentBytes: string }>
  >;
  nodeTrafficPeriods: (options: {
    ownerId?: string;
  }) => Promise<NodeTrafficPeriods[]>;
  createUser: (actor: Actor, request: CreateUserRequest) => Promise<unknown>;
  createNode: (actor: Actor, request: CreateNodeRequest) => Promise<unknown>;
  updateNode: (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeRequest,
  ) => Promise<unknown>;
  setNodeIpv6RejectStub: (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeIpv6RejectStubRequest,
  ) => Promise<unknown>;
  deleteNode: (
    actor: Actor,
    nodeId: string,
    options: DeleteNodeOptions,
  ) => Promise<unknown>;
  adminList: (actor: Actor, resource: string) => Promise<unknown>;
  createServiceCheck: (
    actor: Actor,
    request: CreateServiceCheckRequest,
  ) => Promise<unknown>;
  updateServiceCheck: (
    actor: Actor,
    checkId: string,
    request: UpdateServiceCheckRequest,
  ) => Promise<unknown>;
  deleteServiceCheck: (actor: Actor, checkId: string) => Promise<unknown>;
  resetServiceCheckResults: (
    actor: Actor,
    checkId: string | null,
  ) => Promise<unknown>;
  runServiceCheckNow: (actor: Actor, checkId: string) => Promise<unknown>;
  getReachability: (actor: Actor) => Promise<AdminReachabilityView>;
  getBridgeRotationEvidence: (actor: Actor, bridgeId: string) => Promise<BridgeRotationEvidence>;
  upsertReachabilityProbe: (
    actor: Actor,
    request: UpsertReachabilityProbeRequest,
  ) => Promise<ReachabilityProbeView>;
  deleteReachabilityProbe: (actor: Actor) => Promise<void>;
  runReachabilityNow: (actor: Actor, requireNew?: boolean) => Promise<ReachabilityProbeView>;
  listReachabilityHistory: (
    actor: Actor,
    query: ReachabilityHistoryQuery,
  ) => Promise<ReachabilityHistoryEntry[]>;
  adminAction: (
    actor: Actor,
    resource: string,
    targetId: string | null,
    action: string,
    payload: unknown,
  ) => Promise<unknown>;
  appendAudit: (event: AuditInput) => Promise<void>;
  // Bridge registry (optional AWG 3.1 node bridges). Admin-only; the node's
  // active route changes through `updateNode` with `vpnBridgeRouteId`.
  listBridges: (actor: Actor) => Promise<Bridge[]>;
  createBridge: (actor: Actor, request: CreateBridgeRequest) => Promise<Bridge>;
  updateBridge: (
    actor: Actor,
    bridgeId: string,
    request: UpdateBridgeRequest,
  ) => Promise<Bridge>;
  deleteBridge: (actor: Actor, bridgeId: string) => Promise<DeleteBridgeResult>;
  /** Preview, outstanding operation and history of the bridge-agent update. */
  getBridgeAgentUpdate: (actor: Actor, bridgeId: string) => Promise<BridgeAgentUpdateView>;
  /** Read-only checks before rolling back to a release that predates bridges. */
  getBridgeRollbackPreflight: (actor: Actor) => Promise<BridgeRollbackPreflight>;
  /** Request a bridge-agent update; a repeat of the outstanding one returns it. */
  requestBridgeAgentUpdate: (
    actor: Actor,
    bridgeId: string,
    request: RequestBridgeAgentUpdate,
  ) => Promise<RequestBridgeAgentUpdateResult>;
  getNodeBridgeRoutes: (actor: Actor, nodeId: string) => Promise<NodeBridgeRoutes>;
  /** Counts-only dry-run of the endpoint renderer over the node's stored configs. */
  getBridgeEligibility: (actor: Actor, nodeId: string) => Promise<BridgeEligibility>;
  prepareBridgeRoute: (
    actor: Actor,
    nodeId: string,
    request: PrepareBridgeRouteRequest,
  ) => Promise<PrepareBridgeRouteResult>;
  releaseBridgeRoute: (
    actor: Actor,
    routeId: string,
  ) => Promise<ReleaseBridgeRouteResult>;
  updateBridgeRouteTransport: (
    actor: Actor,
    routeId: string,
    request: UpdateBridgeRouteTransportRequest,
  ) => Promise<NodeBridgeRoute>;
  listInfrastructure: (actor: Actor) => Promise<InfrastructureItem[]>;
  /** A held route with its bridge's public address; null when unknown. */
  findBridgeRouteTarget: (routeId: string) => Promise<BridgeRouteTarget | null>;
  /** Record operator verification or queue a probe candidate check. */
  verifyBridgeRoute: (
    actor: Actor,
    routeId: string,
    request: VerifyBridgeRouteRequest,
  ) => Promise<VerifyBridgeRouteResult>;
  listNodeEgressIps: (actor: Actor, nodeId: string) => Promise<NodeEgressIp[]>;
  createNodeEgressIp: (
    actor: Actor,
    nodeId: string,
    request: CreateNodeEgressIpRequest,
  ) => Promise<NodeEgressIp>;
  updateNodeEgressIp: (
    actor: Actor,
    nodeId: string,
    ipId: string,
    request: UpdateNodeEgressIpRequest,
  ) => Promise<NodeEgressIp>;
  deleteNodeEgressIp: (
    actor: Actor,
    nodeId: string,
    ipId: string,
  ) => Promise<{ id: string; deleted: boolean; affectedEndpoints: number }>;
  swapNodeEgressIp: (
    actor: Actor,
    nodeId: string,
    ipId: string,
    request: SwapNodeEgressIpRequest,
  ) => Promise<{ ip: NodeEgressIp; replacedIpv4: string; affectedEndpoints: number }>;
  getNodeEgressVerifyTarget: (
    nodeId: string,
    ipId: string,
  ) => Promise<NodeEgressVerifyTarget | null>;
  setNodeEgressMode: (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeEgressModeRequest,
  ) => Promise<{ nodeId: string; mode: NodeEgressMode; state: NodeEgressModeState; queued: boolean }>;
  adoptNodeEgressMode: (
    actor: Actor,
    nodeId: string,
  ) => Promise<{ nodeId: string; mode: NodeEgressMode; state: NodeEgressModeState }>;
  reassignKeyEndpoint: (
    actor: Actor,
    keyId: string,
    request: AdminReassignKeyEndpointRequest,
  ) => Promise<{ id: string; nodeId: string; endpointId: string; previousEndpointId: string | null }>;
  notifyNodeKeyUpdate: (
    actor: Actor,
    nodeId: string,
    request: NotifyKeyUpdateRequest,
  ) => Promise<NotifyKeyUpdateResult>;
  clearNodeKeyUpdate: (
    actor: Actor,
    nodeId: string,
  ) => Promise<NotifyKeyUpdateResult>;
  notifyNodeEgressIpKeyUpdate: (
    actor: Actor,
    nodeId: string,
    ipId: string,
    request: NotifyKeyUpdateRequest,
  ) => Promise<NotifyKeyUpdateResult>;
  clearNodeEgressIpKeyUpdate: (
    actor: Actor,
    nodeId: string,
    ipId: string,
  ) => Promise<NotifyKeyUpdateResult>;
  notifyNodeEndpointKeyUpdate: (
    actor: Actor,
    nodeId: string,
    endpointId: string,
    request: NotifyKeyUpdateRequest,
  ) => Promise<NotifyKeyUpdateResult>;
  clearNodeEndpointKeyUpdate: (
    actor: Actor,
    nodeId: string,
    endpointId: string,
  ) => Promise<NotifyKeyUpdateResult>;
}
