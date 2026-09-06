import type {
  AccessSyncStatus,
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateKeyRequest,
  CreateUserRequest,
  CustomRoutes,
  DeleteNodeOptions,
  GlobalRoutes,
  KeyNameDisplay,
  KeyState,
  PortalPolicy,
  QuotaRequest,
  RouteProfile,
  RulesRefreshStatus,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
} from "@amnezia/contracts";
import type { EncryptedSecret } from "@amnezia/db";
import type { Actor, IdentityClaim, KeyView } from "./service.js";
import type { RulePayload } from "./vpnConfig.js";

export type ActiveRule = {
  versionId: string;
  version: string;
  payload: RulePayload;
};

export type StoredKeyConfig = {
  id: string;
  ownerId: string;
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
  adminAction: (
    actor: Actor,
    resource: string,
    targetId: string | null,
    action: string,
    payload: unknown,
  ) => Promise<unknown>;
  appendAudit: (event: AuditInput) => Promise<void>;
}
