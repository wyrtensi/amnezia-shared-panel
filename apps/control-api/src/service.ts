import type {
  CreateNodeRequest,
  CreateUserRequest,
  CreateKeyRequest,
  CustomRoutes,
  DeviceType,
  KeyState,
  ProtocolKind,
  QuotaRequest,
  Role,
  RouteProfile,
  UserStatus,
  UpdateNodeRequest,
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
  routeProfile: RouteProfile;
  rulesOutdated?: boolean;
  createdAt: string;
  lastUsedAt?: string | null;
  traffic?: { receivedBytes: string; sentBytes: string };
};

export type ConfigFormat = "vpn" | "conf" | "qr";

export type ConfigResult = {
  format: ConfigFormat;
  contentType: string;
  body: string | Buffer;
  filename?: string;
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
  deleteNode: (actor: Actor, nodeId: string) => Promise<unknown>;
  adminList: (actor: Actor, resource: string) => Promise<unknown>;
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
