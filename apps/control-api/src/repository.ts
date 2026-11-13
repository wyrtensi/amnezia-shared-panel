import type {
  AccessSyncStatus,
  AdminReachabilityView,
  Bridge,
  CreateBridgeRequest,
  DeleteBridgeResult,
  InfrastructureItem,
  BridgeEligibility,
  NodeBridgeRoutes,
  PrepareBridgeRouteRequest,
  PrepareBridgeRouteResult,
  ReleaseBridgeRouteResult,
  UpdateBridgeRequest,
  VerifyBridgeRouteRequest,
  VerifyBridgeRouteResult,
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateKeyRequest,
  CreateUserRequest,
  CustomRoutes,
  DeleteNodeOptions,
  GlobalRoutes,
  KeyNameDisplay,
  KeyState,
  NoticeAcks,
  NoticeKind,
  PortalPolicy,
  QuotaRequest,
  RouteProfile,
  RulesRefreshStatus,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
  UpsertReachabilityProbeRequest,
} from "@amnezia/contracts";
import type { EncryptedSecret } from "@amnezia/db";
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
};

/** The locked row a config refresh draws its new profile for. */
export type ConfigRefreshSnapshot = {
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
  ) => Promise<{ id: string; state: KeyState }>;
  findKeyConfig: (keyId: string) => Promise<StoredKeyConfig | null>;
  /**
   * Admin-wide route additions/exclusions applied to every split-tunnel export.
   * Returns the empty set when no admin has configured any.
   */
  getGlobalRoutes: () => Promise<GlobalRoutes>;
  markKeyRuleVersion: (keyId: string, versionId: string) => Promise<void>;
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
  upsertReachabilityProbe: (
    actor: Actor,
    request: UpsertReachabilityProbeRequest,
  ) => Promise<ReachabilityProbeView>;
  deleteReachabilityProbe: (actor: Actor) => Promise<void>;
  runReachabilityNow: (actor: Actor) => Promise<ReachabilityProbeView>;
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
  listInfrastructure: (actor: Actor) => Promise<InfrastructureItem[]>;
  /** A held route with its bridge's public address; null when unknown. */
  findBridgeRouteTarget: (routeId: string) => Promise<BridgeRouteTarget | null>;
  /** Record operator verification or queue a probe candidate check. */
  verifyBridgeRoute: (
    actor: Actor,
    routeId: string,
    request: VerifyBridgeRouteRequest,
  ) => Promise<VerifyBridgeRouteResult>;
}
