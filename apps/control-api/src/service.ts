import type {
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateUserRequest,
  CreateKeyRequest,
  CustomRoutes,
  DeleteNodeOptions,
  DeviceType,
  KeyNameDisplay,
  KeyState,
  ProtocolKind,
  QuotaRequest,
  Role,
  RouteProfile,
  RulesRefreshStatus,
  UserStatus,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
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
  publicKey?: string | null;
  protocol: ProtocolKind;
  state: KeyState;
  deviceType: DeviceType;
  deviceLabel?: string | null;
  keyNumber?: number | null;
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
 * Three QR containers, for two different scanners:
 * - `qr-frames` the config in AmneziaVPN's own chunk envelope — the only thing
 *               the client's in-app "scan QR" button can read, and the format
 *               this panel ships for it.
 *               JSON: { total: number; frames: string[] } of SVG strings;
 * - `qr-svg`    the single-frame `vpn://` link, resolution-independent, for
 *               display — the panel is normally open on a PC monitor or a
 *               laptop and the code is scanned with a phone camera, so the
 *               displayed symbol has to survive being enlarged to most of the
 *               screen. A camera app cannot read `qr-frames` at all, so this
 *               stays supported rather than being superseded by it;
 * - `qr`        the same single-frame link as a downloadable PNG.
 * All three are gated by the same `allowQrDownload` policy flag.
 */
export type ConfigFormat = "vpn" | "conf" | "qr" | "qr-svg" | "qr-frames";

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

export interface ControlApiService {
  resolveIdentity: (claim: IdentityClaim) => Promise<Actor>;
  getMe: (actor: Actor) => Promise<Record<string, unknown>>;
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
  updateMyCustomRoutes: (
    actor: Actor,
    routes: CustomRoutes,
  ) => Promise<CustomRoutes>;
  listRouteProfiles: (actor: Actor) => Promise<unknown[]>;
  getRuleVersion: (actor: Actor, id: string) => Promise<unknown>;
  getRulesRefreshStatus: (actor: Actor) => Promise<RulesRefreshStatus>;
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
   * Mark every node's copy of a check due on the next telemetry tick. It moves
   * a marker rather than running anything: the panel cannot reach a node
   * synchronously, and pretending otherwise would mean an HTTP request that
   * waits on a fleet.
   */
  runServiceCheckNow: (actor: Actor, checkId: string) => Promise<unknown>;
  adminAction: (
    actor: Actor,
    resource: string,
    targetId: string | null,
    action: string,
    payload: unknown,
  ) => Promise<unknown>;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}
