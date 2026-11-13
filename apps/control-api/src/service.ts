import type {
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
  ConfigRefreshResult,
  ConfigRefreshStatus,
  AccessSyncStatus,
  AdminReachabilityView,
  UserNodeReachability,
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateUserRequest,
  CreateKeyRequest,
  CustomRoutes,
  DeleteNodeOptions,
  DeviceType,
  KeyNameDisplay,
  KeyState,
  NoticeAcks,
  NoticeKind,
  ProtocolKind,
  QuotaRequest,
  ReachabilityStatus,
  Role,
  RouteProfile,
  RulesRefreshStatus,
  UserStatus,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
  UpsertReachabilityProbeRequest,
} from "@amnezia/contracts";
import type { NodeTrafficPeriods } from "./repository.js";

export type IdentityClaim = {
  provider: string;
  subject: string;
  email: string;
};

export type Actor = {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: UserStatus;
};

export type KeyView = {
  id: string;
  ownerId: string;
  nodeId: string;
  /**
   * The server's user-facing name. Present even when the user may no longer
   * create keys on that server, which `/api/nodes` does not list.
   */
  nodeName: string;
  /**
   * Whether the key's server works from outside (the external probe's
   * verdict). Present only when the portal policy's showNodeStatus is on.
   */
  nodeReachability?: UserNodeReachability;
  publicKey?: string | null;
  protocol: ProtocolKind;
  state: KeyState;
  deviceType: DeviceType;
  deviceLabel?: string | null;
  keyNumber?: number | null;
  /**
   * The operator-only note on the key. Present ONLY when the caller is an
   * administrator looking at their own key; for anyone else the property is
   * absent from the payload entirely (`internalNameFor` in keyView.ts). A
   * regular user never receives it, which is what makes it safe to write a
   * real person's name in.
   */
  internalName?: string | null;
  // Which parts the client-visible connection name is composed of. Feed it to
  // `composeKeyDisplayName` together with the node's public name.
  nameDisplay: KeyNameDisplay;
  routeProfile: RouteProfile;
  rulesOutdated?: boolean;
  createdAt: string;
  lastUsedAt?: string | null;
  traffic?: { receivedBytes: string; sentBytes: string };
};

/**
 * Four QR containers, for three different scanners:
 * - `qr-frames` the config in AmneziaVPN's own chunk envelope — the only thing
 *               an in-app "scan QR" button can read, and the format this panel
 *               ships for it. It serves DefaultVPN too: that client is a fork
 *               of amnezia-client and its scanner is byte-identical, so there
 *               is one format here and not two -- source analysis only, see
 *               qrFrames.ts's 2026-09 discrepancy note before repeating this
 *               as confirmed fact anywhere user-facing.
 *               JSON: { total: number; frames: string[] } of SVG strings;
 * - `qr-svg`    the single-frame `vpn://` link, resolution-independent, for
 *               display — the panel is normally open on a PC monitor or a
 *               laptop and the code is scanned with a phone camera, so the
 *               displayed symbol has to survive being enlarged to most of the
 *               screen. A camera app cannot read `qr-frames` at all, so this
 *               stays supported rather than being superseded by it;
 * - `qr`        the same single-frame link as a downloadable PNG;
 * - `qr-conf`   a QR of the plain WireGuard `.conf` text — the same bytes the
 *               `conf` file format serves, for the AmneziaWG app. AmneziaWG is
 *               a third, separate client: it reads neither the chunk envelope
 *               nor the `vpn://` link, only a bare WireGuard config, so this is
 *               a different payload again rather than a different picture of
 *               one already listed. Single-frame SVG for display, like
 *               `qr-svg` — no filename, for the same reason.
 * All four are gated by the same `allowQrDownload` policy flag, and all four
 * refuse a config too large to encode with the same `QR_TOO_LARGE` (422): a
 * `ru_blacklist` key's `.conf` embeds thousands of CIDRs, so `qr-conf` hits the
 * same ceiling `qr`/`qr-svg` hit on the `vpn://` link, and `qr-frames` hits by
 * needing more than eight chunks.
 *
 * The other two are the file shapes, and only one of them keeps the key's
 * connection name:
 * - `vpn`       the `vpn://` payload, served as `<connection name>.vpn`. The
 *               client's file picker offers `*.vpn` and its importer sniffs the
 *               CONTENT, so this file imports as an Amnezia config and keeps its
 *               `description` — the name the panel composed for the key;
 * - `conf`      the bare WireGuard/AmneziaWG config, for awg-quick and router
 *               firmwares. The AmneziaVPN client always renames an imported
 *               `.conf` to "Server N" — the format has nowhere to carry a name
 *               and the parser would ignore one anyway (configFilename.ts cites
 *               the client source). Offer `vpn` to anyone who wants the name.
 */
export type ConfigFormat =
  | "vpn"
  | "conf"
  | "qr"
  | "qr-svg"
  | "qr-frames"
  | "qr-conf";

export type ConfigResult = {
  format: ConfigFormat;
  contentType: string;
  body: string | Buffer;
  filename?: string;
  /**
   * How the symbol was actually drawn, for the QR formats. Reported on the
   * response so `amnezia-panel key-config` can answer "the QR does not scan"
   * with the numbers that decide it -- the error-correction level and the module
   * count are what set how many camera pixels land on each module -- instead of
   * an operator having to reason about it from the payload.
   */
  qrParams?: { errorCorrectionLevel: string; modules: number; scale: number };
};

/** The probe's settings and health as the admin view shows them; no secret. */
export type ReachabilityProbeView = NonNullable<AdminReachabilityView["probe"]>;

/** One ingested run's verdict for one node. */
export type ReachabilityHistoryEntry = {
  runId: string;
  status: ReachabilityStatus;
  detail: string | null;
  checkedAt: string;
};

export type ReachabilityHistoryQuery = { nodeId: string; limit: number };

export interface ControlApiService {
  resolveIdentity: (claim: IdentityClaim) => Promise<Actor>;
  getMe: (actor: Actor) => Promise<Record<string, unknown>>;
  /** Record that the caller answered one of the panel's two interruptions. */
  ackNotice: (actor: Actor, kind: NoticeKind) => Promise<NoticeAcks>;
  listNodes: (actor: Actor) => Promise<unknown[]>;
  listKeys: (actor: Actor) => Promise<KeyView[]>;
  requestKey: (
    actor: Actor,
    request: CreateKeyRequest,
  ) => Promise<{ id: string; state: KeyState }>;
  getKeyConfig: (
    actor: Actor,
    keyId: string,
    format: ConfigFormat,
    adminConfirmed: boolean,
  ) => Promise<ConfigResult>;
  revokeOwnKey: (actor: Actor, keyId: string) => Promise<void>;
  rotateOwnKey: (actor: Actor, keyId: string) => Promise<void>;
  /** Whether the caller's own key can take a new client profile right now. */
  getConfigRefresh: (actor: Actor, keyId: string) => Promise<ConfigRefreshStatus>;
  /** A new client profile for the caller's own key; same key, same peer. */
  refreshOwnConfig: (
    actor: Actor,
    keyId: string,
    refreshToken: string,
  ) => Promise<ConfigRefreshResult>;
  /**
   * Rename one of the caller's own keys, re-issuing it only when the rename
   * actually changes the connection name the client shows. See
   * `ControlRepository.renameOwnKey` for why that condition matters.
   */
  renameOwnKey: (
    actor: Actor,
    keyId: string,
    deviceLabel: string,
  ) => Promise<{ id: string; state: KeyState; reissued: boolean }>;
  updateMyCustomRoutes: (
    actor: Actor,
    routes: CustomRoutes,
  ) => Promise<CustomRoutes>;
  listRouteProfiles: (actor: Actor) => Promise<unknown[]>;
  getRuleVersion: (actor: Actor, id: string) => Promise<unknown>;
  getRulesRefreshStatus: (actor: Actor) => Promise<RulesRefreshStatus>;
  getAccessSyncStatus: (actor: Actor) => Promise<AccessSyncStatus>;
  diffRuleVersions: (
    actor: Actor,
    baseId: string,
    nextId: string,
  ) => Promise<unknown>;
  listQuotaRequests: (actor: Actor) => Promise<unknown[]>;
  createQuotaRequest: (
    actor: Actor,
    request: QuotaRequest,
  ) => Promise<{ id: string; status: string }>;
  getAdminOverview: (actor: Actor) => Promise<Record<string, unknown>>;
  trafficSeries: (
    actor: Actor,
    options: { scope: "self" | "all"; days: number },
  ) => Promise<
    Array<{ date: string; receivedBytes: string; sentBytes: string }>
  >;
  nodeTrafficPeriods: (
    actor: Actor,
    options: { scope: "self" | "all" },
  ) => Promise<NodeTrafficPeriods[]>;
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
  /**
   * Clear stored results for one check, or for every check when checkId is
   * null. Not destructive in the way it looks: the result IS the schedule, so a
   * cleared check is due again on the next tick and measures itself afresh.
   */
  resetServiceCheckResults: (
    actor: Actor,
    checkId: string | null,
  ) => Promise<unknown>;
  /**
   * Mark every node's copy of a check due on the next telemetry tick. It moves
   * a marker rather than running anything: the panel cannot reach a node
   * synchronously, and pretending otherwise would mean an HTTP request that
   * waits on a fleet.
   */
  runServiceCheckNow: (actor: Actor, checkId: string) => Promise<unknown>;
  /** Probe settings and health plus every node's state and per-protocol results. */
  getReachability: (actor: Actor) => Promise<AdminReachabilityView>;
  /**
   * Create or replace the probe's settings. The API key is required on create
   * and kept when omitted on update; it is never returned.
   */
  upsertReachabilityProbe: (
    actor: Actor,
    request: UpsertReachabilityProbeRequest,
  ) => Promise<ReachabilityProbeView>;
  /** Remove the probe. Results stay until their node is deleted. */
  deleteReachabilityProbe: (actor: Actor) => Promise<void>;
  /**
   * Ask for a run on the worker's next tick. Like `runServiceCheckNow` it moves
   * a marker: the worker is the only one that talks to the probe.
   */
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
  /** Bridges with capacity, held ports and route summaries. */
  listBridges: (actor: Actor) => Promise<Bridge[]>;
  /** Register a bridge; it starts pending enrollment. */
  createBridge: (actor: Actor, request: CreateBridgeRequest) => Promise<Bridge>;
  /** Rename a bridge. Host, address and ports are never edited in place. */
  updateBridge: (
    actor: Actor,
    bridgeId: string,
    request: UpdateBridgeRequest,
  ) => Promise<Bridge>;
  /** Delete a bridge that holds no draft, active or retiring route. */
  deleteBridge: (actor: Actor, bridgeId: string) => Promise<DeleteBridgeResult>;
  /** The node's endpoint assignment: active route or Direct, drafts, retiring. */
  getNodeBridgeRoutes: (actor: Actor, nodeId: string) => Promise<NodeBridgeRoutes>;
  /** Counts-only dry-run of the endpoint renderer over the node's stored configs. */
  getBridgeEligibility: (actor: Actor, nodeId: string) => Promise<BridgeEligibility>;
  /** Reserve a bridge UDP port for the node (idempotent per node and bridge). */
  prepareBridgeRoute: (
    actor: Actor,
    nodeId: string,
    request: PrepareBridgeRouteRequest,
  ) => Promise<PrepareBridgeRouteResult>;
  /** Release a draft or retiring route once the bridge confirms it is gone. */
  releaseBridgeRoute: (
    actor: Actor,
    routeId: string,
  ) => Promise<ReleaseBridgeRouteResult>;
  /** VPN nodes and bridges as one typed `kind` union. */
  listInfrastructure: (actor: Actor) => Promise<InfrastructureItem[]>;
  /**
   * A private `.vpn` preview of the caller's own active AWG 3.1 key on the
   * route's node, rendered with that draft route's endpoint. Leaves the
   * active assignment, the profile revision and ordinary delivery accounting
   * untouched.
   */
  getBridgeRouteTestConfig: (
    actor: Actor,
    routeId: string,
    keyId: string,
  ) => Promise<BridgeTestConfigResult>;
  /** Operator verification, or queue a probe candidate check. */
  verifyBridgeRoute: (
    actor: Actor,
    routeId: string,
    request: VerifyBridgeRouteRequest,
  ) => Promise<VerifyBridgeRouteResult>;
}

export type BridgeTestConfigResult = {
  contentType: string;
  body: string;
  filename: string;
  /** The route's observed frps registration marker, or null when none. */
  registrationMarker: string | null;
};

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}
