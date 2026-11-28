import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  AccessSyncStatus,
  AdminNodeEndpoint,
  AdminReassignKeyEndpointRequest,
  Bridge,
  BridgeRotationEvidence,
  CreateBridgeRequest,
  CreateNodeEgressIpRequest,
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateKeyRequest,
  CreateUserRequest,
  CustomRoutes,
  DeleteNodeOptions,
  GlobalRoutes,
  KeyBridgeMode,
  KeyEgressInfo,
  KeyLimitMode,
  KeyState,
  NodeEgressIp,
  NodeEgressMode,
  NodeEgressModeState,
  NotifyKeyUpdateRequest,
  NotifyKeyUpdateResult,
  NoticeAcks,
  NoticeKind,
  PortalPolicy,
  PortalPolicyOverride,
  ProtocolKind,
  QuotaRequest,
  QuotaRequestNotifyPayload,
  RouteProfile,
  RulesRefreshStatus,
  SwapNodeEgressIpRequest,
  UpdateNodeEgressIpRequest,
  UpdateNodeEgressModeRequest,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
  DeleteBridgeResult,
  BridgeAgentUpdateView,
  BridgeRollbackPreflight,
  RequestBridgeAgentUpdate,
  RequestBridgeAgentUpdateResult,
  InfrastructureItem,
  BridgeEligibility,
  NodeBridgeRoute,
  NodeBridgeRoutes,
  NodeEndpointAssignment,
  NodePublicEndpointMutation,
  NodePublicEndpointMutationResult,
  PrepareBridgeRouteRequest,
  PrepareBridgeRouteResult,
  ReleaseBridgeRouteResult,
  ProbeCapabilityInput,
  VerifyBridgeRouteRequest,
  VerifyBridgeRouteResult,
  UpdateBridgeRequest,
  UpdateBridgeRouteTransportRequest,
  UpdateNodeIpv6RejectStubRequest,
} from "@amnezia/contracts";
import {
  BRIDGE_MANAGEMENT_HOSTS_DEFAULT,
  BRIDGE_OBSERVATION_STALE_MS_DEFAULT,
  composeKeyDisplayName,
  computeEndpointDisplayName,
  CONFIG_REFRESH_STALE,
  CONFIG_REFRESH_UNAVAILABLE,
  detectExitSubnetProximityWarning,
  noticeAcksSchema,
  NODE_SYNC_EGRESS_JOB_TYPE,
  NODE_SWITCH_EGRESS_MODE_JOB_TYPE,
  NOTICE_KINDS,
  resetNoticesRequestSchema,
  nodeRunsCheck,
  nodeEndpointDefaultName,
  protocolSupportsEndpoints,
  selectDefaultNodeEndpoint,
  isPurgeableKeyState,
  isIpv4Literal,
  REVOCABLE_KEY_STATES,
  revokeJobDedupKey,
  toUserCheckState,
  toUserReachability,
  UNKNOWN_USER_REACHABILITY,
} from "@amnezia/contracts";
import type { ServiceCheckUserState, UserNodeReachability } from "@amnezia/contracts";
import {
  ACCESS_SYNC_DEDUPLICATION_KEY,
  QUOTA_REQUEST_NOTIFY_JOB_TYPE,
  accessDomainListSchema,
  clampWorkerPeriod,
  createKeyRequestSchema,
  customRoutesSchema,
  DEFAULT_ALLOWED_PROTOCOLS,
  defaultPortalPolicy,
  awgDeviceRuleSchema,
  awgGeneratorPresets,
  deviceRuleFor,
  pinClientConfigRequestSchema,
  setAwgClientConfigRequestSchema,
  setUserClientConfigRequestSchema,
  resolveAwgClientSettings,
  emptyGlobalRoutes,
  globalRoutesSchema,
  idleAccessSyncStatus,
  installGuideVideosSchema,
  isPublishableAgentImage,
  nodeAgentUpdateActionSchema,
  nodeCapacityActionSchema,
  NODE_IPV6_REJECT_STUB_JOB_TYPE,
  nodeOrderSchema,
  normalizeAccessDomain,
  PROTOCOL_KINDS,
  recommendedNodeIdsSchema,
  ruleNotifySchema,
  portalPolicyOverrideSchema,
  portalPolicySchema,
  POLL_BOUND_SAMPLE_FIELDS,
  POLL_BOUND_SAMPLE_LABELS,
  sampleBelowPoll,
  workerPeriodOverridesSchema,
  WORKER_PERIOD_FIELDS,
  WORKER_PERIOD_FIELD_NAMES,
  RULES_REFRESH_DEDUPLICATION_KEY,
  RULES_REFRESH_JOB_TYPE,
  setKeyInternalNameRequestSchema,
  setUserLimitRequestSchema,
  updateCustomRoutesRequestSchema,
  updateGlobalRoutesRequestSchema,
} from "@amnezia/contracts";
import type { PollBoundSampleField } from "@amnezia/contracts";
import type { AwgGeneratorSettings, ResolvedAwgClientSettings } from "@amnezia/contracts";
import {
  isProbeStale,
  nodeServedProtocols,
  probeCapabilityInputOf,
  probeLevelsSchema,
  probeSupportsBridgeMeasurement,
  REACHABILITY_DEFAULTS,
  type AdminReachabilityView,
  type UpsertReachabilityProbeRequest,
} from "@amnezia/contracts";
import {
  armAccessSyncRow,
  auditEvents,
  decryptSecret,
  deterministicPeerLabel,
  encryptSecret,
  findOffboardedUsersEligibleForPurge,
  globalRouteOverrides,
  resetNodeEndpointEvidence,
  requestReachabilityRun,
  GENERATOR_CHANGED_DETAIL,
  hasLiveKeys,
  identities,
  jobOutbox,
  keyOwnerIsPerson,
  nodeAgentReleases,
  nodeEgressIps,
  nodeEgressServiceCheckResults,
  nodeMetricsCurrent,
  nodeServiceCheckResults,
  nodeServiceChecks,
  nodes,
  nodeVpnEndpoints,
  notServiceAccount,
  SERVICE_ACCOUNT_EMAIL,
  peerCurrent,
  portalPolicy,
  purgeOneOffboardedUser,
  quotaRequests,
  resolvePortalPolicy,
  routeRuleVersions,
  trafficRollups,
  users,
  vpnBridgeRoutes,
  vpnBridges,
  vpnKeys,
  type AccessSyncArmReason,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";
import type { NodeEgressVerifyTarget } from "./nodeEgressVerifier.js";
import {
  configRefreshToken,
  profileRevision,
  selectAwgClientProfile,
  type AwgClientProfileV1,
} from "./awgClientProfile.js";
import type {
  ActiveRule,
  AuditInput,
  ConfigRefreshSnapshot,
  ControlRepository,
  NodeTrafficPeriods,
  RouteProfileAvailability,
  ServiceKeyConfig,
  StoredKeyConfig,
} from "./repository.js";
import { ApiError, type Actor, type IdentityClaim, type KeyView } from "./service.js";
import { toKeyView, type ImportantRuleNotice } from "./keyView.js";
import {
  observedKeyPath,
  resolveKeyBridgeInfo,
  type KeyBridgeRouteRecord,
} from "./bridgeEndpoint.js";
import { diffRulePayloads } from "./ruleDiff.js";
import {
  hasRoomForKey,
  isNodeAvailable,
  nodeIdsWithExplicitLimit,
  resolveNodeKeyLimit,
  resolvePoolKeyLimit,
  resolveQuotaApproval,
  type NodeQuotaContext,
  type QuotaApproval,
} from "./nodeQuota.js";
import { orderNodesForUsers } from "./nodeOrder.js";
import { checkRecommendedPrefix, dedupeNodeIds } from "./policyNodeLists.js";
import { toRulesRefreshStatus } from "./rulesRefresh.js";
import {
  mapBridgeConstraintError,
  PostgresBridgeRepository,
  type BridgeRouteTarget,
} from "./bridgeRepository.js";
import { routeRegistration } from "./bridgeReadModel.js";
import {
  nodeReachabilityHistory,
  nodeReachabilityResults,
  nodeReachabilityState,
  reachabilityProbe,
} from "@amnezia/db";
import type {
  ReachabilityHistoryEntry,
  ReachabilityHistoryQuery,
  ReachabilityProbeView,
} from "./service.js";

const quotaStates: KeyState[] = ["provisioning", "active", "disabled"];

// Comparing a non-uuid string to a uuid column is a Postgres error, so a
// lookup by an admin-supplied id is only attempted when it has this shape.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Operational key metadata attached to audit events so the audit log can
 * identify the server, owner, device, protocol, and route profile even after
 * the key row is later purged. Never contains config secrets.
 */
const keyAuditSnapshot = (key: {
  ownerId: string;
  nodeId: string;
  endpointId?: string | null;
  protocol: string;
  routeProfile: string;
  deviceType: string;
  deviceLabel?: string | null;
  keyNumber?: number | null;
  internalName?: string | null;
}): Record<string, unknown> => ({
  ownerId: key.ownerId,
  nodeId: key.nodeId,
  ...(key.endpointId ? { endpointId: key.endpointId } : {}),
  protocol: key.protocol,
  routeProfile: key.routeProfile,
  deviceType: key.deviceType,
  ...(key.deviceLabel ? { deviceLabel: key.deviceLabel } : {}),
  ...(key.keyNumber !== null && key.keyNumber !== undefined
    ? { keyNumber: key.keyNumber }
    : {}),
  ...(key.internalName ? { internalName: key.internalName } : {}),
});

/**
 * Wider than `quotaStates` on purpose, and shared with the panel so the button
 * and the route agree on when a delete may be asked for. See the contract.
 */
const revocableStates: KeyState[] = [...REVOCABLE_KEY_STATES];

/**
 * States a rotate (fresh peer material) may be asked for from, whether the
 * reason is `enqueueOwnRotate`'s "refresh my rules" or a rename that changed
 * the displayed connection name. A key mid-provisioning or mid-revoke has no
 * settled peer to replace.
 *
 * `disabled` is deliberately absent, even though a disabled key still has a
 * settled peer that could technically be replaced. Disabling a key is an
 * administrator's decision (`adminAction`'s `keys/disable`), and rotating
 * always re-issues into `active` (see `completeProvision`) -- so letting an
 * owner rotate or rename a disabled key would let them silently undo that
 * decision. `queueKeyRotate` below checks for `disabled` explicitly, ahead of
 * this list, so the caller gets a reason that names what actually happened
 * instead of a generic "cannot be rotated".
 */
const rotatableStates: KeyState[] = ["active", "failed"];

const panelProtocols: ProtocolKind[] = ["awg2", "awg3"];

/**
 * Resolve the protocols a node can serve from its reported capabilities,
 * falling back to the node's primary protocol when none are reported yet.
 */
const deriveSupportedProtocols = (
  protocol: ProtocolKind,
  capabilities: unknown,
): ProtocolKind[] => {
  const caps = (capabilities ?? {}) as Record<string, unknown>;
  const supported = panelProtocols.filter((candidate) => caps[candidate] === true);
  return supported.length > 0 ? supported : [protocol];
};

// Keep only known protocols, ordered newest-first (awg3 before awg2).
const orderProtocols = (list: ProtocolKind[]): ProtocolKind[] =>
  PROTOCOL_KINDS.filter((protocol) => list.includes(protocol));

// Protocols a user may actually pick on a node =
// (node's enabled subset of its supported) ∩ (policy-allowed protocols).
const computeSelectableProtocols = (
  nodeSupported: ProtocolKind[],
  nodeEnabled: ProtocolKind[] | null | undefined,
  allowed: ProtocolKind[],
): ProtocolKind[] => {
  const offered =
    nodeEnabled && nodeEnabled.length > 0
      ? nodeSupported.filter((protocol) => nodeEnabled.includes(protocol))
      : nodeSupported;
  return orderProtocols(offered.filter((protocol) => allowed.includes(protocol)));
};
const adminPolicyUpdateSchema = portalPolicySchema.partial().extend({
  defaultKeyLimit: z.int().min(0).max(1_000).optional(),
  dailyRetentionDays: z.int().min(1).max(36_500).nullable().optional(),
  // Cloudflare Access two-way-sync config. The token is write-only: accepted on
  // update, encrypted at rest, and never returned by the read endpoint.
  cfApiToken: z.string().min(1).max(4_096).optional(),
  cfAccessAccountId: z.string().max(64).nullable().optional(),
  cfAccessAppId: z.string().max(64).nullable().optional(),
  cfAccessPolicyId: z.string().max(64).nullable().optional(),
  // Domains admitted by the Access policy, global-only like the fields above:
  // a per-user override here would let one user's policy change who Cloudflare
  // lets in for everybody.
  cfAccessAllowedDomains: accessDomainListSchema.optional(),
  // Global-only, exactly like defaultKeyLimit above: keeping them out of
  // portalPolicySchema is what stops them being overridable per user.
  recommendedNodeIds: recommendedNodeIdsSchema.optional(),
  nodeOrder: nodeOrderSchema.optional(),
  recommendedEndpointIds: recommendedNodeIdsSchema.optional(),
  endpointOrder: nodeOrderSchema.optional(),
  // Every background period the worker runs on, global-only for the same
  // reason: how often the panel talks to a node is a property of the
  // deployment, not of whoever is looking at it. Each is nullable — null hands
  // the period back to the worker's own default — and bounded by
  // WORKER_PERIOD_FIELDS, which is where the floors are justified.
  ...workerPeriodOverridesSchema.shape,
  // Accept the pre-0017 null as "no videos" instead of refusing the request.
  // Null and {} mean the same thing here, and a client echoing back a row it
  // read from an older panel must not be unable to save anything at all.
  installGuideVideos: installGuideVideosSchema
    .nullish()
    .transform((value) => value ?? {})
    .optional(),
});

type PortalPolicyRow = typeof portalPolicy.$inferSelect;

// The transaction handle drizzle passes to `db.transaction(async (tx) => ...)`.
// Mirrors the private type of the same name in @amnezia/db's armAccessSyncRow,
// which is structurally, not nominally, matched against it.
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const keyEndpointJoin = and(
  eq(nodeVpnEndpoints.nodeId, vpnKeys.nodeId),
  or(
    eq(nodeVpnEndpoints.id, vpnKeys.endpointId),
    and(isNull(vpnKeys.endpointId), eq(nodeVpnEndpoints.ordinal, 1)),
  ),
);

type StoredAwgLevel = { awgGenerator: AwgGeneratorSettings | null; awgMtu: number | null };

/** What an audit row records of client settings: the preset id and the MTU, never values. */
const clientSettingsAudit = (settings: {
  awgGenerator?: AwgGeneratorSettings | null;
  awgMtu?: number | null;
}) => ({ preset: settings.awgGenerator?.preset ?? null, awgMtu: settings.awgMtu ?? null });

/**
 * A key's AWG 3.1 client profile and MTU: the key, its owner's rule for the
 * key's device type, its owner, its address's rule for the key's device type,
 * its address (`keyEndpointJoin`), its node.
 */
const resolveKeyClientSettings = (levels: {
  key: StoredAwgLevel & { deviceType: string };
  owner: (StoredAwgLevel & { awgDeviceRules: unknown }) | null;
  endpoint: (StoredAwgLevel & { awgDeviceRules: unknown }) | null;
  node: StoredAwgLevel | null;
}): ResolvedAwgClientSettings => resolveAwgClientSettings({
  key: levels.key,
  userDevice: levels.owner ? deviceRuleFor(levels.owner.awgDeviceRules, levels.key.deviceType) : null,
  user: levels.owner,
  device: levels.endpoint ? deviceRuleFor(levels.endpoint.awgDeviceRules, levels.key.deviceType) : null,
  address: levels.endpoint,
  node: levels.node,
});

/** The full settings of the `issued` preset: what a pin writes for "as issued by the node". */
const issuedPresetSettings = (): AwgGeneratorSettings => {
  const issued = awgGeneratorPresets().find((preset) => preset.id === "issued");
  if (!issued) throw new Error("The issued preset is missing");
  return issued.settings;
};

/** A stored profile/MTU pair as a device rule, or null when it sets neither or is unreadable. */
const asClientRule = (value: { awgGenerator: unknown; awgMtu: unknown }) => {
  const rule = awgDeviceRuleSchema.safeParse(value);
  return rule.success ? rule.data : null;
};

const PIN_UNAVAILABLE = "PIN_UNAVAILABLE";

/**
 * The portal-policy fields that configure the Cloudflare Access two-way sync.
 * A request that names any of them changes what the sync connects to or
 * authenticates with, which is why it arms a run the same way a user change
 * does (reason "config") -- everything else about the policy is invisible to
 * the sync.
 */
const CF_ACCESS_CONFIG_FIELDS = [
  "cfApiToken",
  "cfAccessAccountId",
  "cfAccessAppId",
  "cfAccessPolicyId",
  "cfAccessAllowedDomains",
] as const;

// Canonicalize a validated global-routes object the same way custom routes are
// canonicalized: de-duplicate every list so stored data and merges stay minimal.
const dedupeGlobalRouteList = (list: {
  cidrs: string[];
  domains: string[];
}): { cidrs: string[]; domains: string[] } => ({
  cidrs: [...new Set(list.cidrs)],
  domains: [...new Set(list.domains)],
});

const dedupeGlobalRoutes = (routes: GlobalRoutes): GlobalRoutes => ({
  ru_blacklist: {
    add: dedupeGlobalRouteList(routes.ru_blacklist.add),
    exclude: dedupeGlobalRouteList(routes.ru_blacklist.exclude),
  },
});

// Audit metadata for a global-routes update: sizes only, never the entries.
const globalRouteCounts = (routes: GlobalRoutes): Record<string, number> => ({
  blacklistAddCidrs: routes.ru_blacklist.add.cidrs.length,
  blacklistAddDomains: routes.ru_blacklist.add.domains.length,
  blacklistExcludeCidrs: routes.ru_blacklist.exclude.cidrs.length,
  blacklistExcludeDomains: routes.ru_blacklist.exclude.domains.length,
});

// Canonicalize a validated custom-routes object: de-duplicate each list so the
// stored value and the export-time union stay minimal.
const dedupeCustomRoutes = (routes: CustomRoutes): CustomRoutes => ({
  ru_blacklist: {
    cidrs: [...new Set(routes.ru_blacklist.cidrs)],
    domains: [...new Set(routes.ru_blacklist.domains)],
  },
});

/**
 * Resolve a public endpoint's expected exit IPv4 from explicit endpoint exit,
 * node default exit, or implicit self-exit (IPv4 endpoint address) in routed mode.
 */
export const resolveEndpointEffectiveEgressIp = (input: {
  nodeEgressMode: NodeEgressMode;
  nodePublicIp: string | null;
  endpointAddress: string | null;
  endpointEgressIpv4: string | null;
  defaultEgressIpv4: string | null;
}): string | null => {
  if (input.nodeEgressMode === "routed") {
    const implicitSelfExit =
      input.endpointAddress && isIpv4Literal(input.endpointAddress)
        ? input.endpointAddress
        : input.nodePublicIp;
    return input.endpointEgressIpv4 ?? input.defaultEgressIpv4 ?? implicitSelfExit ?? null;
  }
  return input.nodePublicIp ?? input.endpointAddress ?? null;
};

export type EgressIpSummary = {
  ipv4: string;
  label: string | null;
  dnsPrimary: string;
  dnsSecondary: string | null;
};

/**
 * Compute admin-facing egress attribution for a VPN key. AWG 2.0 keys never
 * participate in multi-exit routing and always attribute masquerade via the
 * node's public IP.
 */
export const resolveKeyEgressInfo = (input: {
  protocol: ProtocolKind;
  nodePublicIp: string | null;
  nodeEgressMode: NodeEgressMode | null;
  endpointAddress: string | null;
  endpointEgress: EgressIpSummary | null;
  defaultEgress: EgressIpSummary | null;
}): KeyEgressInfo => {
  if (input.protocol !== "awg3") {
    return {
      effectiveExitIp: input.nodePublicIp ?? null,
      exitLabel: null,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: "1.0.0.1",
      mode: "masquerade",
    };
  }
  const mode = input.nodeEgressMode ?? "masquerade";
  if (mode !== "routed") {
    return {
      effectiveExitIp: input.nodePublicIp ?? null,
      exitLabel: null,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: "1.0.0.1",
      mode: "masquerade",
    };
  }
  const matched = input.endpointEgress ?? input.defaultEgress;
  return {
    effectiveExitIp: resolveEndpointEffectiveEgressIp({
      nodeEgressMode: mode,
      nodePublicIp: input.nodePublicIp,
      endpointAddress: input.endpointAddress,
      endpointEgressIpv4: input.endpointEgress?.ipv4 ?? null,
      defaultEgressIpv4: input.defaultEgress?.ipv4 ?? null,
    }),
    exitLabel: matched?.label ?? null,
    dnsPrimary: matched?.dnsPrimary ?? "1.1.1.1",
    dnsSecondary: matched ? matched.dnsSecondary : "1.0.0.1",
    mode,
  };
};

const endpointAllowsProtocol = (
  ep: { enabledProtocols?: readonly ProtocolKind[] | null },
  protocol: ProtocolKind,
): boolean =>
  !ep.enabledProtocols ||
  ep.enabledProtocols.length === 0 ||
  ep.enabledProtocols.includes(protocol);

/**
 * Resolve the effective entry endpoint and exit IP for a VPN key consistently
 * across user views, node counters, and targeted update notifications.
 * Protocols without endpoint support (e.g. AWG 2.0) never bind to AWG 3.1
 * entry variants or routed exit IPs.
 */
export const resolveEffectiveKeyAttachment = <
  TEndpoint extends {
    id: string;
    ordinal: number;
    egressIpId?: string | null;
    address?: string;
    publicAddress?: string;
  },
  TEgress extends { id: string; ipv4: string },
>(input: {
  protocol: ProtocolKind;
  endpointId: string | null;
  endpointsById: ReadonlyMap<string, TEndpoint>;
  primaryEndpoint: TEndpoint | undefined;
  nodePublicIp: string | null;
  nodeEgressMode: NodeEgressMode | null;
  nodeEgressDefaultIpId: string | null;
  nodeEgressIps: readonly TEgress[];
}): { endpoint: TEndpoint | null; exitIp: TEgress | null } => {
  if (!protocolSupportsEndpoints(input.protocol)) {
    return {
      endpoint: null,
      exitIp: input.nodePublicIp
        ? (input.nodeEgressIps.find((ip) => ip.ipv4 === input.nodePublicIp) ?? null)
        : null,
    };
  }
  const endpoint =
    (input.endpointId ? input.endpointsById.get(input.endpointId) : undefined) ??
    input.primaryEndpoint ??
    null;
  const endpointAddress = endpoint?.publicAddress ?? endpoint?.address ?? null;
  const exitIp =
    input.nodeEgressMode === "routed"
      ? (input.nodeEgressIps.find(
          (ip) => ip.id === (endpoint?.egressIpId ?? input.nodeEgressDefaultIpId),
        ) ?? null)
      : (input.nodeEgressIps.find(
          (ip) => ip.ipv4 === (input.nodePublicIp ?? endpointAddress),
        ) ?? null);
  return { endpoint, exitIp };
};

const toPolicy = (row: PortalPolicyRow | undefined): PortalPolicy =>
  row
    ? {
        allowKeyCreation: row.allowKeyCreation,
        allowNodeSelection: row.allowNodeSelection,
        useBridge: row.useBridge,
        allowedProtocols:
          row.allowedProtocols && row.allowedProtocols.length > 0
            ? row.allowedProtocols
            : DEFAULT_ALLOWED_PROTOCOLS,
        allowedNodeIds: row.allowedNodeIds ?? null,
        allowedEndpointIds: row.allowedEndpointIds ?? null,
        // Whether a key limit is per server or one shared pool. This list is
        // explicit, so a column missing from it never reaches
        // resolvePortalPolicy and the feature would silently read as its
        // default for everyone.
        keyLimitMode: row.keyLimitMode,
        allowRouteProfileSelection: row.allowRouteProfileSelection,
        allowCustomRoutes: row.allowCustomRoutes,
        allowConfigRedownload: row.allowConfigRedownload,
        allowQrDownload: row.allowQrDownload,
        allowConfDownload: row.allowConfDownload,
        allowSelfRevoke: row.allowSelfRevoke,
        autoPurgeOffboardedUsers: row.autoPurgeOffboardedUsers,
        showPublicKey: row.showPublicKey,
        showLastUsed: row.showLastUsed,
        showTraffic: row.showTraffic,
        showNodeStatus: row.showNodeStatus,
        showNodeAddress: row.showNodeAddress,
        showInstallReminder: row.showInstallReminder,
        showUpdateNotice: row.showUpdateNotice,
        // Null until an admin attaches recordings; the guide falls back to a
        // placeholder, so an empty object is the honest "none configured".
        installGuideVideos: row.installGuideVideos ?? {},
      }
    : defaultPortalPolicy;

// Remove the encrypted Cloudflare token fields from a policy row before it
// leaves the API, exposing only whether a token is currently set.
const stripPolicySecrets = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...row };
  // The admin page reads this row and posts it straight back, so anything it
  // emits must be something the update schema accepts. Rows written before
  // migration 0017 carry a null here while the contract models an object,
  // which rejected the whole form with a VALIDATION_ERROR - the same
  // normalisation toPolicy already does for the user-facing path.
  clone.installGuideVideos ??= {};
  const cfApiTokenSet = Boolean(clone.cfApiTokenCiphertext);
  delete clone.cfApiTokenCiphertext;
  delete clone.cfApiTokenNonce;
  delete clone.cfApiTokenAuthTag;
  delete clone.cfApiTokenKeyVersion;
  return { ...clone, cfApiTokenSet };
};

const toActor = (row: typeof users.$inferSelect): Actor => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  role: row.role,
  status: row.status,
});

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const isRetryableTransactionError = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return false;
    if ("code" in current) {
      const code = String(current.code);
      if (code === "40001" || code === "40P01") return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

const retryDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.min(50, 2 ** attempt) + Math.floor(Math.random() * 5));
  });

export type PostgresRepositoryOptions = {
  db: Database;
  keyring: EncryptionKeyring;
  activeKeyVersion?: number;
  bootstrapAdminEmails?: ReadonlySet<string>;
  // Email domains allowed to self-provision via a NON-Cloudflare login (the
  // server-side Google path). Cloudflare Access already gates its own path at
  // the edge, so this only guards direct logins. Empty = no domain is auto-
  // allowed; then only pre-created users (added by an admin) or bootstrap admins
  // may log in directly.
  allowedEmailDomains?: ReadonlySet<string>;
  /**
   * How old a bridge-agent observation may be and still be current
   * (`VPN_BRIDGE_OBSERVATION_STALE_MS`, see bridgeConfig.ts). Defaults to
   * five minutes.
   */
  bridgeObservationStaleMs?: number;
  /** `BRIDGE_AGENT_IMAGE_REPOSITORY`: the approved bridge-agent repository. */
  bridgeAgentImageRepository?: string;
  /** `VPN_BRIDGE_JOBS_ENABLED`; defaults to false (bridge jobs not queued). */
  bridgeJobsEnabled?: boolean;
  /** Capability lookup for probe candidate checks; tests inject a stand-in. */
  probeSupportsBridgeMeasurement?: (probe: ProbeCapabilityInput, now: Date) => boolean;
  /**
   * `VPN_BRIDGE_MANAGEMENT_HOSTS`: hosts a bridge management URL may name.
   * Defaults to `BRIDGE_MANAGEMENT_HOSTS_DEFAULT`.
   */
  bridgeManagementHosts?: readonly string[];
  /** HTTP client for bridge-agent calls at enrollment; tests inject one. */
  bridgeAgentFetch?: typeof fetch;
  bridgeAgentTimeoutMs?: number;
};

const BIGINT_METRIC_FIELDS = [
  "memTotalBytes",
  "memAvailableBytes",
  "swapTotalBytes",
  "swapUsedBytes",
  "diskTotalBytes",
  "diskAvailableBytes",
] as const;

/**
 * One host-metrics row, with its byte counters as decimal strings.
 *
 * Derived from the field list rather than written out field by field: a new
 * bigint column added to the table would otherwise serialise straight through
 * and 500 the page again, and the failure would look nothing like its cause.
 */
const toMetricsPayload = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = { ...row };
  for (const field of BIGINT_METRIC_FIELDS) {
    const value = payload[field];
    payload[field] = typeof value === "bigint" ? value.toString() : (value ?? null);
  }
  return payload;
};

/**
 * True for a 23505 raised by `constraint` (any 23505 when it is omitted).
 * drizzle wraps the driver's error, so the SQLSTATE and the constraint name are
 * on `cause` (DrizzleQueryError -> postgres.js PostgresError), not on the error
 * it throws. Checking only the top level looks right, passes a unit test with a
 * hand-made error, and never fires against a real database.
 */
const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const row = current as { code?: string; constraint_name?: string };
      if (row.code === "23505")
        return constraint === undefined || row.constraint_name === constraint;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * `node_service_checks_name_unique` exists so two checks cannot share a name -
 * the name is what a user sees on a chip, and two "Gemini" chips with different
 * verdicts are unreadable. Without this translation an admin retyping a name
 * gets a 500 for an ordinary mistake.
 */
const duplicateCheckName = (error: unknown): unknown =>
  isUniqueViolation(error)
    ? new ApiError(409, "A check with this name already exists", "CHECK_NAME_TAKEN")
    : error;

export class PostgresControlRepository implements ControlRepository {
  private readonly activeKeyVersion: number;
  // The bridge registry lives in its own module; this class delegates to it
  // and calls into it from the node update and delete transactions.
  private readonly bridges: PostgresBridgeRepository;

  constructor(private readonly options: PostgresRepositoryOptions) {
    this.activeKeyVersion =
      options.activeKeyVersion ??
      Math.max(...Object.keys(options.keyring).map(Number));
    if (!options.keyring[this.activeKeyVersion]) {
      throw new Error("The active encryption key version is not in the keyring");
    }
    this.bridges = new PostgresBridgeRepository({
      db: options.db,
      keyring: options.keyring,
      activeKeyVersion: this.activeKeyVersion,
      observationStaleMs:
        options.bridgeObservationStaleMs ?? BRIDGE_OBSERVATION_STALE_MS_DEFAULT,
      bridgeAgentImageRepository: options.bridgeAgentImageRepository,
      jobsEnabled: options.bridgeJobsEnabled ?? false,
      probeSupportsBridgeMeasurement: options.probeSupportsBridgeMeasurement,
      managementHosts: options.bridgeManagementHosts ?? BRIDGE_MANAGEMENT_HOSTS_DEFAULT,
      bridgeAgentFetch: options.bridgeAgentFetch,
      bridgeAgentTimeoutMs: options.bridgeAgentTimeoutMs,
    });
  }

  listBridges = (_actor: Actor): Promise<Bridge[]> => this.bridges.listBridges();
  createBridge = (actor: Actor, request: CreateBridgeRequest): Promise<Bridge> =>
    this.bridges.createBridge(actor, request);
  updateBridge = (
    actor: Actor,
    bridgeId: string,
    request: UpdateBridgeRequest,
  ): Promise<Bridge> => this.bridges.updateBridge(actor, bridgeId, request);
  getBridgeAgentUpdate = (_actor: Actor, bridgeId: string): Promise<BridgeAgentUpdateView> =>
    this.bridges.getAgentUpdate(bridgeId);
  getBridgeRollbackPreflight = (_actor: Actor): Promise<BridgeRollbackPreflight> =>
    this.bridges.getRollbackPreflight();
  requestBridgeAgentUpdate = (
    actor: Actor,
    bridgeId: string,
    request: RequestBridgeAgentUpdate,
  ): Promise<RequestBridgeAgentUpdateResult> =>
    this.bridges.requestAgentUpdate(actor, bridgeId, request);
  deleteBridge = (actor: Actor, bridgeId: string): Promise<DeleteBridgeResult> =>
    this.bridges.deleteBridge(actor, bridgeId);
  getBridgeEligibility = async (
    _actor: Actor,
    nodeId: string,
  ): Promise<BridgeEligibility> => {
    const [node] = await this.options.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
    return this.bridges.bridgeEligibility(nodeId);
  };

  getNodeBridgeRoutes = (_actor: Actor, nodeId: string): Promise<NodeBridgeRoutes> =>
    this.bridges.getNodeBridgeRoutes(nodeId);
  prepareBridgeRoute = (
    actor: Actor,
    nodeId: string,
    request: PrepareBridgeRouteRequest,
  ): Promise<PrepareBridgeRouteResult> =>
    this.bridges.prepareRoute(actor, nodeId, request);
  releaseBridgeRoute = (
    actor: Actor,
    routeId: string,
  ): Promise<ReleaseBridgeRouteResult> => this.bridges.releaseRoute(actor, routeId);
  updateBridgeRouteTransport = (
    actor: Actor,
    routeId: string,
    request: UpdateBridgeRouteTransportRequest,
  ): Promise<NodeBridgeRoute> => this.bridges.updateRouteTransport(actor, routeId, request);
  findBridgeRouteTarget = (routeId: string): Promise<BridgeRouteTarget | null> =>
    this.bridges.findRouteTarget(routeId);
  verifyBridgeRoute = (
    actor: Actor,
    routeId: string,
    request: VerifyBridgeRouteRequest,
  ): Promise<VerifyBridgeRouteResult> => this.bridges.verifyRoute(actor, routeId, request);

  /**
   * `GET /api/admin/infrastructure`: VPN nodes (the admin nodes list's summary
   * fields plus their endpoint assignment) followed by bridges. VPN-node
   * consumers keep reading their own endpoints; this view only adds `kind`.
   */
  listInfrastructure = async (_actor: Actor): Promise<InfrastructureItem[]> => {
    const [nodeRows, endpoints, bridgeRows] = await Promise.all([
      this.listAdminNodes(),
      this.bridges.nodeEndpointSummaries(),
      this.bridges.listBridges(),
    ]);
    const vpnItems: InfrastructureItem[] = nodeRows.map((row) => ({
      kind: "vpn" as const,
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      publicName: row.publicName,
      protocol: row.protocol,
      enabledProtocols: row.enabledProtocols,
      maxPeers: row.maxPeers,
      peerCount: row.peerCount,
      onlinePeerCount: row.onlinePeerCount,
      onlineByProtocol: row.onlineByProtocol,
      publicHost: row.publicHost,
      publicIp: row.publicIp,
      agentVersion: row.agentVersion,
      lastHealthAt: row.lastHealthAt ? row.lastHealthAt.toISOString() : null,
      lastError: row.lastError,
      activeRoute: endpoints.get(row.id)?.activeRoute ?? null,
      vpnEndpointRevision: endpoints.get(row.id)?.vpnEndpointRevision ?? 0,
    }));
    const bridgeItems: InfrastructureItem[] = bridgeRows.map((bridge) => ({
      kind: "bridge" as const,
      ...bridge,
    }));
    return [...vpnItems, ...bridgeItems];
  };

  resolveIdentity = async (claim: IdentityClaim): Promise<Actor> => {
    const email = normalizeEmail(claim.email);
    // The probe's machine account never signs in, whatever an identity
    // provider claims.
    if (email === SERVICE_ACCOUNT_EMAIL) {
      throw new ApiError(403, "User is disabled", "USER_DISABLED");
    }
    const resolve = () => this.options.db.transaction(async (tx) => {
      const existingIdentity = await tx
        .select({ user: users })
        .from(identities)
        .innerJoin(users, eq(identities.userId, users.id))
        .where(
          and(
            eq(identities.provider, claim.provider),
            eq(identities.subject, claim.subject),
          ),
        )
        .limit(1);
      if (existingIdentity[0]) {
        await tx
          .update(identities)
          .set({ emailAtLogin: email, lastLoginAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(identities.provider, claim.provider),
              eq(identities.subject, claim.subject),
            ),
          );
        if (existingIdentity[0].user.serviceAccount) {
          throw new ApiError(403, "User is disabled", "USER_DISABLED");
        }
        if (
          this.options.bootstrapAdminEmails?.has(email) &&
          existingIdentity[0].user.role !== "admin"
        ) {
          const [promoted] = await tx
            .update(users)
            .set({ role: "admin", updatedAt: new Date() })
            .where(eq(users.id, existingIdentity[0].user.id))
            .returning();
          if (promoted) return toActor(promoted);
        }
        return toActor(existingIdentity[0].user);
      }

      let user = (
        await tx.select().from(users).where(eq(users.email, email)).limit(1)
      )[0];
      if (!user) {
        // A brand-new account via a NON-Cloudflare login (the direct Google
        // path) must pass the panel allowlist: an allowed email domain or a
        // bootstrap admin. Cloudflare Access already allowlisted its own path at
        // the edge, so it is trusted here. Anyone else must be pre-created by an
        // admin (which sets `user` above and skips this gate).
        if (claim.provider !== "cloudflare-access") {
          const domain = email.split("@")[1] ?? "";
          // Two sources, deliberately unioned. `cfAccessAllowedDomains` is the
          // list an admin actually manages — the Users page edits it and
          // `cf-domains` edits it from a shell — and it is what the worker
          // writes into the Access policy, so a domain added there now admits
          // the same people at BOTH doors rather than only the proxied one.
          // `allowedEmailDomains` (AUTH_ALLOWED_DOMAINS) stays because an
          // install with no Cloudflare at all has an empty panel list and that
          // env is then its only allowlist; it is also read once at boot, so it
          // cannot be the place a domain is added day to day.
          //
          // Read inside the transaction rather than cached on the instance: an
          // allowlist edited in the UI has to take effect on the next login,
          // not on the next deploy.
          const managed = (
            await tx
              .select({ domains: portalPolicy.cfAccessAllowedDomains })
              .from(portalPolicy)
              .limit(1)
          )[0]?.domains;
          // Normalised on the way in by `accessDomainSchema`, but the worker is
          // deliberately lenient about what Cloudflare hands back, so a row can
          // predate that or carry a dashboard spelling ("@company.tld").
          const managedHasDomain = (managed ?? []).some(
            (entry) => normalizeAccessDomain(entry) === domain,
          );
          const allowed =
            this.options.allowedEmailDomains?.has(domain) ||
            managedHasDomain ||
            this.options.bootstrapAdminEmails?.has(email);
          if (!allowed) {
            throw new ApiError(
              403,
              "This account is not allowed — ask an administrator to add you",
              "NOT_ALLOWED",
            );
          }
        }
        [user] = await tx
          .insert(users)
          .values({
            email,
            role: this.options.bootstrapAdminEmails?.has(email) ? "admin" : "user",
          })
          .returning();
      } else if (
        this.options.bootstrapAdminEmails?.has(email) &&
        user.role !== "admin"
      ) {
        [user] = await tx
          .update(users)
          .set({ role: "admin", updatedAt: new Date() })
          .where(eq(users.id, user.id))
          .returning();
      }
      if (!user) throw new Error("Failed to create identity user");
      await tx.insert(identities).values({
        userId: user.id,
        provider: claim.provider,
        subject: claim.subject,
        emailAtLogin: email,
        lastLoginAt: new Date(),
      });
      return toActor(user);
    });

    for (let retries = 0; ; retries += 1) {
      try {
        return await resolve();
      } catch (error) {
        // A concurrent first login can claim the email or the provider identity.
        // Retry the full transaction so a tentative user rolls back and the
        // next attempt reads the committed account or identity.
        const collision =
          isUniqueViolation(error, "users_email_unique") ||
          isUniqueViolation(error, "identities_provider_subject_unique");
        if (!collision || retries === 2) throw error;
      }
    }
  };

  getMe = async (actor: Actor): Promise<Record<string, unknown>> => {
    const [userRow, policyRow, keyCountRow, perNodeRows] = await Promise.all([
      this.options.db.select().from(users).where(eq(users.id, actor.id)).limit(1),
      this.options.db.select().from(portalPolicy).limit(1),
      this.options.db
        .select({ value: count() })
        .from(vpnKeys)
        .where(
          and(eq(vpnKeys.ownerId, actor.id), inArray(vpnKeys.state, quotaStates)),
        ),
      // Per-node usage so the client can show per-node quota (the limit is
      // per-node, not a single total). Per-server traffic is fetched separately
      // (period-scoped) via /api/traffic/by-node.
      this.options.db
        .select({ nodeId: vpnKeys.nodeId, value: count() })
        .from(vpnKeys)
        .where(
          and(eq(vpnKeys.ownerId, actor.id), inArray(vpnKeys.state, quotaStates)),
        )
        .groupBy(vpnKeys.nodeId),
    ]);
    const user = userRow[0];
    if (!user) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
    const globalPolicy = policyRow[0];
    const policy = resolvePortalPolicy(toPolicy(globalPolicy), user.policyOverride);
    const quotaContext: NodeQuotaContext = {
      defaultKeyLimit: globalPolicy?.defaultKeyLimit ?? 5,
      keyLimitOverride: user.keyLimitOverride,
      nodeKeyLimits: user.nodeKeyLimits,
    };
    const usedByNode = new Map(perNodeRows.map((row) => [row.nodeId, row.value]));
    // Report a node when the user already holds keys there OR when an admin set
    // an explicit per-node limit for it, so the client never has to guess a
    // configured limit from a node with no keys yet.
    const perNodeIds = [
      ...new Set([
        ...usedByNode.keys(),
        ...nodeIdsWithExplicitLimit(user.nodeKeyLimits),
      ]),
    ].sort();
    const keyLimitMode = policy.keyLimitMode;
    // Per-node mode: the flat limit is the fallback for nodes with no entry.
    // Global mode: the flat limit IS the pool, and every node reports it, so a
    // client that only knows per-node numbers still sees the right ceiling.
    const keyLimit = resolvePoolKeyLimit(quotaContext);
    return {
      keyLimit,
      keyLimitMode,
      keyCount: keyCountRow[0]?.value ?? 0,
      perNode: perNodeIds.map((nodeId) => ({
        nodeId,
        used: usedByNode.get(nodeId) ?? 0,
        limit:
          keyLimitMode === "global"
            ? keyLimit
            : resolveNodeKeyLimit(quotaContext, nodeId),
      })),
      policy,
      // The user's own custom routes (normalized to both split-tunnel profiles).
      customRoutes: customRoutesSchema.parse(user.customRoutes ?? {}),
      // How many times this person has already answered each interruption. Sent
      // as a count rather than as a "show it?" verdict: whether to show is a
      // question about the policy AND the role AND the count, and the policy and
      // the role are already in this payload.
      notices: noticeAcksSchema.parse({
        install: user.installNoticeAcks,
        update: user.updateNoticeAcks,
      }),
    };
  };

  /**
   * Record that the caller answered one of the panel's two interruptions.
   *
   * Increments in SQL rather than reading-then-writing: two tabs open on the
   * same key is an ordinary way to use this panel, and a read-modify-write
   * would lose one of the two answers and show the notice again.
   *
   * Not gated on the policy flag. Switching the notice off mid-flight must not
   * turn an ack that is already in the air into a 403 the browser reports to a
   * user who has done nothing wrong; the flag decides whether to ASK, and this
   * only records an answer that was given.
   */
  ackNotice = async (actor: Actor, kind: NoticeKind): Promise<NoticeAcks> => {
    const bump =
      kind === "install"
        ? { installNoticeAcks: sql`${users.installNoticeAcks} + 1` }
        : { updateNoticeAcks: sql`${users.updateNoticeAcks} + 1` };
    return this.options.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({ ...bump, updatedAt: new Date() })
        .where(eq(users.id, actor.id))
        .returning({
          install: users.installNoticeAcks,
          update: users.updateNoticeAcks,
        });
      if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      // Audited because it is a signature: the user is asserting they updated
      // the client. At most three rows per account for the lifetime of the
      // account, so this costs the audit log nothing.
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "user.notice_signed",
        targetType: "user",
        targetId: actor.id,
        metadata: { notice: kind, count: updated[kind] },
      });
      return noticeAcksSchema.parse(updated);
    });
  };

  trafficSeries = async ({
    ownerId,
    days,
  }: {
    ownerId?: string;
    days: number;
  }): Promise<
    Array<{ date: string; receivedBytes: string; sentBytes: string }>
  > => {
    const clampedDays = Math.min(Math.max(Math.trunc(days), 1), 365);
    // Include today: days=1 → today only, days=7 → last 7 days, etc.
    const since = new Date(Date.now() - (clampedDays - 1) * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await this.options.db
      .select({
        bucket: trafficRollups.bucketStart,
        received: sum(trafficRollups.receivedBytes),
        sent: sum(trafficRollups.sentBytes),
      })
      .from(trafficRollups)
      .innerJoin(vpnKeys, eq(vpnKeys.id, trafficRollups.keyId))
      // The probe's own tunnels are not anyone's traffic.
      .innerJoin(users, keyOwnerIsPerson(vpnKeys))
      .where(
        and(
          eq(trafficRollups.period, "day"),
          gte(trafficRollups.bucketStart, since),
          ...(ownerId ? [eq(vpnKeys.ownerId, ownerId)] : []),
        ),
      )
      .groupBy(trafficRollups.bucketStart)
      .orderBy(trafficRollups.bucketStart);
    return rows.map((row) => ({
      date: row.bucket.toISOString().slice(0, 10),
      receivedBytes: String(row.received ?? "0"),
      sentBytes: String(row.sent ?? "0"),
    }));
  };

  // Traffic totalled per node for Today / last 7 days / last 30 days in one
  // query (from daily rollups), so each server row can show all three inline
  // without a period toggle.
  nodeTrafficPeriods = async ({
    ownerId,
  }: {
    ownerId?: string;
  }): Promise<NodeTrafficPeriods[]> => {
    const dayMs = 24 * 60 * 60 * 1000;
    const monthStart = new Date(Date.now() - 29 * dayMs);
    monthStart.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(Date.now() - 6 * dayMs);
    weekStart.setUTCHours(0, 0, 0, 0);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const filteredSum = (
      col:
        | typeof trafficRollups.receivedBytes
        | typeof trafficRollups.sentBytes,
      from: Date,
    ) =>
      // from.toISOString() — a raw Date isn't a valid bind param inside sql``.
      sql<string>`coalesce(sum(${col}) filter (where ${trafficRollups.bucketStart} >= ${from.toISOString()}), 0)::text`;
    const rows = await this.options.db
      .select({
        nodeId: vpnKeys.nodeId,
        todayReceived: filteredSum(trafficRollups.receivedBytes, todayStart),
        todaySent: filteredSum(trafficRollups.sentBytes, todayStart),
        weekReceived: filteredSum(trafficRollups.receivedBytes, weekStart),
        weekSent: filteredSum(trafficRollups.sentBytes, weekStart),
        monthReceived: filteredSum(trafficRollups.receivedBytes, monthStart),
        monthSent: filteredSum(trafficRollups.sentBytes, monthStart),
      })
      .from(trafficRollups)
      .innerJoin(vpnKeys, eq(vpnKeys.id, trafficRollups.keyId))
      .innerJoin(users, keyOwnerIsPerson(vpnKeys))
      .where(
        and(
          eq(trafficRollups.period, "day"),
          gte(trafficRollups.bucketStart, monthStart),
          ...(ownerId ? [eq(vpnKeys.ownerId, ownerId)] : []),
        ),
      )
      .groupBy(vpnKeys.nodeId);
    return rows.map((row) => ({
      nodeId: row.nodeId,
      today: { receivedBytes: row.todayReceived, sentBytes: row.todaySent },
      week: { receivedBytes: row.weekReceived, sentBytes: row.weekSent },
      month: { receivedBytes: row.monthReceived, sentBytes: row.monthSent },
    }));
  };

  /**
   * The user-facing reachability verdict for each of `nodeIds`
   * (`toUserReachability`). Reads only the columns that verdict depends on, so
   * nothing about the probe itself (label, host, credentials) is even loaded.
   */
  private loadUserReachability = async (
    nodeIds: readonly string[],
  ): Promise<Map<string, UserNodeReachability>> => {
    if (nodeIds.length === 0) return new Map();
    const [probe, stateRows] = await Promise.all([
      this.loadUserReachabilityProbe(),
      this.options.db
        .select({
          nodeId: nodes.id,
          reachabilityEnabled: nodes.reachabilityEnabled,
          status: nodeReachabilityState.status,
          failingSince: nodeReachabilityState.failingSince,
          checkedAt: nodeReachabilityState.checkedAt,
        })
        .from(nodes)
        .leftJoin(nodeReachabilityState, eq(nodeReachabilityState.nodeId, nodes.id))
        .where(inArray(nodes.id, [...nodeIds])),
    ]);
    const now = new Date();
    return new Map(
      stateRows.map((row) => [
        row.nodeId,
        toUserReachability({
          probe,
          reachabilityEnabled: row.reachabilityEnabled,
          state:
            row.status !== null && row.checkedAt !== null
              ? { status: row.status, failingSince: row.failingSince, checkedAt: row.checkedAt }
              : null,
          now,
        }),
      ]),
    );
  };

  /** The probe columns `toUserReachability` reads, or null without a probe. */
  private loadUserReachabilityProbe = async (db: Database | DbTransaction = this.options.db) => {
    const [probe] = await db
      .select({
        enabled: reachabilityProbe.enabled,
        lastResultAt: reachabilityProbe.lastResultAt,
        staleAfterSec: reachabilityProbe.staleAfterSec,
        intervalSec: reachabilityProbe.intervalSec,
        staleAlertedAt: reachabilityProbe.staleAlertedAt,
        enabledAt: reachabilityProbe.enabledAt,
        lastRunMass: reachabilityProbe.lastRunMass,
        probeDirectWhenBridged: reachabilityProbe.probeDirectWhenBridged,
      })
      .from(reachabilityProbe)
      .where(eq(reachabilityProbe.id, 1))
      .limit(1);
    return probe ?? null;
  };

  private enqueueNodeSyncEgress = async (
    tx: DbTransaction,
    nodeId: string,
  ): Promise<void> => {
    await tx.insert(jobOutbox).values({
      type: NODE_SYNC_EGRESS_JOB_TYPE,
      deduplicationKey: `${NODE_SYNC_EGRESS_JOB_TYPE}:${nodeId}:${randomUUID()}`,
      payload: { nodeId },
    });
  };

  private scrubRemovedIdsFromPolicies = async (
    tx: DbTransaction,
    removedIds: ReadonlySet<string>,
  ): Promise<void> => {
    if (removedIds.size === 0) return;
    const [policyRow] = await tx
      .select({
        endpointOrder: portalPolicy.endpointOrder,
        recommendedEndpointIds: portalPolicy.recommendedEndpointIds,
        allowedEndpointIds: portalPolicy.allowedEndpointIds,
      })
      .from(portalPolicy)
      .limit(1);
    if (policyRow) {
      const hasOrder = policyRow.endpointOrder.some((id) => removedIds.has(id));
      const hasRec = policyRow.recommendedEndpointIds.some((id) => removedIds.has(id));
      const hasAllowed = (policyRow.allowedEndpointIds ?? []).some((id) => removedIds.has(id));
      if (hasOrder || hasRec || hasAllowed) {
        await tx
          .update(portalPolicy)
          .set({
            endpointOrder: policyRow.endpointOrder.filter((id) => !removedIds.has(id)),
            recommendedEndpointIds: policyRow.recommendedEndpointIds.filter((id) => !removedIds.has(id)),
            ...(policyRow.allowedEndpointIds !== null
              ? { allowedEndpointIds: policyRow.allowedEndpointIds.filter((id) => !removedIds.has(id)) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(portalPolicy.id, true));
      }
    }
    const userRows = await tx
      .select({ id: users.id, policyOverride: users.policyOverride })
      .from(users)
      .where(isNotNull(users.policyOverride));
    for (const user of userRows) {
      const allowed = user.policyOverride?.allowedEndpointIds;
      if (!allowed || !allowed.some((id) => removedIds.has(id))) continue;
      const nextAllowed = allowed.filter((id) => !removedIds.has(id));
      const nextOverride: PortalPolicyOverride = {
        ...user.policyOverride,
        allowedEndpointIds: nextAllowed,
      };
      await tx
        .update(users)
        .set({ policyOverride: nextOverride, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }
  };

  private recomputeEntryGroupNames = async (
    tx: DbTransaction,
    nodeId: string,
    address: string,
  ): Promise<void> => {
    const siblings = await tx
      .select({
        id: nodeVpnEndpoints.id,
        entryName: nodeVpnEndpoints.entryName,
        customName: nodeVpnEndpoints.customName,
        variantOrdinal: nodeVpnEndpoints.variantOrdinal,
        name: nodeVpnEndpoints.name,
      })
      .from(nodeVpnEndpoints)
      .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.address, address)))
      .orderBy(asc(nodeVpnEndpoints.variantOrdinal), asc(nodeVpnEndpoints.ordinal));
    const siblingCount = siblings.length;
    for (const sibling of siblings) {
      const nextName = computeEndpointDisplayName({
        entryName: sibling.entryName,
        customName: sibling.customName,
        variantOrdinal: sibling.variantOrdinal,
        siblingCount,
      });
      if (nextName !== sibling.name) {
        await tx
          .update(nodeVpnEndpoints)
          .set({ name: nextName })
          .where(eq(nodeVpnEndpoints.id, sibling.id));
      }
    }
  };

  private toNodeEgressIpView = (
    row: typeof nodeEgressIps.$inferSelect,
    entryAddresses: readonly string[],
    assignedEndpointCount: number,
  ): NodeEgressIp => ({
    id: row.id,
    nodeId: row.nodeId,
    ipv4: row.ipv4,
    label: row.label,
    interfaceName: row.interfaceName,
    gatewayIpv4: row.gatewayIpv4,
    routingTableId: row.routingTableId,
    dnsPrimary: row.dnsPrimary,
    dnsSecondary: row.dnsSecondary,
    amneziaDnsDnat: row.amneziaDnsDnat,
    enforceDnsDnat: row.enforceDnsDnat,
    allowAsEntry: row.allowAsEntry,
    enabled: row.enabled,
    hostState: row.hostState,
    hostDetail: row.hostDetail,
    observedSubnetCidr: row.observedSubnetCidr,
    detectedGatewayIpv4: row.detectedGatewayIpv4,
    txBytes: String(row.txBytes),
    txPackets: String(row.txPackets),
    hostObservedAt: row.hostObservedAt?.toISOString() ?? null,
    subnetWarning: detectExitSubnetProximityWarning({
      exitIpv4: row.ipv4,
      observedSubnetCidr: row.observedSubnetCidr,
      entryAddresses,
      allowAsEntry: row.allowAsEntry,
    }),
    assignedEndpointCount,
    keyUpdateNotifiedAt: row.keyUpdateNotifiedAt?.toISOString() ?? null,
    keyUpdateNotifyNote: row.keyUpdateNotifyNote ?? null,
  });

  private loadNodeEgressIpsMap = async (
    nodeIds: readonly string[],
    db: Database | DbTransaction = this.options.db,
  ): Promise<Map<string, NodeEgressIp[]>> => {
    const map = new Map<string, NodeEgressIp[]>();
    if (nodeIds.length === 0) return map;
    const [ipRows, endpointRows] = await Promise.all([
      db
        .select()
        .from(nodeEgressIps)
        .where(inArray(nodeEgressIps.nodeId, [...nodeIds]))
        .orderBy(asc(nodeEgressIps.routingTableId), asc(nodeEgressIps.createdAt)),
      db
        .select({
          nodeId: nodeVpnEndpoints.nodeId,
          address: nodeVpnEndpoints.address,
          egressIpId: nodeVpnEndpoints.egressIpId,
        })
        .from(nodeVpnEndpoints)
        .where(inArray(nodeVpnEndpoints.nodeId, [...nodeIds])),
    ]);
    const addressesByNode = new Map<string, Set<string>>();
    const countByEgressId = new Map<string, number>();
    for (const ep of endpointRows) {
      const set = addressesByNode.get(ep.nodeId) ?? new Set<string>();
      set.add(ep.address);
      addressesByNode.set(ep.nodeId, set);
      if (ep.egressIpId) {
        countByEgressId.set(ep.egressIpId, (countByEgressId.get(ep.egressIpId) ?? 0) + 1);
      }
    }
    for (const row of ipRows) {
      const entries = [...(addressesByNode.get(row.nodeId) ?? [])];
      const list = map.get(row.nodeId) ?? [];
      list.push(this.toNodeEgressIpView(row, entries, countByEgressId.get(row.id) ?? 0));
      map.set(row.nodeId, list);
    }
    return map;
  };

  private loadNodePublicEndpoints = async (
    nodeIds: readonly string[],
    db: Database | DbTransaction = this.options.db,
  ): Promise<Map<string, AdminNodeEndpoint[]>> => {
    const result = new Map<string, AdminNodeEndpoint[]>();
    if (nodeIds.length === 0) return result;
    const endpointEgress = alias(nodeEgressIps, "endpoint_egress_ip");
    const defaultEgress = alias(nodeEgressIps, "node_default_egress_ip");
    const [probe, rows] = await Promise.all([
      this.loadUserReachabilityProbe(db),
      db
        .select({
          endpoint: nodeVpnEndpoints,
          checksEnabled: nodes.reachabilityEnabled,
          nodeEgressMode: nodes.egressMode,
          nodePublicIp: nodes.publicIp,
          endpointEgressIpv4: endpointEgress.ipv4,
          defaultEgressIpv4: defaultEgress.ipv4,
          activeRoute: vpnBridgeRoutes.id,
        })
        .from(nodeVpnEndpoints)
        .innerJoin(nodes, eq(nodes.id, nodeVpnEndpoints.nodeId))
        .leftJoin(endpointEgress, eq(endpointEgress.id, nodeVpnEndpoints.egressIpId))
        .leftJoin(defaultEgress, eq(defaultEgress.id, nodes.egressDefaultIpId))
        .leftJoin(vpnBridgeRoutes, and(
          eq(vpnBridgeRoutes.nodeId, nodeVpnEndpoints.nodeId),
          eq(vpnBridgeRoutes.state, "active"),
        ))
        .where(inArray(nodeVpnEndpoints.nodeId, [...nodeIds]))
        .orderBy(nodeVpnEndpoints.ordinal),
    ]);
    const now = new Date();
    for (const {
      endpoint,
      checksEnabled,
      nodeEgressMode,
      nodePublicIp,
      endpointEgressIpv4,
      defaultEgressIpv4,
    } of rows) {
      const checkedAt = endpoint.probeCheckedAt;
      const canUseProbe =
        checksEnabled &&
        endpoint.enabled &&
        endpoint.reachabilityEnabled;
      const hasCurrentSample = probe?.enabled && checkedAt && checkedAt >= probe.enabledAt &&
        !isProbeStale({
          now,
          staleAfterSec: probe.staleAfterSec,
          intervalSec: probe.intervalSec,
          lastResultAt: checkedAt,
          since: checkedAt,
        });
      const state = canUseProbe && hasCurrentSample && endpoint.probeStatus && checkedAt
        ? {
            status: endpoint.probeStatus,
            checkedAt,
            failingSince: endpoint.probeFailingSince ?? null,
          }
        : null;
      const reachability = toUserReachability({
        probe: probe && state?.status === "ok" ? { ...probe, lastRunMass: false } : probe,
        reachabilityEnabled: canUseProbe,
        state,
        now,
      });
      const parsedLevels = endpoint.probeLevels
        ? (probeLevelsSchema.safeParse(endpoint.probeLevels).data ?? null)
        : null;
      const effectiveEgressIp = resolveEndpointEffectiveEgressIp({
        nodeEgressMode,
        nodePublicIp,
        endpointAddress: endpoint.address,
        endpointEgressIpv4,
        defaultEgressIpv4,
      });
      const list = result.get(endpoint.nodeId) ?? [];
      list.push({
        id: endpoint.id,
        ordinal: endpoint.ordinal,
        name: endpoint.name,
        entryName: endpoint.entryName,
        customName: endpoint.customName,
        variantOrdinal: endpoint.variantOrdinal,
        egressIpId: endpoint.egressIpId,
        effectiveEgressIp,
        egressAutoRotateEnabled: endpoint.egressAutoRotateEnabled,
        egressAutoRotatePoolIds: endpoint.egressAutoRotatePoolIds ?? [],
        egressAutoRotatedAt: endpoint.egressAutoRotatedAt?.toISOString() ?? null,
        probeObservedEgressIp: endpoint.probeObservedEgressIp,
        probeEgressMatch: endpoint.probeEgressMatch,
        publicAddress: endpoint.address,
        enabled: endpoint.enabled,
        reachabilityEnabled: endpoint.reachabilityEnabled,
        bridgeMode: endpoint.bridgeMode,
        enabledProtocols: endpoint.enabledProtocols ?? null,
        keyUpdateNotifiedAt: endpoint.keyUpdateNotifiedAt?.toISOString() ?? null,
        keyUpdateNotifyNote: endpoint.keyUpdateNotifyNote ?? null,
        awgGenerator: endpoint.awgGenerator,
        awgMtu: endpoint.awgMtu,
        awgDeviceRules: endpoint.awgDeviceRules,
        reachability,
        probeStatus: state?.status ?? null,
        probeLevels: state ? parsedLevels : null,
        probeCheckedAt: state?.checkedAt.toISOString() ?? null,
        probeFailingSince: state && endpoint.probeFailingSince ? endpoint.probeFailingSince.toISOString() : null,
        probeConsecutiveFailures: endpoint.probeConsecutiveFailures,
        incidentOpen: endpoint.probeAlertedAt !== null,
        probeDetail: state ? endpoint.probeDetail : null,
      });
      result.set(endpoint.nodeId, list);
    }
    return result;
  };

  /**
   * The verdict for a key card: the result of the key's OWN protocol on its
   * node, on every node (Direct or bridged). A missing row reads unknown, so
   * an AWG 3.1 card is not painted green by a working AWG 2 path (or the
   * other way round). The server badge stays the node verdict.
   */
  private loadKeyReachability = async (
    nodeIds: readonly string[],
    db: Database | DbTransaction = this.options.db,
  ): Promise<(nodeId: string, protocol: ProtocolKind) => UserNodeReachability> => {
    if (nodeIds.length === 0) return () => UNKNOWN_USER_REACHABILITY;
    const [probe, rows] = await Promise.all([
      this.loadUserReachabilityProbe(db),
      db
        .select({
          nodeId: nodeReachabilityResults.nodeId,
          protocol: nodeReachabilityResults.protocol,
          reachabilityEnabled: nodes.reachabilityEnabled,
          activeBridgeRouteId: vpnBridgeRoutes.id,
          status: nodeReachabilityResults.status,
          checkedAt: nodeReachabilityResults.checkedAt,
          failingSince: nodeReachabilityResults.failingSince,
        })
        .from(nodeReachabilityResults)
        .innerJoin(nodes, eq(nodes.id, nodeReachabilityResults.nodeId))
        .leftJoin(vpnBridgeRoutes, and(
          eq(vpnBridgeRoutes.nodeId, nodes.id),
          eq(vpnBridgeRoutes.state, "active"),
        ))
        .where(inArray(nodeReachabilityResults.nodeId, [...nodeIds])),
    ]);
    const now = new Date();
    const byKey = new Map(
      rows.filter((row) =>
        row.protocol !== "awg2" || row.activeBridgeRouteId === null || probe?.probeDirectWhenBridged,
      ).map((row) => [
        `${row.nodeId}:${row.protocol}`,
        toUserReachability({
          probe,
          reachabilityEnabled: row.reachabilityEnabled,
          state: {
            status: row.status,
            failingSince: row.failingSince,
            checkedAt: row.checkedAt,
          },
          now,
        }),
      ]),
    );
    return (nodeId, protocol) =>
      byKey.get(`${nodeId}:${protocol}`) ?? UNKNOWN_USER_REACHABILITY;
  };

  listNodes = async (actor: Actor): Promise<unknown[]> => {
    const [rows, policyRow, userRow, checkRows, egressCheckRows] = await Promise.all([
      this.options.db
        .select({
          id: nodes.id,
          name: nodes.name,
          publicName: nodes.publicName,
          protocol: nodes.protocol,
          enabledProtocols: nodes.enabledProtocols,
          maxPeers: nodes.maxPeers,
          lastHealthAt: nodes.lastHealthAt,
          capabilities: nodes.capabilities,
          publicHost: nodes.publicHost,
          publicIp: nodes.publicIp,
          egressMode: nodes.egressMode,
          egressDefaultIpId: nodes.egressDefaultIpId,
          checksEnabled: nodes.checksEnabled,
          disabledCheckIds: nodes.disabledCheckIds,
          activeBridgeRouteId: vpnBridgeRoutes.id,
        })
        .from(nodes)
        .leftJoin(vpnBridgeRoutes, and(
          eq(vpnBridgeRoutes.nodeId, nodes.id),
          eq(vpnBridgeRoutes.state, "active"),
        ))
        .where(eq(nodes.enabled, true)),
      this.options.db.select().from(portalPolicy).limit(1),
      this.options.db
        .select({ policyOverride: users.policyOverride })
        .from(users)
        .where(eq(users.id, actor.id))
        .limit(1),
      // Enabled checks joined to each node's verdict. Read unconditionally and
      // discarded below when the policy says no: the alternative is a second
      // round trip inside a branch, for a table with single-digit rows.
      this.options.db
        .select({
          nodeId: nodeServiceCheckResults.nodeId,
          checkId: nodeServiceChecks.id,
          name: nodeServiceChecks.name,
          status: nodeServiceCheckResults.status,
          checkedAt: nodeServiceCheckResults.checkedAt,
          intervalSec: nodeServiceChecks.intervalSec,
        })
        .from(nodeServiceCheckResults)
        .innerJoin(
          nodeServiceChecks,
          eq(nodeServiceChecks.id, nodeServiceCheckResults.checkId),
        )
        .where(eq(nodeServiceChecks.enabled, true))
        .orderBy(nodeServiceChecks.name),
      // Per-egress-IP verdicts for routed nodes. Read in the same batch and
      // discarded below when showNodeStatus is off.
      this.options.db
        .select({
          egressIpId: nodeEgressServiceCheckResults.egressIpId,
          checkId: nodeServiceChecks.id,
          name: nodeServiceChecks.name,
          status: nodeEgressServiceCheckResults.status,
          checkedAt: nodeEgressServiceCheckResults.checkedAt,
          intervalSec: nodeServiceChecks.intervalSec,
        })
        .from(nodeEgressServiceCheckResults)
        .innerJoin(
          nodeServiceChecks,
          eq(nodeServiceChecks.id, nodeEgressServiceCheckResults.checkId),
        )
        .innerJoin(
          nodeEgressIps,
          eq(nodeEgressIps.id, nodeEgressServiceCheckResults.egressIpId),
        )
        .innerJoin(nodes, eq(nodes.id, nodeEgressIps.nodeId))
        .where(
          and(
            eq(nodeServiceChecks.enabled, true),
            eq(nodeEgressIps.enabled, true),
            eq(nodes.egressMode, "routed"),
          ),
        )
        .orderBy(nodeServiceChecks.name),
    ]);
    const policy = resolvePortalPolicy(
      toPolicy(policyRow[0]),
      userRow[0]?.policyOverride,
    );
    // Both come straight from the policy ROW, never from the resolved policy:
    // they are global-only, so a per-user override can neither recommend a node
    // nor reorder the list for one account. The two are used for two different
    // things and never mixed: `nodeOrder` decides the position, `recommended`
    // only paints a badge.
    const recommended = new Set(policyRow[0]?.recommendedNodeIds ?? []);
    // Three words and a name, and nothing else. No URL, no detail, no HTTP
    // status: a user is told whether a service works from a server, not how the
    // panel found out. `error` collapses to "unknown" rather than to
    // "unavailable" - the node could not look, so nothing is known about the
    // service, and saying "blocked" there would be a claim we cannot support.
    // Stale is unknown too: a stale green light is worse than no light.
    const checksNow = new Date();
    const checksByNode = new Map<
      string,
      Array<{ checkId: string; name: string; state: ServiceCheckUserState }>
    >();
    const checksByEgressIp = new Map<
      string,
      Array<{ checkId: string; name: string; state: ServiceCheckUserState }>
    >();
    if (policy.showNodeStatus) {
      for (const row of checkRows) {
        const list = checksByNode.get(row.nodeId) ?? [];
        list.push({
          checkId: row.checkId,
          name: row.name,
          state: toUserCheckState({
            status: row.status,
            checkedAt: row.checkedAt,
            now: checksNow,
            // Three times the CHECK'S OWN period, so a check an admin set to
            // five minutes goes stale after fifteen, not after thirty-six hours.
            staleAfterSec: row.intervalSec * 3,
          }),
        });
        checksByNode.set(row.nodeId, list);
      }
      for (const row of egressCheckRows) {
        const list = checksByEgressIp.get(row.egressIpId) ?? [];
        list.push({
          checkId: row.checkId,
          name: row.name,
          state: toUserCheckState({
            status: row.status,
            checkedAt: row.checkedAt,
            now: checksNow,
            staleAfterSec: row.intervalSec * 3,
          }),
        });
        checksByEgressIp.set(row.egressIpId, list);
      }
    }
    const nodeOrder = policyRow[0]?.nodeOrder ?? [];
    const endpointOrder = policyRow[0]?.endpointOrder ?? [];
    const recommendedEndpointIds = new Set(policyRow[0]?.recommendedEndpointIds ?? []);
    const endpointRank = new Map<string, number>();
    endpointOrder.forEach((id, index) => {
      if (!endpointRank.has(id)) endpointRank.set(id, index);
    });
    const allowedEndpoints =
      policy.allowedEndpointIds !== null && policy.allowedEndpointIds !== undefined
        ? new Set(policy.allowedEndpointIds)
        : null;
    // A null/absent allowedNodeIds means "all nodes"; a list restricts to it.
    // The SELECT above has no ORDER BY and the worker rewrites node rows on
    // every telemetry poll, so the order is fixed here, on the name the user
    // sees — after the availability filter, never before it.
    const available = rows.filter((row) => isNodeAvailable(policy.allowedNodeIds, row.id));
    // Behind the same flag as the service checks: both tell a user whether a
    // server works for them right now.
    const availableIds = available.map((row) => row.id);
    const [reachability, pathReachability, publicEndpoints] = await Promise.all([
      policy.showNodeStatus ? this.loadUserReachability(availableIds) : null,
      policy.showNodeStatus ? this.loadKeyReachability(availableIds) : null,
      this.loadNodePublicEndpoints(availableIds),
    ]);
    const userNodes = available.flatMap(
      ({
        capabilities,
        enabledProtocols,
        publicName,
        publicHost,
        publicIp,
        egressMode,
        egressDefaultIpId,
        checksEnabled,
        disabledCheckIds,
        activeBridgeRouteId,
        ...row
      }) => {
        const pickChecks = (
          items: Array<{ checkId: string; name: string; state: ServiceCheckUserState }>,
        ) =>
          items
            .filter((chip) =>
              nodeRunsCheck(
                { checksEnabled, disabledCheckIds },
                chip.checkId,
              ),
            )
            .map(({ name, state }) => ({ name, state }));
        const nodeChecks = policy.showNodeStatus
          ? pickChecks(checksByNode.get(row.id) ?? [])
          : [];
        const supportedProtocols = deriveSupportedProtocols(
          row.protocol,
          capabilities,
        );
        const selectableProtocols = computeSelectableProtocols(
          supportedProtocols, enabledProtocols, policy.allowedProtocols,
        );
        // One address, and only behind the policy flag: the resolved IPv4 when
        // the panel has one, else the host the node reported. The host/IP pair
        // and the resolution timestamp are operator diagnostics and stay on the
        // admin side, so publicHost/publicIp are destructured OUT of `...row`
        // above — leaving them in would hand every user the raw pair
        // regardless of the flag.
        const publicAddress = policy.showNodeAddress
          ? (publicIp ?? publicHost)
          : null;
        const allEndpoints = publicEndpoints.get(row.id) ?? [];
        const visibleEndpoints = allEndpoints
          .map((endpoint) => {
            const endpointSelectableProtocols =
              endpoint.enabledProtocols && endpoint.enabledProtocols.length > 0
                ? selectableProtocols.filter((proto) =>
                    endpoint.enabledProtocols!.includes(proto),
                  )
                : selectableProtocols;
            return { endpoint, endpointSelectableProtocols };
          })
          .filter(
            ({ endpoint, endpointSelectableProtocols }) =>
              endpoint.enabled &&
              (allowedEndpoints === null || allowedEndpoints.has(endpoint.id)) &&
              endpointSelectableProtocols.length > 0,
          )
          .sort((a, b) => {
            const ra = endpointRank.get(a.endpoint.id) ?? Number.MAX_SAFE_INTEGER;
            const rb = endpointRank.get(b.endpoint.id) ?? Number.MAX_SAFE_INTEGER;
            return ra - rb || a.endpoint.ordinal - b.endpoint.ordinal;
          });
        // If this node defines public endpoints and none are enabled & allowed
        // for this user, hide the node unless the node itself was explicitly
        // allowed via fallback node ID when it has no endpoints.
        if (
          (allEndpoints.length === 0 &&
            allowedEndpoints !== null &&
            !allowedEndpoints.has(row.id)) ||
          (selectableProtocols.includes("awg3") &&
            allEndpoints.length > 0 &&
            visibleEndpoints.length === 0)
        ) {
          return [];
        }
        const globalUseBridge = policyRow[0]?.useBridge ?? false;
        const hasActiveBridge = activeBridgeRouteId !== null;
        const endpoints = visibleEndpoints.map(
          ({
            endpoint: {
              id,
              ordinal,
              name,
              publicAddress,
              bridgeMode,
              egressIpId,
              reachability: endpointReachability,
            },
            endpointSelectableProtocols,
          }) => {
            const usesBridgeForUser =
              hasActiveBridge &&
              (bridgeMode === "bridge" || (bridgeMode === "inherit" && policy.useBridge));
            const usesBridgeGlobally =
              hasActiveBridge &&
              (bridgeMode === "bridge" || (bridgeMode === "inherit" && globalUseBridge));
            // The address was measured on the route the portal default gives
            // it. A user on that route reads the address's verdict; one sent
            // through the bridge where it was measured direct reads the
            // node's bridge path row; one sent direct where only the bridge
            // was measured reads unknown.
            const storedReachability = endpointReachability ?? UNKNOWN_USER_REACHABILITY;
            const effectiveReachability = usesBridgeForUser
              ? usesBridgeGlobally
                ? storedReachability
                : pathReachability?.(row.id, "awg3") ?? UNKNOWN_USER_REACHABILITY
              : usesBridgeGlobally
                ? UNKNOWN_USER_REACHABILITY
                : storedReachability;
            const effectiveEgressIpId =
              egressMode === "routed" ? (egressIpId ?? egressDefaultIpId ?? null) : null;
            const endpointChecks = policy.showNodeStatus
              ? effectiveEgressIpId !== null
                ? pickChecks(checksByEgressIp.get(effectiveEgressIpId) ?? [])
                : nodeChecks
              : undefined;
            return {
              id,
              ordinal,
              name,
              ...(policy.showNodeAddress ? { publicAddress } : {}),
              selectableProtocols: endpointSelectableProtocols,
              ...(recommendedEndpointIds.size > 0
                ? { recommended: recommendedEndpointIds.has(id) }
                : recommended.has(row.id)
                  ? { recommended: true }
                  : {}),
              ...(policy.showNodeStatus ? { reachability: effectiveReachability } : {}),
              ...(endpointChecks !== undefined ? { status: { checks: endpointChecks } } : {}),
            };
          },
        );
        const nodeRecommended =
          recommendedEndpointIds.size > 0
            ? endpoints.some((endpoint) => endpoint.recommended) ||
              recommendedEndpointIds.has(row.id)
            : recommended.has(row.id);
        return [
          {
            ...row,
            // Users see the public name; the internal admin name never leaves here.
            name: endpoints[0]?.name ?? publicName ?? row.name,
            ...(selectableProtocols.includes("awg3") && endpoints.length > 0
              ? { publicEndpoints: endpoints } : {}),
            recommended: nodeRecommended,
            // Spread conditionally rather than assigning `undefined`: there is no
            // "unknown address" state on the user side, so the key must be truly
            // absent — a user cannot fix a node's DNS, and a null would only
            // invite the UI to render an empty line.
            ...(publicAddress === null ? {} : { publicAddress }),
            supportedProtocols,
            selectableProtocols,
            // The external probe's verdict, as three words and a time
            // (`toUserReachability`). It is the one node state word a user
            // gets, and it is deliberately not the panel's own health view
            // (enabled/lastError/lastHealthAt): it answers "does the VPN
            // work from outside", which a healthy node can fail.
            ...(reachability
              ? { reachability: reachability.get(row.id) ?? UNKNOWN_USER_REACHABILITY }
              : {}),
            // Only checks this node actually runs. A chip for one it has
            // been taken out of would show a user a verdict that will never
            // change again - worse than showing nothing, because it looks
            // live. Destructured above so the two flags cannot leak into the
            // user payload with the rest of the row.
            ...(policy.showNodeStatus
              ? {
                  status: {
                    checks: nodeChecks,
                  },
                }
              : {}),
          },
        ];
      },
    );
    const derivedNodeOrder =
      endpointOrder.length > 0
        ? [
            ...new Set([
              ...endpointOrder
                .map((id) => {
                  const owner = userNodes.find(
                    (node) =>
                      node.id === id ||
                      node.publicEndpoints?.some((ep) => ep.id === id),
                  );
                  return owner?.id;
                })
                .filter((id): id is string => Boolean(id)),
              ...nodeOrder,
            ]),
          ]
        : nodeOrder;
    return orderNodesForUsers(userNodes, derivedNodeOrder);
  };

  createUser = async (
    actor: Actor,
    request: CreateUserRequest,
  ): Promise<unknown> => {
    const email = normalizeEmail(request.email);
    if (email === SERVICE_ACCOUNT_EMAIL) {
      throw new ApiError(409, "This address is reserved by the panel", "SERVICE_ACCOUNT");
    }
    return this.options.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing[0]) {
        throw new ApiError(409, "User already exists", "USER_EXISTS");
      }
      const [created] = await tx
        .insert(users)
        .values({
          email,
          displayName: request.displayName ?? null,
          role: request.role,
        })
        .returning();
      if (!created) throw new Error("User insert returned no row");
      // A new user is a new candidate for the Cloudflare Access allowlist.
      await this.armAccessSync(tx, "user-change");
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.users.create",
        targetType: "user",
        targetId: created.id,
        metadata: { email, role: request.role },
      });
      return created;
    });
  };

  createNode = async (
    actor: Actor,
    request: CreateNodeRequest,
  ): Promise<unknown> => {
    if ((request.awgGenerator != null || request.awgMtu != null) &&
      !deriveSupportedProtocols(request.protocol, request.capabilities).includes("awg3")) {
      throw new ApiError(409, "Generator settings require AWG 3.1", "AWG_GENERATOR_UNSUPPORTED");
    }
    const credentials = encryptSecret(
      request.apiKey,
      this.options.keyring,
      this.activeKeyVersion,
    );
    const labelSecret = encryptSecret(
      randomBytes(32).toString("base64"),
      this.options.keyring,
      this.activeKeyVersion,
    );
    try {
      return await this.options.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(nodes)
          .values({
            name: request.name,
            publicName: request.publicName || null,
            apiBaseUrl: request.apiBaseUrl.replace(/\/$/, ""),
            enabled: request.enabled,
            protocol: request.protocol,
            enabledProtocols: request.enabledProtocols ?? null,
            maxPeers: request.maxPeers,
            awgGenerator: request.awgGenerator ?? null,
            awgMtu: request.awgMtu ?? null,
            capabilities: request.capabilities,
            credentialsCiphertext: credentials.ciphertext,
            credentialsNonce: credentials.nonce,
            credentialsAuthTag: credentials.authTag,
            credentialsKeyVersion: credentials.keyVersion,
            labelSecretCiphertext: labelSecret.ciphertext,
            labelSecretNonce: labelSecret.nonce,
            labelSecretAuthTag: labelSecret.authTag,
            labelSecretKeyVersion: labelSecret.keyVersion,
          })
          .returning({
            id: nodes.id,
            name: nodes.name,
            publicName: nodes.publicName,
            apiBaseUrl: nodes.apiBaseUrl,
            enabled: nodes.enabled,
            protocol: nodes.protocol,
            maxPeers: nodes.maxPeers,
            capabilities: nodes.capabilities,
            createdAt: nodes.createdAt,
          });
        if (!created) throw new Error("Node insert returned no row");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "node.created",
          targetType: "node",
          targetId: created.id,
          metadata: { name: created.name, protocol: created.protocol },
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, "nodes_name_unique")) {
        throw new ApiError(409, "Node name already exists", "NODE_EXISTS");
      }
      throw error;
    }
  };

  updateNode = async (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeRequest,
  ): Promise<unknown> => {
    const { vpnBridgeRouteId, expectedVpnEndpointRevision, publicEndpoint, ...nodeFields } = request;
    // Route assignment fields alone (or only the revision, which the contract
    // lets through without a route id) are not a node-settings edit: no
    // `node.updated` row and no `updatedAt` bump for them. A PATCH with no
    // route fields takes exactly the path it always did.
    const editsNode =
      Object.keys(nodeFields).length > 0 ||
      (vpnBridgeRouteId === undefined && expectedVpnEndpointRevision === undefined && publicEndpoint === undefined);
    // Set inside the transaction when the edit changes what the probe
    // measures on this node; the run is queued only once the edit commits.
    let remeasure = false;
    const result = await this.options.db.transaction(async (tx) => {
      // NO KEY UPDATE serializes node edits and route changes on this node
      // without blocking foreign-key inserts that reference it; see the lock
      // note in bridgeRepository.ts.
      const [current] = await tx
        .select({
          id: nodes.id, protocol: nodes.protocol, capabilities: nodes.capabilities,
          awgGenerator: nodes.awgGenerator, awgMtu: nodes.awgMtu, reachabilityEnabled: nodes.reachabilityEnabled,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!current) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      const checked = request.reachabilityEnabled ?? current.reachabilityEnabled;
      const configuresGenerator = request.awgGenerator != null || request.awgMtu != null ||
        (publicEndpoint?.action === "update" && (publicEndpoint.awgGenerator != null ||
          publicEndpoint.awgMtu != null || publicEndpoint.awgDeviceRules != null));
      if (configuresGenerator && !deriveSupportedProtocols(
        request.protocol ?? current.protocol,
        request.capabilities ?? current.capabilities,
      ).includes("awg3")) {
        throw new ApiError(409, "Generator settings require AWG 3.1", "AWG_GENERATOR_UNSUPPORTED");
      }

      const updated = editsNode
        ? await this.updateNodeSettings(tx, actor, nodeId, nodeFields)
        : undefined;
      const endpointChange = publicEndpoint
        ? await this.changeNodePublicEndpoint(tx, actor, nodeId, publicEndpoint, {
            before: current.awgGenerator,
            after: request.awgGenerator === undefined ? current.awgGenerator : request.awgGenerator,
          })
        : undefined;
      const changedEndpoint = endpointChange?.endpoint;
      const removedEndpoint = endpointChange?.removed;
      const generatorChanged = request.awgGenerator !== undefined &&
        !isDeepStrictEqual(current.awgGenerator, request.awgGenerator);
      const mtuChanged = request.awgMtu !== undefined && current.awgMtu !== (request.awgMtu ?? null);
      remeasure = checked && (
        generatorChanged || mtuChanged ||
        endpointChange?.remeasure === true ||
        (request.reachabilityEnabled === true && !current.reachabilityEnabled)
      );
      if (generatorChanged || mtuChanged) {
        // The addresses that inherit what changed are measured anew.
        const inherited = await tx.select({ id: nodeVpnEndpoints.id }).from(nodeVpnEndpoints)
          .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), or(
            generatorChanged ? isNull(nodeVpnEndpoints.awgGenerator) : undefined,
            mtuChanged ? isNull(nodeVpnEndpoints.awgMtu) : undefined,
          )));
        await resetNodeEndpointEvidence(tx, nodeId, new Date(), {
          endpointIds: inherited.map((endpoint) => endpoint.id),
          detail: GENERATOR_CHANGED_DETAIL,
        });
      }
      if (vpnBridgeRouteId === undefined) {
        if (changedEndpoint) return { ...(updated ?? { id: nodeId }), publicEndpoint: changedEndpoint };
        if (removedEndpoint) return { ...(updated ?? { id: nodeId }), publicEndpointRemoved: removedEndpoint };
        if (updated) return updated;
        // Only `expectedVpnEndpointRevision`: nothing to change. Report the
        // current assignment so the caller sees what it would have compared.
        const routes = await this.bridges.getNodeBridgeRoutes(nodeId, tx);
        return {
          id: nodeId,
          vpnEndpoint: {
            changed: false,
            vpnEndpointRevision: routes.vpnEndpointRevision,
            activeRoute: routes.activeRoute,
          } satisfies NodeEndpointAssignment,
        };
      }
      // The contract requires the revision whenever a route id is present.
      const vpnEndpoint = await this.bridges.changeNodeEndpoint(
        tx,
        actor,
        nodeId,
        vpnBridgeRouteId,
        expectedVpnEndpointRevision ?? -1,
      );
      remeasure ||= checked && vpnEndpoint.changed;
      return {
        ...(updated ?? { id: nodeId }),
        vpnEndpoint,
        ...(changedEndpoint ? { publicEndpoint: changedEndpoint } : {}),
      };
    });
    if (remeasure) await this.queueReachabilityRun();
    return result;
  };

  /**
   * The portal's bridge default moves every enabled address that inherits it
   * onto or off its node's active bridge route. Like a bridge mode change,
   * the address gets a new revision, its old measurement goes and its
   * failure streak restarts; an open incident stays. Only nodes with an
   * active route are locked, in id order like the worker's ingest, before
   * the caller writes the policy row; a node deletion writes the policy
   * before it locks its node, but a node with a route cannot be deleted.
   */
  private resetInheritingAddressEvidence = async (tx: DbTransaction, now: Date): Promise<void> => {
    const routed = await tx
      .select({ nodeId: vpnBridgeRoutes.nodeId })
      .from(vpnBridgeRoutes)
      .where(eq(vpnBridgeRoutes.state, "active"));
    const nodeIds = [...new Set(routed.map((route) => route.nodeId))];
    if (nodeIds.length === 0) return;
    await tx.select({ id: nodes.id }).from(nodes)
      .where(inArray(nodes.id, nodeIds)).orderBy(asc(nodes.id)).for("no key update");
    const moved = await tx
      .update(nodeVpnEndpoints)
      .set({ revision: sql`${nodeVpnEndpoints.revision} + 1` })
      .where(and(
        inArray(nodeVpnEndpoints.nodeId, nodeIds),
        eq(nodeVpnEndpoints.enabled, true),
        eq(nodeVpnEndpoints.bridgeMode, "inherit"),
      ))
      .returning({ id: nodeVpnEndpoints.id, nodeId: nodeVpnEndpoints.nodeId });
    const byNode = new Map<string, string[]>();
    for (const { id, nodeId } of moved) byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), id]);
    for (const [nodeId, endpointIds] of byNode) {
      await resetNodeEndpointEvidence(tx, nodeId, now, { endpointIds });
    }
  };

  /** After a committed change to what the probe measures; see `requestReachabilityRun`. */
  private queueReachabilityRun = async (): Promise<void> => {
    if (!(await requestReachabilityRun(this.options.db))) {
      console.warn("[reachability] could not queue a probe run; the scheduled run measures the change");
    }
  };

  private validateEgressAutoRotatePool = async (
    tx: DbTransaction,
    nodeId: string,
    poolIds: readonly string[],
  ): Promise<string[]> => {
    const deduped = [...new Set(poolIds)];
    if (deduped.length === 0) return [];
    const existing = await tx
      .select({ id: nodeEgressIps.id })
      .from(nodeEgressIps)
      .where(and(eq(nodeEgressIps.nodeId, nodeId), inArray(nodeEgressIps.id, deduped)));
    const found = new Set(existing.map((item) => item.id));
    if (found.size !== deduped.length) {
      throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
    }
    return deduped;
  };

  private changeNodePublicEndpoint = async (
    tx: DbTransaction,
    actor: Actor,
    nodeId: string,
    request: NodePublicEndpointMutation,
    nodeGenerators: { before: AwgGeneratorSettings | null; after: AwgGeneratorSettings | null },
  ): Promise<{
    endpoint?: NodePublicEndpointMutationResult["publicEndpoint"];
    removed?: { id: string; address: string; reassignedToEndpointId: string; reassignedKeyCount: number };
    remeasure: boolean;
  }> => {
    let row: typeof nodeVpnEndpoints.$inferSelect | undefined;
    // A new address, or one whose measured config, path or presence changed.
    let remeasure = request.action === "add";
    if (request.action === "add") {
      const [node] = await tx.select({
        name: nodes.name,
        publicName: nodes.publicName,
        publicIp: nodes.publicIp,
        protocol: nodes.protocol,
        capabilities: nodes.capabilities,
      }).from(nodes).where(eq(nodes.id, nodeId));
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      const nodeSupportedProtocols = deriveSupportedProtocols(node.protocol, node.capabilities);
      if (!nodeSupportedProtocols.includes("awg3")) {
        throw new ApiError(409, "Additional addresses require AWG 3.1", "NODE_ENDPOINT_NOT_AWG3");
      }
      if (
        request.enabledProtocols !== undefined &&
        request.enabledProtocols !== null &&
        !request.enabledProtocols.some((p) => nodeSupportedProtocols.includes(p))
      ) {
        throw new ApiError(
          400,
          "Endpoint enabledProtocols must include at least one protocol supported by the node",
          "VALIDATION_ERROR",
        );
      }
      if (request.egressIpId) {
        const [egressIp] = await tx
          .select({ id: nodeEgressIps.id, enabled: nodeEgressIps.enabled })
          .from(nodeEgressIps)
          .where(and(eq(nodeEgressIps.id, request.egressIpId), eq(nodeEgressIps.nodeId, nodeId)))
          .limit(1);
        if (!egressIp) {
          throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
        }
        if (!egressIp.enabled) {
          throw new ApiError(409, "Exit IP is disabled", "EGRESS_IP_DISABLED");
        }
      }
      if (node.publicIp && isIpv4Literal(node.publicIp)) {
        const defaultEntryName = node.publicName || nodeEndpointDefaultName(node.name, 1);
        await tx.insert(nodeVpnEndpoints).values({
          nodeId,
          ordinal: 1,
          address: node.publicIp,
          entryName: defaultEntryName,
          variantOrdinal: 1,
          name: defaultEntryName,
        }).onConflictDoNothing();
      }
      const existing = await tx.select({
        id: nodeVpnEndpoints.id,
        address: nodeVpnEndpoints.address,
        ordinal: nodeVpnEndpoints.ordinal,
        variantOrdinal: nodeVpnEndpoints.variantOrdinal,
        entryName: nodeVpnEndpoints.entryName,
        egressIpId: nodeVpnEndpoints.egressIpId,
      }).from(nodeVpnEndpoints).where(eq(nodeVpnEndpoints.nodeId, nodeId))
        .orderBy(desc(nodeVpnEndpoints.ordinal));
      const targetEgressId = request.egressIpId ?? null;
      const autoRotatePoolIds =
        request.egressAutoRotatePoolIds !== undefined
          ? await this.validateEgressAutoRotatePool(tx, nodeId, request.egressAutoRotatePoolIds)
          : [];
      const autoRotateEnabled = request.egressAutoRotateEnabled ?? false;
      if (autoRotateEnabled && autoRotatePoolIds.length === 0) {
        throw new ApiError(
          400,
          "Select at least one Exit IP for the auto-rotation pool",
          "VALIDATION_ERROR",
        );
      }
      if (existing.some((endpoint) => endpoint.address === request.address && (endpoint.egressIpId ?? null) === targetEgressId)) {
        throw new ApiError(409, "This Entry and Exit IP combination already exists on this node", "NODE_ENDPOINT_EXISTS");
      }
      const sameAddress = existing.filter((endpoint) => endpoint.address === request.address);
      const ordinal = (existing[0]?.ordinal ?? 1) + 1;
      const variantOrdinal =
        sameAddress.reduce((max, ep) => Math.max(max, ep.variantOrdinal), 0) + 1;
      const entryName =
        request.entryName ??
        sameAddress[0]?.entryName ??
        request.name ??
        nodeEndpointDefaultName(node.publicName || node.name, ordinal);
      const customName =
        request.customName !== undefined
          ? (request.customName ?? null)
          : sameAddress.length > 0 && request.name && !request.entryName
            ? request.name
            : null;
      const provisionalName = computeEndpointDisplayName({
        entryName,
        customName,
        variantOrdinal,
        siblingCount: sameAddress.length + 1,
      });
      [row] = await tx.insert(nodeVpnEndpoints).values({
        nodeId,
        ordinal,
        address: request.address,
        entryName,
        customName,
        variantOrdinal,
        egressIpId: targetEgressId,
        egressAutoRotateEnabled: autoRotateEnabled,
        egressAutoRotatePoolIds: autoRotatePoolIds,
        enabledProtocols: request.enabledProtocols ?? null,
        name: provisionalName,
      }).returning();
      if (!row) throw new Error("Node address write returned no row");
      await this.recomputeEntryGroupNames(tx, nodeId, request.address);
      const [refreshed] = await tx
        .select()
        .from(nodeVpnEndpoints)
        .where(eq(nodeVpnEndpoints.id, row.id))
        .limit(1);
      if (refreshed) row = refreshed;
      await this.enqueueNodeSyncEgress(tx, nodeId);
    } else if (request.action === "remove") {
      const match = and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.id, request.id));
      const [current] = await tx.select().from(nodeVpnEndpoints).where(match);
      if (!current) throw new ApiError(404, "Address not found on this node", "NODE_ENDPOINT_NOT_FOUND");
      const allOnNode = await tx
        .select()
        .from(nodeVpnEndpoints)
        .where(eq(nodeVpnEndpoints.nodeId, nodeId))
        .orderBy(asc(nodeVpnEndpoints.ordinal));
      const remaining = allOnNode.filter((item) => item.id !== current.id);
      const remainingEnabled = remaining.filter((item) => item.enabled);
      if (remainingEnabled.length === 0) {
        throw new ApiError(
          409,
          "At least one enabled endpoint must remain on this node",
          "LAST_ENABLED_ENDPOINT_REQUIRED",
        );
      }
      let fallback = remainingEnabled.find((item) => item.id === request.reassignToEndpointId);
      if (request.reassignToEndpointId !== undefined && !fallback) {
        throw new ApiError(
          409,
          "Replacement endpoint must be enabled on this same node",
          "NODE_ENDPOINT_UNAVAILABLE",
        );
      }
      fallback ??=
        remainingEnabled.find((item) => item.address === current.address) ?? remainingEnabled[0]!;
      const reassigned = await tx
        .update(vpnKeys)
        .set({ endpointId: fallback.id, updatedAt: new Date() })
        .where(and(eq(vpnKeys.nodeId, nodeId), eq(vpnKeys.endpointId, current.id)))
        .returning({ id: vpnKeys.id });
      await this.scrubRemovedIdsFromPolicies(tx, new Set([current.id]));
      await tx.delete(nodeVpnEndpoints).where(eq(nodeVpnEndpoints.id, current.id));
      if (current.ordinal === 1 && fallback.ordinal !== 1) {
        await tx
          .update(nodeVpnEndpoints)
          .set({ ordinal: 1 })
          .where(eq(nodeVpnEndpoints.id, fallback.id));
      }
      await this.recomputeEntryGroupNames(tx, nodeId, current.address);
      await this.enqueueNodeSyncEgress(tx, nodeId);
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.endpoint_removed",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          endpointId: current.id,
          ordinal: current.ordinal,
          address: current.address,
          egressIpId: current.egressIpId,
          reassignedToEndpointId: fallback.id,
          reassignedKeyCount: reassigned.length,
        },
      });
      return {
        removed: {
          id: current.id,
          address: current.address,
          reassignedToEndpointId: fallback.id,
          reassignedKeyCount: reassigned.length,
        },
        remeasure: true,
      };
    } else {
      const match = and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.id, request.id));
      const [current] = await tx.select().from(nodeVpnEndpoints).where(match);
      if (!current) throw new ApiError(404, "Address not found on this node", "NODE_ENDPOINT_NOT_FOUND");
      if (request.enabledProtocols !== undefined && request.enabledProtocols !== null) {
        const [node] = await tx
          .select({ protocol: nodes.protocol, capabilities: nodes.capabilities })
          .from(nodes)
          .where(eq(nodes.id, nodeId));
        if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
        const nodeSupportedProtocols = deriveSupportedProtocols(node.protocol, node.capabilities);
        if (!request.enabledProtocols.some((p) => nodeSupportedProtocols.includes(p))) {
          throw new ApiError(
            400,
            "Endpoint enabledProtocols must include at least one protocol supported by the node",
            "VALIDATION_ERROR",
          );
        }
      }
      const siblingsOnAddress = await tx
        .select()
        .from(nodeVpnEndpoints)
        .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.address, current.address)));
      if (request.enabled === false && current.enabled) {
        const siblings = await tx
          .select({ id: nodeVpnEndpoints.id })
          .from(nodeVpnEndpoints)
          .where(
            and(
              eq(nodeVpnEndpoints.nodeId, nodeId),
              eq(nodeVpnEndpoints.enabled, true),
            ),
          );
        if (siblings.filter((item) => item.id !== current.id).length === 0) {
          throw new ApiError(
            409,
            "At least one public address must remain enabled on this node",
            "LAST_ENABLED_ENDPOINT_REQUIRED",
          );
        }
      }
      let nextEgressIpId = current.egressIpId;
      let changeEgressIp = false;
      if (request.egressIpId !== undefined && (request.egressIpId ?? null) !== (current.egressIpId ?? null)) {
        if (request.egressIpId) {
          const [egressIp] = await tx
            .select({ id: nodeEgressIps.id, enabled: nodeEgressIps.enabled })
            .from(nodeEgressIps)
            .where(and(eq(nodeEgressIps.id, request.egressIpId), eq(nodeEgressIps.nodeId, nodeId)))
            .limit(1);
          if (!egressIp) {
            throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
          }
          if (!egressIp.enabled) {
            throw new ApiError(409, "Exit IP is disabled", "EGRESS_IP_DISABLED");
          }
        }
        const targetEgress = request.egressIpId ?? null;
        if (siblingsOnAddress.some((ep) => ep.id !== current.id && (ep.egressIpId ?? null) === targetEgress)) {
          throw new ApiError(409, "This Entry and Exit IP combination already exists on this node", "NODE_ENDPOINT_EXISTS");
        }
        nextEgressIpId = targetEgress;
        changeEgressIp = true;
      }
      let nextEntryName = request.entryName ?? current.entryName;
      let nextCustomName =
        request.customName !== undefined ? (request.customName ?? null) : current.customName;
      if (request.name !== undefined && request.entryName === undefined && request.customName === undefined) {
        if (siblingsOnAddress.length <= 1) {
          nextEntryName = request.name;
          nextCustomName = null;
        } else {
          nextCustomName = request.name;
        }
      }
      if (request.renameEntryGroup && nextEntryName !== current.entryName) {
        await tx
          .update(nodeVpnEndpoints)
          .set({ entryName: nextEntryName })
          .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.address, current.address)));
      }
      const nextAutoRotatePoolIds =
        request.egressAutoRotatePoolIds !== undefined
          ? await this.validateEgressAutoRotatePool(tx, nodeId, request.egressAutoRotatePoolIds)
          : (current.egressAutoRotatePoolIds ?? []);
      const nextAutoRotateEnabled =
        request.egressAutoRotateEnabled ?? current.egressAutoRotateEnabled;
      if (nextAutoRotateEnabled && nextAutoRotatePoolIds.length === 0) {
        throw new ApiError(
          400,
          "Select at least one Exit IP for the auto-rotation pool",
          "VALIDATION_ERROR",
        );
      }
      const changeEnabled = request.enabled !== undefined && current.enabled !== request.enabled;
      const changeBridgeMode = request.bridgeMode !== undefined && current.bridgeMode !== request.bridgeMode;
      const changeReachability =
        request.reachabilityEnabled !== undefined &&
        current.reachabilityEnabled !== request.reachabilityEnabled;
      const nextGenerator = request.awgGenerator === undefined
        ? current.awgGenerator : request.awgGenerator;
      const generatorChanged = !isDeepStrictEqual(
        current.awgGenerator ?? nodeGenerators.before,
        nextGenerator ?? nodeGenerators.after,
      );
      const mtuChanged = request.awgMtu !== undefined && current.awgMtu !== (request.awgMtu ?? null);
      const resetEvidence = changeEnabled || changeBridgeMode || changeEgressIp || generatorChanged || mtuChanged ||
        (changeReachability && request.reachabilityEnabled === false);
      const nextName = computeEndpointDisplayName({
        entryName: nextEntryName,
        customName: nextCustomName,
        variantOrdinal: current.variantOrdinal,
        siblingCount: siblingsOnAddress.length,
      });
      [row] = await tx.update(nodeVpnEndpoints).set({
        name: nextName,
        entryName: nextEntryName,
        customName: nextCustomName,
        ...(changeEgressIp ? { egressIpId: nextEgressIpId } : {}),
        ...(request.egressAutoRotateEnabled !== undefined
          ? { egressAutoRotateEnabled: request.egressAutoRotateEnabled }
          : {}),
        ...(request.egressAutoRotatePoolIds !== undefined
          ? { egressAutoRotatePoolIds: nextAutoRotatePoolIds }
          : {}),
        bridgeMode: request.bridgeMode ?? current.bridgeMode,
        ...(request.enabledProtocols !== undefined
          ? { enabledProtocols: request.enabledProtocols ?? null }
          : {}),
        ...(request.awgGenerator !== undefined ? { awgGenerator: request.awgGenerator } : {}),
        ...(request.awgMtu !== undefined ? { awgMtu: request.awgMtu } : {}),
        // Device-type rules change only exports: the probe measures the
        // address's ordinary config, so nothing is reset for them.
        ...(request.awgDeviceRules !== undefined ? { awgDeviceRules: request.awgDeviceRules } : {}),
        ...(changeEnabled ? { enabled: request.enabled } : {}),
        ...(changeEnabled || changeBridgeMode || changeEgressIp || generatorChanged || mtuChanged ? { revision: current.revision + 1 } : {}),
        ...(changeReachability ? { reachabilityEnabled: request.reachabilityEnabled } : {}),
        // The old measurement goes and the failure streak restarts. An open
        // incident stays open across a profile or path change, so it ends
        // with one recovery message; taking the address out of service
        // (disabled, or its checks off) closes it without a message.
        ...(resetEvidence ? {
          probeStatus: null,
          probeLevels: null,
          probeCheckedAt: null,
          probeConsecutiveFailures: 0,
          probeFailingSince: null,
          probeDetail: null,
          probeObservedEgressIp: null,
          probeEgressMatch: null,
          ...(changeEnabled || (changeReachability && request.reachabilityEnabled === false)
            ? { probeAlertedAt: null, probeAlertKind: null }
            : {}),
        } : {}),
      }).where(match).returning();
      if (!row) throw new Error("Node address write returned no row");
      if (request.renameEntryGroup || request.entryName !== undefined) {
        await this.recomputeEntryGroupNames(tx, nodeId, current.address);
        const [refreshed] = await tx
          .select()
          .from(nodeVpnEndpoints)
          .where(eq(nodeVpnEndpoints.id, row.id))
          .limit(1);
        if (refreshed) row = refreshed;
      }
      if (generatorChanged || mtuChanged || changeBridgeMode || changeEgressIp) {
        await resetNodeEndpointEvidence(tx, nodeId, new Date(), {
          endpointIds: [current.id],
          detail: generatorChanged || mtuChanged ? GENERATOR_CHANGED_DETAIL : undefined,
        });
      }
      if (changeEgressIp || changeEnabled) {
        await this.enqueueNodeSyncEgress(tx, nodeId);
      }
      // A disabled address is not measured, so only enabling or disabling it
      // changes the targets; its other settings take effect once enabled.
      const enabled = request.enabled ?? current.enabled;
      remeasure = (changeEnabled || (enabled && (changeBridgeMode || changeEgressIp || generatorChanged || mtuChanged ||
        (changeReachability && request.reachabilityEnabled === true)))) &&
        (request.reachabilityEnabled ?? current.reachabilityEnabled);
    }
    if (!row) throw new Error("Node address write returned no row");
    await tx.insert(auditEvents).values({
      actorUserId: actor.id,
      actorType: "user",
      action: request.action === "add" ? "node.endpoint_added" : "node.endpoint_updated",
      targetType: "node",
      targetId: nodeId,
      metadata: {
        endpointId: row.id,
        ordinal: row.ordinal,
        variantOrdinal: row.variantOrdinal,
        egressIpId: row.egressIpId,
        enabled: row.enabled,
        reachabilityEnabled: row.reachabilityEnabled,
        bridgeMode: row.bridgeMode,
        generatorChanged: request.action === "update" && request.awgGenerator !== undefined,
        awgMtu: row.awgMtu,
        enabledProtocols: row.enabledProtocols ?? null,
        egressAutoRotateEnabled: row.egressAutoRotateEnabled,
        egressAutoRotatePoolCount: (row.egressAutoRotatePoolIds ?? []).length,
        ...(request.action === "update" && request.awgDeviceRules !== undefined
          ? { deviceRules: Object.keys(row.awgDeviceRules ?? {}) }
          : {}),
      },
    });
    return {
      endpoint: {
        id: row.id,
        ordinal: row.ordinal,
        name: row.name,
        publicAddress: row.address,
        enabled: row.enabled,
        reachabilityEnabled: row.reachabilityEnabled,
        bridgeMode: row.bridgeMode,
        egressAutoRotateEnabled: row.egressAutoRotateEnabled,
        egressAutoRotatePoolIds: row.egressAutoRotatePoolIds ?? [],
        egressAutoRotatedAt: row.egressAutoRotatedAt?.toISOString() ?? null,
        enabledProtocols: row.enabledProtocols ?? null,
        awgGenerator: row.awgGenerator,
        awgMtu: row.awgMtu,
        awgDeviceRules: row.awgDeviceRules,
      },
      remeasure,
    };
  };

  /** The node-settings part of a node PATCH, inside its transaction. */
  private updateNodeSettings = async (
    tx: DbTransaction,
    actor: Actor,
    nodeId: string,
    request: Omit<UpdateNodeRequest, "vpnBridgeRouteId" | "expectedVpnEndpointRevision">,
  ) => {
    let previousDefaultIpId: string | null = null;
    if (request.egressDefaultIpId !== undefined) {
      const [existingNode] = await tx
        .select({ egressDefaultIpId: nodes.egressDefaultIpId })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      previousDefaultIpId = existingNode?.egressDefaultIpId ?? null;
    }
    const changes: Partial<typeof nodes.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (request.name !== undefined) changes.name = request.name;
    // Empty string clears the public name (users fall back to the admin name).
    if (request.publicName !== undefined) {
      changes.publicName = request.publicName || null;
    }
    if (request.apiBaseUrl !== undefined) {
      changes.apiBaseUrl = request.apiBaseUrl.replace(/\/$/, "");
    }
    if (request.enabled !== undefined) changes.enabled = request.enabled;
    if (request.protocol !== undefined) changes.protocol = request.protocol;
    if (request.enabledProtocols !== undefined) {
      changes.enabledProtocols = request.enabledProtocols ?? null;
    }
    if (request.maxPeers !== undefined) changes.maxPeers = request.maxPeers;
    if (request.awgGenerator !== undefined) changes.awgGenerator = request.awgGenerator;
    if (request.awgMtu !== undefined) changes.awgMtu = request.awgMtu;
    // Which service checks this node runs. Missed when the fields were added
    // to the contract: the patch is built field by field here, so a field the
    // schema accepts and this block does not know is silently dropped - the
    // API answers 200 for a change that never happened, and the CLI says
    // "updated". A silent no-op is worse than a rejection.
    if (request.checksEnabled !== undefined) {
      changes.checksEnabled = request.checksEnabled;
    }
    if (request.disabledCheckIds !== undefined) {
      changes.disabledCheckIds = request.disabledCheckIds;
    }
    if (request.reachabilityEnabled !== undefined) {
      changes.reachabilityEnabled = request.reachabilityEnabled;
    }
    if (request.egressBlockSmtp !== undefined) {
      changes.egressBlockSmtp = request.egressBlockSmtp;
    }
    if (request.egressIsolatePrivate !== undefined) {
      changes.egressIsolatePrivate = request.egressIsolatePrivate;
    }
    if (request.egressDefaultIpId !== undefined) {
      if (request.egressDefaultIpId !== null) {
        const [egressIp] = await tx
          .select({ id: nodeEgressIps.id, enabled: nodeEgressIps.enabled })
          .from(nodeEgressIps)
          .where(and(eq(nodeEgressIps.id, request.egressDefaultIpId), eq(nodeEgressIps.nodeId, nodeId)))
          .limit(1);
        if (!egressIp) {
          throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
        }
        if (!egressIp.enabled) {
          throw new ApiError(409, "Exit IP is disabled", "EGRESS_IP_DISABLED");
        }
      }
      changes.egressDefaultIpId = request.egressDefaultIpId;
    }
    if (request.capabilities !== undefined) {
      changes.capabilities = request.capabilities;
    }
    if (request.apiKey !== undefined) {
      const credentials = encryptSecret(
        request.apiKey,
        this.options.keyring,
        this.activeKeyVersion,
      );
      changes.credentialsCiphertext = credentials.ciphertext;
      changes.credentialsNonce = credentials.nonce;
      changes.credentialsAuthTag = credentials.authTag;
      changes.credentialsKeyVersion = credentials.keyVersion;
    }
    if (request.publicIp === null) {
      // Both together, always: `public_ip_resolved_at` answers "when did the
      // panel learn this address", so leaving a timestamp behind for an
      // address that is gone would be a stamp on nothing. The worker resolves
      // again on the next tick, because it looks up exactly when it holds no
      // IP for the node.
      changes.publicIp = null;
      changes.publicIpResolvedAt = null;
    }

    const [updated] = await tx
      .update(nodes)
      .set(changes)
      .where(eq(nodes.id, nodeId))
      .returning({
        id: nodes.id,
        name: nodes.name,
        publicName: nodes.publicName,
        apiBaseUrl: nodes.apiBaseUrl,
        enabled: nodes.enabled,
        protocol: nodes.protocol,
        maxPeers: nodes.maxPeers,
        capabilities: nodes.capabilities,
        checksEnabled: nodes.checksEnabled,
        awgGenerator: nodes.awgGenerator,
        awgMtu: nodes.awgMtu,
        disabledCheckIds: nodes.disabledCheckIds,
        reachabilityEnabled: nodes.reachabilityEnabled,
        egressBlockSmtp: nodes.egressBlockSmtp,
        egressIsolatePrivate: nodes.egressIsolatePrivate,
        egressDefaultIpId: nodes.egressDefaultIpId,
        updatedAt: nodes.updatedAt,
      });
    // Older clients edit the node's public name. Treat it as a rename of
    // the primary address once that address has its own record.
    if (updated && request.publicName !== undefined) {
      const [primary] = await tx
        .select({ address: nodeVpnEndpoints.address })
        .from(nodeVpnEndpoints)
        .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.ordinal, 1)))
        .limit(1);
      if (primary) {
        const nextEntry = request.publicName || nodeEndpointDefaultName(updated.name, 1);
        await tx
          .update(nodeVpnEndpoints)
          .set({ entryName: nextEntry })
          .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.address, primary.address)));
        await this.recomputeEntryGroupNames(tx, nodeId, primary.address);
      }
    }
    if (
      request.egressBlockSmtp !== undefined ||
      request.egressIsolatePrivate !== undefined ||
      request.egressDefaultIpId !== undefined
    ) {
      await this.enqueueNodeSyncEgress(tx, nodeId);
    }
    if (
      request.egressDefaultIpId !== undefined &&
      request.egressDefaultIpId !== previousDefaultIpId
    ) {
      await tx
        .update(nodeVpnEndpoints)
        .set({
          probeObservedEgressIp: null,
          probeEgressMatch: null,
          probeStatus: null,
          probeLevels: null,
          probeCheckedAt: null,
          probeConsecutiveFailures: 0,
          probeFailingSince: null,
          probeDetail: null,
          probeAlertedAt: null,
          probeAlertKind: null,
          revision: sql`${nodeVpnEndpoints.revision} + 1`,
        })
        .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), isNull(nodeVpnEndpoints.egressIpId)));
    }
    if (request.reachabilityEnabled === false) {
      // Checks off for the whole node: its addresses' incidents close
      // without a message.
      await tx.update(nodeVpnEndpoints)
        .set({
          probeStatus: null,
          probeCheckedAt: null,
          probeDetail: null,
          probeConsecutiveFailures: 0,
          probeFailingSince: null,
          probeAlertedAt: null,
          probeAlertKind: null,
        })
        .where(eq(nodeVpnEndpoints.nodeId, nodeId));
    }
    await tx.insert(auditEvents).values({
      actorUserId: actor.id,
      actorType: "user",
      action: "node.updated",
      targetType: "node",
      targetId: nodeId,
      metadata: { fields: Object.keys(request) },
    });
    return updated;
  };

  setNodeIpv6RejectStub = async (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeIpv6RejectStubRequest,
  ): Promise<unknown> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({
          id: nodes.id,
          protocol: nodes.protocol,
          capabilities: nodes.capabilities,
          ipv6RejectStubEnabled: nodes.ipv6RejectStubEnabled,
          ipv6RejectStubPrefix: nodes.ipv6RejectStubPrefix,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      const supported = deriveSupportedProtocols(
        node.protocol,
        node.capabilities,
      );
      if (request.enabled && !supported.includes("awg3")) {
        throw new ApiError(
          409,
          "IPv6 active-reject stub requires AmneziaWG 3.1 on this node",
          "IPV6_REJECT_STUB_UNSUPPORTED",
        );
      }
      const nextPrefix = request.prefix ?? node.ipv6RejectStubPrefix;
      const now = new Date();
      await tx
        .update(nodes)
        .set({
          ipv6RejectStubEnabled: request.enabled,
          ipv6RejectStubPrefix: nextPrefix,
          ipv6RejectStubState: "pending",
          ipv6RejectStubReason: null,
          updatedAt: now,
        })
        .where(eq(nodes.id, nodeId));
      await tx.insert(jobOutbox).values({
        type: NODE_IPV6_REJECT_STUB_JOB_TYPE,
        deduplicationKey: `${NODE_IPV6_REJECT_STUB_JOB_TYPE}:${nodeId}:${randomUUID()}`,
        payload: { nodeId, enabled: request.enabled, prefix: nextPrefix },
      });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.nodes.set-ipv6-reject-stub",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          enabled: request.enabled,
          previousEnabled: node.ipv6RejectStubEnabled,
          prefix: nextPrefix,
          previousPrefix: node.ipv6RejectStubPrefix,
        },
        createdAt: now,
      });
      return {
        id: nodeId,
        enabled: request.enabled,
        prefix: nextPrefix,
        state: "pending" as const,
        queued: true,
      };
    });

  deleteNode = async (
    actor: Actor,
    nodeId: string,
    options: DeleteNodeOptions = { deleteKeys: false },
  ): Promise<unknown> => {
    try {
      return await this.deleteNodeInTransaction(actor, nodeId, options);
    } catch (error) {
      // A route inserted after the check below is caught by the RESTRICT
      // foreign key; report it with the same code.
      throw mapBridgeConstraintError(error);
    }
  };

  private deleteNodeInTransaction = async (
    actor: Actor,
    nodeId: string,
    options: DeleteNodeOptions,
  ): Promise<unknown> =>
    this.options.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: nodes.id, name: nodes.name })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (!existing) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");

      // Bridge routes first, before anything below touches keys or jobs:
      // `deleteKeys` does not override this guard.
      await this.bridges.assertNodeHasNoRoutes(tx, nodeId);

      // vpn_keys.node_id is ON DELETE RESTRICT, so the node's keys have to go
      // first. That is destructive and irreversible, so it never happens by
      // accident: without an explicit `deleteKeys` the call is refused and the
      // operator can disable the node instead.
      const keyRows = await tx
        .select({ id: vpnKeys.id, ownerId: vpnKeys.ownerId })
        .from(vpnKeys)
        .where(eq(vpnKeys.nodeId, nodeId));
      if (keyRows.length > 0 && !options.deleteKeys) {
        throw new ApiError(
          409,
          `Node still has ${keyRows.length} key(s), revoked ones included. Disable it, or delete it together with its keys.`,
          "NODE_HAS_KEYS",
        );
      }

      let deletedKeys = 0;
      let affectedOwners = 0;
      let droppedJobs = 0;
      if (keyRows.length > 0) {
        const keyIds = keyRows.map((row) => row.id);
        affectedOwners = new Set(keyRows.map((row) => row.ownerId)).size;
        // peer_current / traffic_samples / traffic_rollups all cascade from
        // vpn_keys, but job_outbox does NOT reference it — the key id only lives
        // in the payload. Those rows must go explicitly, or the worker keeps
        // retrying provision/revoke jobs for keys that no longer exist.
        const dropped = await tx
          .delete(jobOutbox)
          .where(inArray(sql`${jobOutbox.payload} ->> 'keyId'`, keyIds))
          .returning({ id: jobOutbox.id });
        droppedJobs = dropped.length;
        const removed = await tx
          .delete(vpnKeys)
          .where(eq(vpnKeys.nodeId, nodeId))
          .returning({ id: vpnKeys.id });
        deletedKeys = removed.length;
      }

      // quota_requests.node_id is ON DELETE SET NULL, which would silently turn
      // a pending per-server request into an every-server one. Cancel those in
      // the same transaction instead, before the node row disappears.
      const cancelled = await tx
        .update(quotaRequests)
        .set({
          status: "cancelled",
          reviewNote: "target server was removed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(quotaRequests.nodeId, nodeId),
            eq(quotaRequests.status, "pending"),
          ),
        )
        .returning({ id: quotaRequests.id });

      // The policy's node lists hold ids, not foreign keys, so nothing removes
      // this node from them. A stale id is harmless at read time, but it shows
      // a phantom row in the admin's order editor and makes the stored order
      // describe a fleet that no longer exists. Same transaction as the delete.
      const nodeEndpointIds = new Set(
        (
          await tx
            .select({ id: nodeVpnEndpoints.id })
            .from(nodeVpnEndpoints)
            .where(eq(nodeVpnEndpoints.nodeId, nodeId))
        ).map((item) => item.id),
      );
      const removedIds = new Set([nodeId, ...nodeEndpointIds]);
      const [policyRow] = await tx
        .select({
          recommendedNodeIds: portalPolicy.recommendedNodeIds,
          nodeOrder: portalPolicy.nodeOrder,
          allowedEndpointIds: portalPolicy.allowedEndpointIds,
          endpointOrder: portalPolicy.endpointOrder,
          recommendedEndpointIds: portalPolicy.recommendedEndpointIds,
        })
        .from(portalPolicy)
        .limit(1);
      let scrubbedFromRecommended = false;
      let scrubbedFromOrder = false;
      if (policyRow) {
        scrubbedFromRecommended = policyRow.recommendedNodeIds.includes(nodeId);
        scrubbedFromOrder = policyRow.nodeOrder.includes(nodeId);
        const scrubbedFromEndpointOrder = policyRow.endpointOrder.some((id) => removedIds.has(id));
        const scrubbedFromEndpointRec = policyRow.recommendedEndpointIds.some((id) => removedIds.has(id));
        const scrubbedFromAllowedEndpoints = (policyRow.allowedEndpointIds ?? []).some((id) => removedIds.has(id));
        if (
          scrubbedFromRecommended ||
          scrubbedFromOrder ||
          scrubbedFromEndpointOrder ||
          scrubbedFromEndpointRec ||
          scrubbedFromAllowedEndpoints
        ) {
          await tx
            .update(portalPolicy)
            .set({
              recommendedNodeIds: policyRow.recommendedNodeIds.filter(
                (id) => id !== nodeId,
              ),
              nodeOrder: policyRow.nodeOrder.filter((id) => id !== nodeId),
              endpointOrder: policyRow.endpointOrder.filter((id) => !removedIds.has(id)),
              recommendedEndpointIds: policyRow.recommendedEndpointIds.filter((id) => !removedIds.has(id)),
              ...(policyRow.allowedEndpointIds !== null
                ? { allowedEndpointIds: policyRow.allowedEndpointIds.filter((id) => !removedIds.has(id)) }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(portalPolicy.id, true));
        }
      }

      // Delete endpoints first so node_egress_ips ON DELETE SET NULL cannot collide on sibling uniqueness.
      await tx.delete(nodeVpnEndpoints).where(eq(nodeVpnEndpoints.nodeId, nodeId));
      await tx.delete(nodes).where(eq(nodes.id, nodeId));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.deleted",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          name: existing.name,
          deletedKeys,
          affectedOwners,
          droppedJobs,
          cancelledQuotaRequests: cancelled.length,
          scrubbedFromRecommended,
          scrubbedFromOrder,
        },
      });
      return {
        id: nodeId,
        deleted: true,
        deletedKeys,
        affectedOwners,
        droppedJobs,
        cancelledQuotaRequests: cancelled.length,
      };
    });

  listKeys = async (actor: Actor): Promise<KeyView[]> =>
    this.options.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          key: vpnKeys,
          current: peerCurrent,
          node: {
            name: nodes.name,
            publicName: nodes.publicName,
            publicIp: nodes.publicIp,
            egressMode: nodes.egressMode,
            egressDefaultIpId: nodes.egressDefaultIpId,
            keyUpdateNotifiedAt: nodes.keyUpdateNotifiedAt,
            keyUpdateNotifyNote: nodes.keyUpdateNotifyNote,
          },
        })
        .from(vpnKeys)
        // Inner join: `vpn_keys.node_id` is NOT NULL with ON DELETE RESTRICT, so
        // every key has its node row, enabled or not.
        .innerJoin(nodes, eq(nodes.id, vpnKeys.nodeId))
        .leftJoin(peerCurrent, eq(peerCurrent.keyId, vpnKeys.id))
        .where(eq(vpnKeys.ownerId, actor.id))
        .orderBy(desc(vpnKeys.createdAt));
      const [[globalPolicy], [owner]] = await Promise.all([
        tx.select().from(portalPolicy).limit(1),
        tx.select({ policyOverride: users.policyOverride }).from(users).where(eq(users.id, actor.id)),
      ]);
      const policy = resolvePortalPolicy(toPolicy(globalPolicy), owner?.policyOverride);
      const [activeRuleRows, notifiedRuleRows] = await Promise.all([
        tx
          .select({
            profile: routeRuleVersions.profile,
            id: routeRuleVersions.id,
          })
          .from(routeRuleVersions)
          .where(eq(routeRuleVersions.status, "active")),
        tx
          .select({
            profile: routeRuleVersions.profile,
            id: routeRuleVersions.id,
            notifiedAt: routeRuleVersions.notifiedAt,
            notifyNote: routeRuleVersions.notifyNote,
          })
          .from(routeRuleVersions)
          .where(isNotNull(routeRuleVersions.notifiedAt))
          .orderBy(desc(routeRuleVersions.notifiedAt)),
      ]);
      const activeByProfile = new Map(
        activeRuleRows.map((row) => [row.profile, row.id]),
      );
      const importantByProfile = new Map<string, ImportantRuleNotice>();
      for (const row of notifiedRuleRows) {
        if (!row.notifiedAt || importantByProfile.has(row.profile)) continue;
        importantByProfile.set(row.profile, {
          id: row.id,
          notifiedAt: row.notifiedAt,
          note: row.notifyNote,
        });
      }
      // The projection lives in keyView.ts as a pure function: it is what decides
      // whether the operator-only note leaves the server at all, and that
      // decision has to be assertable without a database.
      // Read per key's own node, not from `/api/nodes`: a key outlives the
      // permission to create keys on its server.
      const keyNodeIds = [...new Set(rows.map(({ key }) => key.nodeId))];
      const [reachability, publicEndpoints, egressIpsByNode] = await Promise.all([
        policy.showNodeStatus ? this.loadKeyReachability(keyNodeIds, tx) : null,
        this.loadNodePublicEndpoints(keyNodeIds, tx),
        this.loadNodeEgressIpsMap(keyNodeIds, tx),
      ]);
      const bridgeRoutes =
        actor.role === "admin" || policy.showNodeStatus
          ? await this.loadKeyBridgeRoutes(
              rows.map(({ key }) => key.nodeId),
              rows
                .map(({ key }) => key.vpnBridgeRouteId)
                .filter((id): id is string => id !== null),
              tx,
            )
          : null;
      type PublicEndpointRecord =
        typeof publicEndpoints extends Map<string, Array<infer U>> ? U : never;
      const emptyEndpointsById = new Map<string, PublicEndpointRecord>();
      const endpointLookupByNode = new Map<
        string,
        {
          byId: Map<string, PublicEndpointRecord>;
          primary: PublicEndpointRecord | undefined;
        }
      >();
      for (const [nId, eps] of publicEndpoints) {
        const byId = new Map(eps.map((ep) => [ep.id, ep]));
        const primary = eps.find((ep) => ep.ordinal === 1) ?? eps[0];
        endpointLookupByNode.set(nId, { byId, primary });
      }
      return rows.map(({ key, node, current }) => {
        const nodeEgressList = egressIpsByNode.get(key.nodeId) ?? [];
        const epLookup = endpointLookupByNode.get(key.nodeId);
        const { endpoint, exitIp: resolvedExit } = resolveEffectiveKeyAttachment({
          protocol: key.protocol,
          endpointId: key.endpointId,
          endpointsById: epLookup?.byId ?? emptyEndpointsById,
          primaryEndpoint: epLookup?.primary,
          nodePublicIp: node.publicIp,
          nodeEgressMode: node.egressMode,
          nodeEgressDefaultIpId: node.egressDefaultIpId,
          nodeEgressIps: nodeEgressList,
        });
        const bridge = bridgeRoutes
          ? resolveKeyBridgeInfo({
              protocol: key.protocol,
              bridgeMode: key.bridgeMode,
              pinnedRouteId: key.vpnBridgeRouteId,
              pinnedRoute: key.vpnBridgeRouteId
                ? (bridgeRoutes.byRouteId.get(key.vpnBridgeRouteId) ?? null)
                : null,
              activeRoute: bridgeRoutes.activeByNode.get(key.nodeId) ?? null,
              useBridge: policy.useBridge,
              endpointBridgeMode: endpoint?.bridgeMode,
            })
          : undefined;
        const usesCurrentBridge = bridge?.effective &&
          bridge.effective.routeId === bridgeRoutes?.activeByNode.get(key.nodeId)?.routeId;
        // Every address is measured on its own route: through the bridge when
        // the node has an active route and the address takes it by the portal
        // default, direct otherwise. A key that takes that same route reads
        // the address's verdict; a key that goes through the bridge where the
        // address was measured direct reads the node's bridge path row; one
        // that goes direct where only the bridge was measured reads unknown.
        const addressMeasuredBridged = endpoint !== null &&
          (bridgeRoutes?.activeByNode.has(key.nodeId) ?? false) &&
          (endpoint.bridgeMode === "bridge" ||
            (endpoint.bridgeMode === "inherit" && (globalPolicy?.useBridge ?? false)));
        const pathReachability = key.protocol === "awg3" && endpoint
          ? bridge?.effective
            ? (!usesCurrentBridge
                ? UNKNOWN_USER_REACHABILITY
                : addressMeasuredBridged ? endpoint.reachability : reachability?.(key.nodeId, key.protocol))
            : (addressMeasuredBridged ? UNKNOWN_USER_REACHABILITY : endpoint.reachability)
          : bridge?.effective
            ? (usesCurrentBridge ? reachability?.(key.nodeId, key.protocol) : UNKNOWN_USER_REACHABILITY)
            : key.protocol === "awg3" && bridgeRoutes?.activeByNode.has(key.nodeId)
              ? UNKNOWN_USER_REACHABILITY
              : reachability?.(key.nodeId, key.protocol);
        const endpointEgress = endpoint?.egressIpId
          ? (nodeEgressList.find((ip) => ip.id === endpoint.egressIpId) ?? null)
          : null;
        const defaultEgress = node.egressDefaultIpId
          ? (nodeEgressList.find((ip) => ip.id === node.egressDefaultIpId) ?? null)
          : null;
        const egress: KeyEgressInfo | undefined =
          actor.role === "admin" && key.ownerId === actor.id
            ? resolveKeyEgressInfo({
                protocol: key.protocol,
                nodePublicIp: node.publicIp,
                nodeEgressMode: node.egressMode,
                endpointAddress: endpoint?.publicAddress ?? null,
                endpointEgress,
                defaultEgress,
              })
            : undefined;
        const serverUpdateCandidates = [
          node.keyUpdateNotifiedAt
            ? {
                scope: "node" as const,
                notifiedAt: node.keyUpdateNotifiedAt,
                note: node.keyUpdateNotifyNote ?? null,
              }
            : null,
          endpoint?.keyUpdateNotifiedAt
            ? {
                scope: "endpoint" as const,
                notifiedAt: new Date(endpoint.keyUpdateNotifiedAt),
                note: endpoint.keyUpdateNotifyNote ?? null,
              }
            : null,
          resolvedExit?.keyUpdateNotifiedAt
            ? {
                scope: "exit" as const,
                notifiedAt: new Date(resolvedExit.keyUpdateNotifiedAt),
                note: resolvedExit.keyUpdateNotifyNote ?? null,
              }
            : null,
        ];
        return toKeyView({
          actor,
          key,
          node: endpoint ? { ...node, publicName: endpoint.name } : node,
          current,
          policy,
          activeByProfile,
          importantByProfile,
          serverUpdateCandidates,
          nodeReachability: reachability ? pathReachability : undefined,
          bridge,
          egress,
        });
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });

  private loadKeyBridgeRoutes = async (
    nodeIds: readonly string[],
    pinnedRouteIds: readonly string[],
    db: Database | DbTransaction = this.options.db,
  ): Promise<{
    activeByNode: Map<string, KeyBridgeRouteRecord>;
    byRouteId: Map<string, KeyBridgeRouteRecord>;
  }> => {
    const uniqueNodes = [...new Set(nodeIds)];
    const uniqueRoutes = [...new Set(pinnedRouteIds)];
    const activeByNode = new Map<string, KeyBridgeRouteRecord>();
    const byRouteId = new Map<string, KeyBridgeRouteRecord>();
    if (uniqueNodes.length === 0 && uniqueRoutes.length === 0) {
      return { activeByNode, byRouteId };
    }
    const conditions = [];
    if (uniqueNodes.length > 0) {
      conditions.push(
        and(
          inArray(vpnBridgeRoutes.nodeId, uniqueNodes),
          eq(vpnBridgeRoutes.state, "active"),
        ),
      );
    }
    if (uniqueRoutes.length > 0) {
      conditions.push(inArray(vpnBridgeRoutes.id, uniqueRoutes));
    }
    const rows = await db
      .select({
        routeId: vpnBridgeRoutes.id,
        nodeId: vpnBridgeRoutes.nodeId,
        state: vpnBridgeRoutes.state,
        bridgeId: vpnBridges.id,
        bridgeName: vpnBridges.name,
        publicIpv4: vpnBridges.publicIpv4,
        publicUdpPort: vpnBridgeRoutes.publicUdpPort,
      })
      .from(vpnBridgeRoutes)
      .innerJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .where(conditions.length === 1 ? conditions[0] : or(...conditions));
    for (const row of rows) {
      const record: KeyBridgeRouteRecord = {
        routeId: row.routeId,
        bridgeId: row.bridgeId,
        bridgeName: row.bridgeName,
        publicIpv4: row.publicIpv4,
        publicUdpPort: row.publicUdpPort,
      };
      byRouteId.set(row.routeId, record);
      if (row.state === "active") activeByNode.set(row.nodeId, record);
    }
    return { activeByNode, byRouteId };
  };

  createProvisioningKey = async (
    actor: Actor,
    request: CreateKeyRequest,
    options?: { allowBridgeSelection?: boolean },
  ): Promise<{ id: string; state: KeyState }> => {
    const allowBridgeSelection =
      options?.allowBridgeSelection ?? actor.role === "admin";
    if (
      !allowBridgeSelection &&
      (request.bridgeMode !== undefined || request.vpnBridgeRouteId !== undefined)
    ) {
      throw new ApiError(
        403,
        "Only administrators can choose bridge routing for a key",
        "POLICY_DENIED",
      );
    }
    // The same administrators-only rule for the key's own client settings.
    const configuresClient = request.awgGenerator != null || request.awgMtu != null;
    if (!allowBridgeSelection && (request.awgGenerator !== undefined || request.awgMtu !== undefined)) {
      throw new ApiError(
        403,
        "Only administrators can choose client settings for a key",
        "POLICY_DENIED",
      );
    }
    if (configuresClient && request.protocol !== "awg3") {
      throw new ApiError(409, "Client settings require AWG 3.1", "AWG_GENERATOR_UNSUPPORTED");
    }
    const bridgeMode: KeyBridgeMode = request.bridgeMode ?? "inherit";
    if (bridgeMode === "route" && request.protocol !== "awg3") {
      throw new ApiError(
        409,
        "Only AWG 3.1 keys can be routed through a bridge",
        "BRIDGE_KEY_NOT_AWG3",
      );
    }
    const keyId = randomUUID();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await this.options.db.transaction(
          async (tx) => {
        const lockedUsers = await tx
          .select()
          .from(users)
          .where(eq(users.id, actor.id))
          .for("update");
        const user = lockedUsers[0];
        if (!user || user.status !== "active") {
          throw new ApiError(403, "User is disabled", "USER_DISABLED");
        }
        const globalPolicy = (
          await tx.select().from(portalPolicy).limit(1)
        )[0];
        const policy = resolvePortalPolicy(
          toPolicy(globalPolicy),
          user.policyOverride,
        );
        if (!policy.allowKeyCreation) {
          throw new ApiError(403, "Key creation is disabled", "POLICY_DENIED");
        }
        if (
          request.routeProfile !== "full_tunnel" &&
          !policy.allowRouteProfileSelection
        ) {
          throw new ApiError(403, "Route profile is disabled", "POLICY_DENIED");
        }
        let routeRuleVersionId: string | null = null;
        if (request.routeProfile !== "full_tunnel") {
          const activeRule = await tx
            .select({ id: routeRuleVersions.id })
            .from(routeRuleVersions)
            .where(
              and(
                eq(routeRuleVersions.profile, request.routeProfile),
                eq(routeRuleVersions.status, "active"),
              ),
            )
            .limit(1);
          if (!activeRule[0]) {
            throw new ApiError(
              409,
              "Selected route profile has no validated version",
              "ROUTE_PROFILE_UNAVAILABLE",
            );
          }
          routeRuleVersionId = activeRule[0].id;
        }
        // The key limit is per node or one shared pool, depending on the
        // effective mode; see nodeQuota.hasRoomForKey.
        const quotaContext: NodeQuotaContext = {
          defaultKeyLimit: globalPolicy?.defaultKeyLimit ?? 5,
          keyLimitOverride: user.keyLimitOverride,
          nodeKeyLimits: user.nodeKeyLimits,
        };
        const keyLimitMode: KeyLimitMode = policy.keyLimitMode;
        // Global mode counts every key the user holds, once, under the users
        // row lock taken above; per-node mode never needs the total.
        const userKeysTotal =
          keyLimitMode === "global"
            ? ((
                await tx
                  .select({ value: count() })
                  .from(vpnKeys)
                  .where(
                    and(
                      eq(vpnKeys.ownerId, actor.id),
                      inArray(vpnKeys.state, quotaStates),
                    ),
                  )
              )[0]?.value ?? 0)
            : 0;

        // A node serves the requested protocol if it is the node's primary
        // protocol or the node reported the protocol in its capabilities.
        const protocolMatch = or(
          eq(nodes.protocol, request.protocol),
          sql`(${nodes.capabilities} ->> ${request.protocol})::boolean is true`,
        );
        const candidateNodes = await tx
          .select()
          .from(nodes)
          .where(
            policy.allowNodeSelection
              ? and(
                  eq(nodes.id, request.nodeId),
                  eq(nodes.enabled, true),
                  protocolMatch,
                )
              : and(eq(nodes.enabled, true), protocolMatch),
          )
          .orderBy(nodes.id)
          .for("update");
        // The SELECT above keeps ORDER BY id so row locks are always acquired
        // in the same order; the admin's order is applied after locking, in
        // memory, and never changes WHICH rows are locked. recommendedNodeIds
        // is deliberately not consulted: a badge does not promote a node here
        // any more than it does in listNodes.
        const allowedEndpointSet =
          policy.allowedEndpointIds !== null && policy.allowedEndpointIds !== undefined
            ? new Set(policy.allowedEndpointIds)
            : null;
        const endpointOrder = globalPolicy?.endpointOrder ?? [];
        const candidateEndpointRows =
          candidateNodes.length > 0 && request.protocol === "awg3"
            ? await tx
                .select({
                  id: nodeVpnEndpoints.id,
                  nodeId: nodeVpnEndpoints.nodeId,
                  ordinal: nodeVpnEndpoints.ordinal,
                  enabled: nodeVpnEndpoints.enabled,
                  enabledProtocols: nodeVpnEndpoints.enabledProtocols,
                })
                .from(nodeVpnEndpoints)
                .where(
                  inArray(
                    nodeVpnEndpoints.nodeId,
                    candidateNodes.map((node) => node.id),
                  ),
                )
            : [];
        const candidateEndpointsByNode = new Map<
          string,
          Array<{
            id: string;
            ordinal: number;
            enabled: boolean;
            enabledProtocols: ProtocolKind[] | null;
          }>
        >();
        for (const ep of candidateEndpointRows) {
          const list = candidateEndpointsByNode.get(ep.nodeId) ?? [];
          list.push(ep);
          candidateEndpointsByNode.set(ep.nodeId, list);
        }
        const derivedOrder =
          endpointOrder.length > 0
            ? [
                ...new Set([
                  ...endpointOrder
                    .map((id) => {
                      const owner = candidateNodes.find(
                        (node) =>
                          node.id === id ||
                          (candidateEndpointsByNode.get(node.id) ?? []).some(
                            (ep) => ep.id === id,
                          ),
                      );
                      return owner?.id;
                    })
                    .filter((id): id is string => Boolean(id)),
                  ...(globalPolicy?.nodeOrder ?? []),
                ]),
              ]
            : (globalPolicy?.nodeOrder ?? []);
        const orderedCandidates = orderNodesForUsers(
          candidateNodes,
          derivedOrder,
        );
        let selectedNode: (typeof candidateNodes)[number] | undefined;
        let userQuotaBlocked = false;
        let nodeCapacityBlocked = false;
        let protocolBlocked = false;
        let availabilityBlocked = false;
        for (const candidate of orderedCandidates) {
          // Node availability (global default or per-user override).
          if (!isNodeAvailable(policy.allowedNodeIds, candidate.id)) {
            availabilityBlocked = true;
            continue;
          }
          const candidateEndpoints = candidateEndpointsByNode.get(candidate.id) ?? [];
          const availableEndpoints = candidateEndpoints.filter(
            (ep) =>
              ep.enabled &&
              (allowedEndpointSet === null || allowedEndpointSet.has(ep.id)),
          );
          if (
            (candidateEndpoints.length === 0 &&
              allowedEndpointSet !== null &&
              !allowedEndpointSet.has(candidate.id)) ||
            (request.protocol === "awg3" &&
              candidateEndpoints.length > 0 &&
              availableEndpoints.length === 0)
          ) {
            availabilityBlocked = true;
            continue;
          }
          if (
            request.protocol === "awg3" &&
            candidateEndpoints.length > 0 &&
            !availableEndpoints.some((ep) =>
              endpointAllowsProtocol(ep, request.protocol),
            )
          ) {
            protocolBlocked = true;
            continue;
          }
          // The chosen protocol must be enabled on THIS node and permitted by
          // policy — not merely physically served.
          const selectable = computeSelectableProtocols(
            deriveSupportedProtocols(candidate.protocol, candidate.capabilities),
            candidate.enabledProtocols,
            policy.allowedProtocols,
          );
          if (!selectable.includes(request.protocol)) {
            protocolBlocked = true;
            continue;
          }
          const userKeysOnNode =
            (
              await tx
                .select({ value: count() })
                .from(vpnKeys)
                .where(
                  and(
                    eq(vpnKeys.ownerId, actor.id),
                    eq(vpnKeys.nodeId, candidate.id),
                    inArray(vpnKeys.state, quotaStates),
                  ),
                )
            )[0]?.value ?? 0;
          // Per-node mode: this node's resolved limit, where a per-node entry
          // beats the flat override. Global mode: the pool, which a full total
          // exhausts on every candidate at once.
          if (
            !hasRoomForKey(quotaContext, keyLimitMode, candidate.id, {
              keysOnNode: userKeysOnNode,
              keysTotal: userKeysTotal,
            })
          ) {
            userQuotaBlocked = true;
            continue;
          }
          const nodeKeyCount =
            (
              await tx
                .select({ value: count() })
                .from(vpnKeys)
                .where(
                  and(
                    eq(vpnKeys.nodeId, candidate.id),
                    inArray(vpnKeys.state, quotaStates),
                  ),
                )
            )[0]?.value ?? 0;
          if (nodeKeyCount >= candidate.maxPeers) {
            nodeCapacityBlocked = true;
            continue;
          }
          selectedNode = candidate;
          break;
        }
        if (!selectedNode) {
          if (userQuotaBlocked) {
            throw new ApiError(409, "Key quota exceeded", "QUOTA_EXCEEDED");
          }
          if (nodeCapacityBlocked) {
            throw new ApiError(409, "Node capacity reached", "NODE_AT_CAPACITY");
          }
          if (protocolBlocked) {
            throw new ApiError(
              403,
              "Selected protocol is not permitted",
              "PROTOCOL_NOT_ALLOWED",
            );
          }
          if (availabilityBlocked) {
            throw new ApiError(
              403,
              "Selected node is not available",
              "NODE_NOT_ALLOWED",
            );
          }
          throw new ApiError(409, "Node is unavailable", "NODE_UNAVAILABLE");
        }
        let endpointId: string | null = null;
        if (request.endpointId) {
          if (!policy.allowNodeSelection) {
            throw new ApiError(403, "Address selection is disabled", "POLICY_DENIED");
          }
          const [endpoint] = await tx
            .select({
              id: nodeVpnEndpoints.id,
              enabledProtocols: nodeVpnEndpoints.enabledProtocols,
            })
            .from(nodeVpnEndpoints)
            .where(and(
              eq(nodeVpnEndpoints.id, request.endpointId),
              eq(nodeVpnEndpoints.nodeId, selectedNode.id),
              eq(nodeVpnEndpoints.enabled, true),
            ));
          if (!endpoint) {
            throw new ApiError(409, "Selected address is unavailable on this node", "NODE_ENDPOINT_UNAVAILABLE");
          }
          if (allowedEndpointSet !== null && !allowedEndpointSet.has(endpoint.id)) {
            throw new ApiError(403, "Selected address is not permitted", "NODE_NOT_ALLOWED");
          }
          if (!endpointAllowsProtocol(endpoint, request.protocol)) {
            throw new ApiError(
              403,
              "Selected protocol is not permitted on this address",
              "PROTOCOL_NOT_ALLOWED",
            );
          }
          endpointId = endpoint.id;
        } else if (request.protocol === "awg3") {
          const preferred = selectDefaultNodeEndpoint(
            (candidateEndpointsByNode.get(selectedNode.id) ?? []).filter((ep) =>
              endpointAllowsProtocol(ep, request.protocol),
            ),
            endpointOrder,
            allowedEndpointSet,
          );
          if (preferred && preferred.ordinal !== 1) {
            endpointId = preferred.id;
          }
        }
        let vpnBridgeRouteId: string | null = null;
        if (bridgeMode === "route") {
          const requestedRouteId = request.vpnBridgeRouteId;
          if (!requestedRouteId) {
            throw new ApiError(
              400,
              "A bridge route is required when bridgeMode is 'route'",
              "VALIDATION_ERROR",
            );
          }
          const [pinnedRoute] = await tx
            .select({
              id: vpnBridgeRoutes.id,
              nodeId: vpnBridgeRoutes.nodeId,
            })
            .from(vpnBridgeRoutes)
            .where(eq(vpnBridgeRoutes.id, requestedRouteId))
            .limit(1);
          if (!pinnedRoute) {
            throw new ApiError(
              404,
              "Bridge route not found",
              "BRIDGE_ROUTE_NOT_FOUND",
            );
          }
          if (pinnedRoute.nodeId !== selectedNode.id) {
            throw new ApiError(
              409,
              "Selected bridge route belongs to a different node",
              "BRIDGE_ROUTE_WRONG_NODE",
            );
          }
          vpnBridgeRouteId = pinnedRoute.id;
        }
        const labelSecret = decryptSecret(
          {
            ciphertext: selectedNode.labelSecretCiphertext,
            nonce: selectedNode.labelSecretNonce,
            authTag: selectedNode.labelSecretAuthTag,
            keyVersion: selectedNode.labelSecretKeyVersion,
          },
          this.options.keyring,
        );
        const nodeLabel = deterministicPeerLabel(
          keyId,
          Buffer.from(labelSecret, "base64"),
        );
        // Per-owner sequential key number. Safe from races: the owner's `users`
        // row is locked FOR UPDATE above, so concurrent creations serialize.
        const [numbering] = await tx
          .select({
            next: sql<number>`coalesce(max(${vpnKeys.keyNumber}), 0) + 1`,
          })
          .from(vpnKeys)
          .where(eq(vpnKeys.ownerId, actor.id));
        const keyNumber = Number(numbering?.next ?? 1);
        await tx.insert(vpnKeys).values({
          id: keyId,
          ownerId: actor.id,
          nodeId: selectedNode.id,
          endpointId,
          nodeLabel,
          protocol: request.protocol,
          state: "provisioning",
          deviceType: request.deviceType,
          deviceLabel: request.deviceLabel,
          keyNumber,
          nameShowNode: request.nameDisplay.server,
          nameShowLabel: request.nameDisplay.label,
          nameShowNumber: request.nameDisplay.number,
          routeProfile: request.routeProfile,
          routeRuleVersionId,
          // Every new AWG3 key gets its own client profile. It applies only
          // once the node's artifact turns out to be 3.1; a 2.0 one ignores it.
          awgClientProfile:
            request.protocol === "awg3" ? selectAwgClientProfile(1) : null,
          awgGenerator: request.awgGenerator ?? null,
          awgMtu: request.awgMtu ?? null,
          bridgeMode,
          vpnBridgeRouteId,
        });
        await tx.insert(jobOutbox).values({
          type: "vpn-key.provision",
          deduplicationKey: `vpn-key.provision:${keyId}`,
          payload: { keyId },
        });
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_key.create_requested",
          targetType: "vpn_key",
          targetId: keyId,
          metadata: {
            ...keyAuditSnapshot({
              ownerId: actor.id,
              nodeId: selectedNode.id,
              endpointId,
              protocol: request.protocol,
              routeProfile: request.routeProfile,
              deviceType: request.deviceType,
              deviceLabel: request.deviceLabel,
              keyNumber,
            }),
            nameDisplay: request.nameDisplay,
            bridgeMode,
            vpnBridgeRouteId,
          },
        });
            return { id: keyId, state: "provisioning" as const };
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (attempt === 9 || !isRetryableTransactionError(error)) throw error;
        await retryDelay(attempt);
      }
    }
    throw new Error("Serializable transaction retry limit exceeded");
  };

  findKeyConfig = async (
    keyId: string,
    reader: Pick<Database, "select"> = this.options.db,
  ): Promise<StoredKeyConfig | null> => {
    const pinnedRoute = alias(vpnBridgeRoutes, "pinned_bridge_route");
    const pinnedBridge = alias(vpnBridges, "pinned_bridge");
    const endpointEgress = alias(nodeEgressIps, "endpoint_egress_ip");
    const defaultEgress = alias(nodeEgressIps, "default_egress_ip");
    const rows = await reader
      .select({
        key: vpnKeys,
        user: users,
        policy: portalPolicy,
        nodeName: nodes.name,
        nodePublicName: nodes.publicName,
        nodeEgressMode: nodes.egressMode,
        endpointName: nodeVpnEndpoints.name,
        endpointAddress: nodeVpnEndpoints.address,
        endpointBridgeMode: nodeVpnEndpoints.bridgeMode,
        endpointEgressDns1: endpointEgress.dnsPrimary,
        endpointEgressDns2: endpointEgress.dnsSecondary,
        defaultEgressDns1: defaultEgress.dnsPrimary,
        defaultEgressDns2: defaultEgress.dnsSecondary,
        nodeAwgGenerator: nodes.awgGenerator,
        nodeAwgMtu: nodes.awgMtu,
        endpointId: nodeVpnEndpoints.id,
        endpointAwgGenerator: nodeVpnEndpoints.awgGenerator,
        endpointAwgMtu: nodeVpnEndpoints.awgMtu,
        endpointDeviceRules: nodeVpnEndpoints.awgDeviceRules,
        nodeIpv6RejectStubEnabled: nodes.ipv6RejectStubEnabled,
        nodeIpv6RejectStubState: nodes.ipv6RejectStubState,
        nodeIpv6RejectStubPrefix: nodes.ipv6RejectStubPrefix,
        activeRouteId: vpnBridgeRoutes.id,
        activeBridgeId: vpnBridges.id,
        activeBridgeName: vpnBridges.name,
        activeBridgeHost: vpnBridges.publicIpv4,
        activeBridgePort: vpnBridgeRoutes.publicUdpPort,
        pinnedRouteId: pinnedRoute.id,
        pinnedBridgeId: pinnedBridge.id,
        pinnedBridgeName: pinnedBridge.name,
        pinnedBridgeHost: pinnedBridge.publicIpv4,
        pinnedBridgePort: pinnedRoute.publicUdpPort,
      })
      .from(vpnKeys)
      .innerJoin(users, eq(users.id, vpnKeys.ownerId))
      .innerJoin(nodes, eq(nodes.id, vpnKeys.nodeId))
      .leftJoin(nodeVpnEndpoints, keyEndpointJoin)
      .leftJoin(endpointEgress, eq(endpointEgress.id, nodeVpnEndpoints.egressIpId))
      .leftJoin(defaultEgress, eq(defaultEgress.id, nodes.egressDefaultIpId))
      .leftJoin(portalPolicy, eq(portalPolicy.id, true))
      // One statement reads the key, any pinned route and the node's active
      // route, so an export sees one consistent assignment.
      .leftJoin(
        vpnBridgeRoutes,
        and(
          eq(vpnBridgeRoutes.nodeId, vpnKeys.nodeId),
          eq(vpnBridgeRoutes.state, "active"),
        ),
      )
      .leftJoin(vpnBridges, eq(vpnBridges.id, vpnBridgeRoutes.bridgeId))
      .leftJoin(pinnedRoute, eq(pinnedRoute.id, vpnKeys.vpnBridgeRouteId))
      .leftJoin(pinnedBridge, eq(pinnedBridge.id, pinnedRoute.bridgeId))
      .where(and(eq(vpnKeys.id, keyId), isNotNull(vpnKeys.configCiphertext)))
      .limit(1);
    const row = rows[0];
    // The probe's keys are not handed out by the panel, to anyone.
    if (row?.user.serviceAccount) return null;
    if (
      !row?.key.configCiphertext ||
      !row.key.configNonce ||
      !row.key.configAuthTag ||
      row.key.configKeyVersion === null
    ) {
      return null;
    }
    const activeRule =
      row.key.routeProfile === "full_tunnel"
        ? null
        : await this.findActiveRule(row.key.routeProfile, reader);
    const resolvedPolicy = resolvePortalPolicy(
      toPolicy(row.policy ?? undefined),
      row.user.policyOverride,
    );
    const activeRouteRecord: KeyBridgeRouteRecord | null =
      row.activeRouteId !== null &&
      row.activeBridgeId !== null &&
      row.activeBridgeName !== null &&
      row.activeBridgeHost !== null &&
      row.activeBridgePort !== null
        ? {
            routeId: row.activeRouteId,
            bridgeId: row.activeBridgeId,
            bridgeName: row.activeBridgeName,
            publicIpv4: row.activeBridgeHost,
            publicUdpPort: row.activeBridgePort,
          }
        : null;
    const pinnedRouteRecord: KeyBridgeRouteRecord | null =
      row.pinnedRouteId !== null &&
      row.pinnedBridgeId !== null &&
      row.pinnedBridgeName !== null &&
      row.pinnedBridgeHost !== null &&
      row.pinnedBridgePort !== null
        ? {
            routeId: row.pinnedRouteId,
            bridgeId: row.pinnedBridgeId,
            bridgeName: row.pinnedBridgeName,
            publicIpv4: row.pinnedBridgeHost,
            publicUdpPort: row.pinnedBridgePort,
          }
        : null;
    const bridgeInfo = resolveKeyBridgeInfo({
      protocol: row.key.protocol,
      bridgeMode: row.key.bridgeMode,
      pinnedRouteId: row.key.vpnBridgeRouteId,
      pinnedRoute: pinnedRouteRecord,
      activeRoute: activeRouteRecord,
      useBridge: resolvedPolicy.useBridge,
      endpointBridgeMode: row.endpointBridgeMode ?? undefined,
    });
    const settings = resolveKeyClientSettings({
      key: row.key,
      owner: row.user,
      endpoint: row.endpointId
        ? { awgGenerator: row.endpointAwgGenerator, awgMtu: row.endpointAwgMtu, awgDeviceRules: row.endpointDeviceRules }
        : null,
      node: { awgGenerator: row.nodeAwgGenerator, awgMtu: row.nodeAwgMtu },
    });
    return {
      id: row.key.id,
      ownerId: row.key.ownerId,
      nodeId: row.key.nodeId,
      deviceLabel: row.key.deviceLabel,
      keyNumber: row.key.keyNumber,
      nodeDisplayName: row.endpointName ?? row.nodePublicName ?? row.nodeName,
      ...(row.key.endpointId && row.endpointAddress ? { directAddress: row.endpointAddress } : {}),
      nameDisplay: {
        server: row.key.nameShowNode,
        label: row.key.nameShowLabel,
        number: row.key.nameShowNumber,
      },
      encrypted: {
        ciphertext: row.key.configCiphertext,
        nonce: row.key.configNonce,
        authTag: row.key.configAuthTag,
        keyVersion: row.key.configKeyVersion,
      },
      policy: resolvedPolicy,
      routeProfile: row.key.routeProfile,
      appliedRuleVersionId: row.key.routeRuleVersionId,
      activeRule,
      customRoutes: row.user.customRoutes ?? null,
      state: row.key.state,
      protocol: row.key.protocol,
      bridgeEndpoint: bridgeInfo.effective
        ? {
            host: bridgeInfo.effective.publicIpv4,
            port: bridgeInfo.effective.publicUdpPort,
          }
        : null,
      awgClientProfile: row.key.awgClientProfile ?? null,
      awgGenerator: settings.awgGenerator,
      awgMtu: settings.mtu,
      awgSettingsFrom: { profileFrom: settings.profileFrom, mtuFrom: settings.mtuFrom },
      deviceType: row.key.deviceType,
      nodeIpv6RejectStub: {
        enabled: row.nodeIpv6RejectStubEnabled,
        state: row.nodeIpv6RejectStubState,
        prefix: row.nodeIpv6RejectStubPrefix,
      },
      egressDns:
        row.key.protocol === "awg3" && row.nodeEgressMode === "routed"
          ? row.endpointEgressDns1 !== null
            ? { dns1: row.endpointEgressDns1, dns2: row.endpointEgressDns2 ?? null }
            : row.defaultEgressDns1 !== null
              ? { dns1: row.defaultEgressDns1, dns2: row.defaultEgressDns2 ?? null }
              : null
          : null,
    };
  };

  private findActiveRule = async (
    profile: RouteProfile,
    reader: Pick<Database, "select"> = this.options.db,
  ): Promise<ActiveRule | null> => {
    const [rule] = await reader
      .select({
        id: routeRuleVersions.id,
        version: routeRuleVersions.version,
        payload: routeRuleVersions.payload,
      })
      .from(routeRuleVersions)
      .where(
        and(
          eq(routeRuleVersions.profile, profile),
          eq(routeRuleVersions.status, "active"),
        ),
      )
      .limit(1);
    if (!rule) return null;
    return { versionId: rule.id, version: rule.version, payload: rule.payload };
  };

  getGlobalRoutes = async (reader: Pick<Database, "select"> = this.options.db): Promise<GlobalRoutes> => {
    const [row] = await reader
      .select({ payload: globalRouteOverrides.payload })
      .from(globalRouteOverrides)
      .where(eq(globalRouteOverrides.id, true))
      .limit(1);
    if (!row) return emptyGlobalRoutes;
    // Re-parse so a payload written by an older schema version still yields a
    // complete object instead of tripping over a missing profile key.
    const parsed = globalRoutesSchema.safeParse(row.payload);
    return parsed.success ? parsed.data : emptyGlobalRoutes;
  };

  recordConfigExport = async (
    keyId: string,
    format: string,
    hash: string,
    context: Parameters<ControlRepository["recordConfigExport"]>[3],
  ): Promise<boolean> => this.options.db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: vpnKeys.id }).from(vpnKeys)
      .where(eq(vpnKeys.id, keyId)).for("update");
    if (!locked) return false;
    const current = await this.findKeyConfig(keyId, tx);
    if (!current) return false;
    const source = (key: StoredKeyConfig) => Object.fromEntries(
      Object.entries(key).filter(([name]) => name !== "appliedRuleVersionId"),
    );
    if (!isDeepStrictEqual(source(current), source(context.key))) return false;
    if (context.globalRoutes !== null && !isDeepStrictEqual(
      await this.getGlobalRoutes(tx), context.globalRoutes,
    )) return false;
    const ruleVersion = context.markRuleVersion ? current.activeRule?.versionId : undefined;
    const changesRule = ruleVersion !== undefined && current.appliedRuleVersionId !== ruleVersion;
    const markDelivered = context.markConfigDelivered === true;
    await tx.update(vpnKeys).set({
      configExportHashes: sql`coalesce(${vpnKeys.configExportHashes}, '{}'::jsonb)
        || jsonb_build_object(${format}::text, ${hash}::text)`,
      configUpdatedAt: changesRule
        ? sql`greatest(${vpnKeys.configUpdatedAt}, clock_timestamp())`
        : sql`CASE WHEN ${vpnKeys.configExportHashes}->>${format} IS DISTINCT FROM ${hash} THEN greatest(${vpnKeys.configUpdatedAt}, clock_timestamp()) ELSE ${vpnKeys.configUpdatedAt} END`,
      ...(markDelivered ? { configDeliveredAt: sql`clock_timestamp()` } : {}),
      ...(changesRule
        ? {
            routeRuleVersionId: ruleVersion,
            rulesDeliveredAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          }
        : {}),
    }).where(and(
      eq(vpnKeys.id, keyId),
      changesRule || markDelivered
        ? undefined
        : sql`${vpnKeys.configExportHashes}->>${format} IS DISTINCT FROM ${hash}`,
    ));
    return true;
  });

  listRouteProfiles = async (): Promise<RouteProfileAvailability[]> => {
    const active = await this.options.db
      .select({
        profile: routeRuleVersions.profile,
        version: routeRuleVersions.version,
      })
      .from(routeRuleVersions)
      .where(eq(routeRuleVersions.status, "active"));
    const byProfile = new Map(active.map((row) => [row.profile, row.version]));
    return (["full_tunnel", "ru_blacklist"] as const).map(
      (profile) => ({
        profile,
        available: profile === "full_tunnel" || byProfile.has(profile),
        activeVersion: byProfile.get(profile) ?? null,
      }),
    );
  };

  getRuleVersion = async (id: string): Promise<unknown> => {
    const [rule] = await this.options.db
      .select()
      .from(routeRuleVersions)
      .where(eq(routeRuleVersions.id, id))
      .limit(1);
    if (!rule) throw new ApiError(404, "Rule version not found", "RULE_NOT_FOUND");
    return rule;
  };

  diffRuleVersions = async (
    baseId: string,
    nextId: string,
  ): Promise<unknown> => {
    const versions = await this.options.db
      .select({
        id: routeRuleVersions.id,
        version: routeRuleVersions.version,
        payload: routeRuleVersions.payload,
      })
      .from(routeRuleVersions)
      .where(inArray(routeRuleVersions.id, [baseId, nextId]));
    const base = versions.find((row) => row.id === baseId);
    const next = versions.find((row) => row.id === nextId);
    if (!base || !next) {
      throw new ApiError(404, "Rule version not found", "RULE_NOT_FOUND");
    }
    return {
      base: { id: base.id, version: base.version },
      next: { id: next.id, version: next.version },
      diff: diffRulePayloads(base.payload, next.payload),
    };
  };

  enqueueOwnRevoke = async (actor: Actor, keyId: string): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      const [user, globalPolicy] = await Promise.all([
        tx
          .select({ policyOverride: users.policyOverride })
          .from(users)
          .where(eq(users.id, actor.id))
          .limit(1),
        tx.select().from(portalPolicy).limit(1),
      ]);
      const policy = resolvePortalPolicy(
        toPolicy(globalPolicy[0]),
        user[0]?.policyOverride,
      );
      if (!policy.allowSelfRevoke) {
        throw new ApiError(403, "Self revoke is disabled", "POLICY_DENIED");
      }
      // `revoking` and `failed` are here so a delete that did not go through
      // can be asked for again: a node that was down leaves the key in
      // `revoking`, and rows from before that fix are stuck in `failed`.
      // Answering 404 to the second attempt is what left keys in a user's list
      // that they had already deleted and could not delete again.
      const updated = await tx
        .update(vpnKeys)
        .set({ state: "revoking", updatedAt: new Date() })
        .where(
          and(
            eq(vpnKeys.id, keyId),
            eq(vpnKeys.ownerId, actor.id),
            inArray(vpnKeys.state, revocableStates),
          ),
        )
        .returning({
          id: vpnKeys.id,
          ownerId: vpnKeys.ownerId,
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
          protocol: vpnKeys.protocol,
          routeProfile: vpnKeys.routeProfile,
          deviceType: vpnKeys.deviceType,
          deviceLabel: vpnKeys.deviceLabel,
          keyNumber: vpnKeys.keyNumber,
          internalName: vpnKeys.internalName,
        });
      if (!updated[0]) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
      await tx.insert(jobOutbox).values({
        type: "vpn-key.revoke",
        // Unique per attempt, like the admin path. A fixed key deduplicated
        // against the row of the attempt that already failed, so the retry was
        // accepted and then silently enqueued nothing. The worker's revoke
        // handler looks the peer up before deleting it, so a duplicate job on
        // an already-deleted peer completes cleanly.
        deduplicationKey: revokeJobDedupKey(keyId, randomUUID()),
        payload: { keyId },
      });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_key.revoke_requested",
        targetType: "vpn_key",
        targetId: keyId,
        metadata: keyAuditSnapshot(updated[0]),
      });
    });
  };

  updateOwnCustomRoutes = async (
    actor: Actor,
    routes: CustomRoutes,
  ): Promise<CustomRoutes> => {
    const customRoutes = dedupeCustomRoutes(routes);
    return this.options.db.transaction(async (tx) => {
      const [user, globalPolicy] = await Promise.all([
        tx
          .select({ policyOverride: users.policyOverride })
          .from(users)
          .where(eq(users.id, actor.id))
          .limit(1),
        tx.select().from(portalPolicy).limit(1),
      ]);
      const policy = resolvePortalPolicy(
        toPolicy(globalPolicy[0]),
        user[0]?.policyOverride,
      );
      if (!policy.allowCustomRoutes) {
        throw new ApiError(403, "Custom routes are disabled", "POLICY_DENIED");
      }
      const [updated] = await tx
        .update(users)
        .set({ customRoutes, updatedAt: new Date() })
        .where(eq(users.id, actor.id))
        .returning({ customRoutes: users.customRoutes });
      if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "user.custom_routes_updated",
        targetType: "user",
        targetId: actor.id,
      });
      return updated.customRoutes ?? customRoutes;
    });
  };

  /**
   * The mechanics shared by every reason a key's peer gets replaced: flip the
   * row to `provisioning`, queue the worker's rotate job, and audit it. Called
   * from inside the caller's own transaction and locked row, so it never
   * re-reads or re-checks the key itself -- the caller already decided this
   * rotate is warranted; this only carries it out.
   *
   * `state` is the row's state as the caller already read it (typically under
   * `for("update")`), not re-queried here, so a caller who has already made
   * its own decision about which states are acceptable is not second-guessed.
   */
  private queueKeyRotate = async (
    tx: DbTransaction,
    actor: Actor,
    keyId: string,
    state: KeyState,
    auditAction: string,
    auditMetadata?: Record<string, unknown>,
  ): Promise<void> => {
    // Checked ahead of `rotatableStates` and with its own code: an
    // administrator disabled this key on purpose, and re-issuing it always
    // comes back `active` (`completeProvision` knows only one outcome), so
    // routing a disabled key through rotate -- whether asked for directly or
    // as a side effect of a rename -- would let the owner quietly reverse the
    // administrator's decision. The message says that plainly instead of
    // reusing the generic "cannot be rotated" reason below, which is about
    // transient states (mid-provisioning, mid-revoke), not a deliberate one.
    if (state === "disabled") {
      throw new ApiError(
        409,
        "This key was disabled by an administrator. Renaming or rotating it cannot re-enable it -- ask an administrator to enable it first.",
        "KEY_DISABLED_BY_ADMIN",
      );
    }
    if (!rotatableStates.includes(state)) {
      throw new ApiError(
        409,
        "Key cannot be rotated in its current state",
        "ROTATION_NOT_ALLOWED",
      );
    }
    // A rotate kills the config the device holds, and whatever replaces it is
    // exported later with the rules active at that moment. So the version the
    // key was last delivered with stops describing anything: move it to the
    // active one. Left alone, the "rules updated" callout -- whose own button
    // is this rotate -- came straight back the moment the reissued key went
    // active. A profile with no active version (full_tunnel never has one)
    // keeps what it had.
    const [rotated] = await tx
      .update(vpnKeys)
      .set({
        state: "provisioning",
        tunnelIpv4: null,
        routeRuleVersionId: sql`coalesce((
          select ${routeRuleVersions.id} from ${routeRuleVersions}
          where ${routeRuleVersions.profile} = ${vpnKeys.routeProfile}
            and ${routeRuleVersions.status} = 'active'
          order by ${routeRuleVersions.publishedAt} desc
          limit 1
        ), ${vpnKeys.routeRuleVersionId})`,
        rulesDeliveredAt: sql`clock_timestamp()`,
        updatedAt: new Date(),
      })
      .where(eq(vpnKeys.id, keyId))
      .returning({
        ownerId: vpnKeys.ownerId,
        nodeId: vpnKeys.nodeId,
        endpointId: vpnKeys.endpointId,
        protocol: vpnKeys.protocol,
        routeProfile: vpnKeys.routeProfile,
        deviceType: vpnKeys.deviceType,
        deviceLabel: vpnKeys.deviceLabel,
        keyNumber: vpnKeys.keyNumber,
        internalName: vpnKeys.internalName,
      });
    await tx.insert(jobOutbox).values({
      type: "vpn-key.rotate",
      deduplicationKey: `vpn-key.rotate:${keyId}:${randomUUID()}`,
      payload: { keyId },
    });
    await tx.insert(auditEvents).values({
      actorUserId: actor.id,
      actorType: "user",
      action: auditAction,
      targetType: "vpn_key",
      targetId: keyId,
      metadata: {
        ...(rotated ? keyAuditSnapshot(rotated) : {}),
        ...(auditMetadata ?? {}),
      },
    });
  };

  refreshOwnConfigProfile = async (
    actor: Actor,
    keyId: string,
    refreshToken: string,
    prepare: (snapshot: ConfigRefreshSnapshot) => AwgClientProfileV1,
  ): Promise<{ revision: number }> =>
    this.options.db.transaction(async (tx) => {
      // Owner only, admins included: this changes the owner's own config.
      const [key] = await tx
        .select({
          state: vpnKeys.state,
          awgClientProfile: vpnKeys.awgClientProfile,
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
          deviceType: vpnKeys.deviceType,
          awgGenerator: vpnKeys.awgGenerator,
          awgMtu: vpnKeys.awgMtu,
          configCiphertext: vpnKeys.configCiphertext,
          configNonce: vpnKeys.configNonce,
          configAuthTag: vpnKeys.configAuthTag,
          configKeyVersion: vpnKeys.configKeyVersion,
        })
        .from(vpnKeys)
        .where(and(eq(vpnKeys.id, keyId), eq(vpnKeys.ownerId, actor.id)))
        .limit(1)
        .for("update");
      if (!key) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
      const [user, globalPolicy] = await Promise.all([
        tx
          .select({
            policyOverride: users.policyOverride,
            awgGenerator: users.awgGenerator,
            awgMtu: users.awgMtu,
            awgDeviceRules: users.awgDeviceRules,
          })
          .from(users)
          .where(eq(users.id, actor.id))
          .limit(1),
        tx.select().from(portalPolicy).limit(1),
      ]);
      const policy = resolvePortalPolicy(
        toPolicy(globalPolicy[0]),
        user[0]?.policyOverride,
      );
      if (!policy.allowConfigRedownload) {
        throw new ApiError(403, "Config download is disabled", "POLICY_DENIED");
      }
      if (
        key.state !== "active" ||
        !key.configCiphertext ||
        !key.configNonce ||
        !key.configAuthTag ||
        key.configKeyVersion === null
      ) {
        throw new ApiError(
          409,
          "This key cannot refresh its config",
          CONFIG_REFRESH_UNAVAILABLE,
        );
      }
      const revision = profileRevision(key.awgClientProfile);
      const settings = resolveKeyClientSettings({
        key,
        owner: user[0] ?? null,
        ...(await this.keyAddressAndNodeLevels(tx, key)),
      });
      if (configRefreshToken(keyId, key.configNonce, revision, settings.awgGenerator, settings.mtu) !== refreshToken) {
        throw new ApiError(
          409,
          "The config changed since it was checked",
          CONFIG_REFRESH_STALE,
        );
      }
      const profile = prepare({
        keyId,
        encrypted: {
          ciphertext: key.configCiphertext,
          nonce: key.configNonce,
          authTag: key.configAuthTag,
          keyVersion: key.configKeyVersion,
        },
        awgClientProfile: key.awgClientProfile ?? null,
        revision,
        awgGenerator: settings.awgGenerator,
        awgMtu: settings.mtu,
      });
      await tx
        .update(vpnKeys)
        .set({ awgClientProfile: profile, configUpdatedAt: sql`greatest(${vpnKeys.configUpdatedAt}, clock_timestamp())`, updatedAt: sql`clock_timestamp()` })
        .where(eq(vpnKeys.id, keyId));
      // The revision only: the profile's values are not worth an audit trail,
      // and nothing of the config goes there.
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_key.config_profile_refreshed",
        targetType: "vpn_key",
        targetId: keyId,
        metadata: { revision: profile.revision },
      });
      return { revision: profile.revision };
    });

  /**
   * A key's address (its own, or the node's first: `keyEndpointJoin`) and node
   * client-settings levels, in `resolveKeyClientSettings`'s shape.
   */
  private keyAddressAndNodeLevels = async (
    reader: Pick<Database, "select">,
    key: { nodeId: string; endpointId: string | null },
  ) => {
    const [levels] = await reader.select({
      nodeAwgGenerator: nodes.awgGenerator,
      nodeAwgMtu: nodes.awgMtu,
      endpointId: nodeVpnEndpoints.id,
      endpointAwgGenerator: nodeVpnEndpoints.awgGenerator,
      endpointAwgMtu: nodeVpnEndpoints.awgMtu,
      endpointDeviceRules: nodeVpnEndpoints.awgDeviceRules,
    }).from(nodes).leftJoin(nodeVpnEndpoints, and(
      eq(nodeVpnEndpoints.nodeId, nodes.id),
      key.endpointId ? eq(nodeVpnEndpoints.id, key.endpointId) : eq(nodeVpnEndpoints.ordinal, 1),
    )).where(eq(nodes.id, key.nodeId)).limit(1);
    return {
      endpoint: levels?.endpointId
        ? { awgGenerator: levels.endpointAwgGenerator, awgMtu: levels.endpointAwgMtu, awgDeviceRules: levels.endpointDeviceRules }
        : null,
      node: levels ? { awgGenerator: levels.nodeAwgGenerator, awgMtu: levels.nodeAwgMtu } : null,
    };
  };

  /**
   * The probe's sample key for a node's parameters view: the service account's
   * newest unrevoked AWG 3.1 key on the node (the key the probe measures), with
   * only the address (when named) and node levels resolved, as the probe does.
   * Null without such an active key, or when the address is not the node's.
   */
  findServiceKeyConfig = async (
    nodeId: string,
    endpointId: string | null,
  ): Promise<ServiceKeyConfig | null> => {
    if (!UUID_PATTERN.test(nodeId) || (endpointId !== null && !UUID_PATTERN.test(endpointId))) return null;
    return this.options.db.transaction(async (db) => {
      const [key] = await db
        .select({
          id: vpnKeys.id,
          state: vpnKeys.state,
          configCiphertext: vpnKeys.configCiphertext,
          configNonce: vpnKeys.configNonce,
          configAuthTag: vpnKeys.configAuthTag,
          configKeyVersion: vpnKeys.configKeyVersion,
          awgClientProfile: vpnKeys.awgClientProfile,
        })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(and(
          eq(users.serviceAccount, true),
          eq(vpnKeys.nodeId, nodeId),
          eq(vpnKeys.protocol, "awg3"),
          notInArray(vpnKeys.state, ["revoked", "revoking"]),
        ))
        .orderBy(desc(vpnKeys.createdAt), desc(vpnKeys.id))
        .limit(1);
      if (
        !key ||
        key.state !== "active" ||
        !key.configCiphertext ||
        !key.configNonce ||
        !key.configAuthTag ||
        key.configKeyVersion === null
      ) {
        return null;
      }
      const [node] = await db.select({ awgGenerator: nodes.awgGenerator, awgMtu: nodes.awgMtu })
        .from(nodes).where(eq(nodes.id, nodeId)).limit(1);
      if (!node) return null;
      let address: { awgGenerator: AwgGeneratorSettings | null; awgMtu: number | null } | null = null;
      if (endpointId !== null) {
        [address = null] = await db
          .select({ awgGenerator: nodeVpnEndpoints.awgGenerator, awgMtu: nodeVpnEndpoints.awgMtu })
          .from(nodeVpnEndpoints)
          .where(and(eq(nodeVpnEndpoints.id, endpointId), eq(nodeVpnEndpoints.nodeId, nodeId)))
          .limit(1);
        if (!address) return null;
      }
      return {
        keyId: key.id,
        encrypted: {
          ciphertext: key.configCiphertext,
          nonce: key.configNonce,
          authTag: key.configAuthTag,
          keyVersion: key.configKeyVersion,
        },
        protocol: "awg3",
        awgClientProfile: key.awgClientProfile ?? null,
        settings: resolveAwgClientSettings({ address, node }),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  };

  enqueueOwnRotate = async (actor: Actor, keyId: string): Promise<void> => {
    await this.options.db.transaction(async (tx) => {
      const [key] = await tx
        .select({
          routeProfile: vpnKeys.routeProfile,
          state: vpnKeys.state,
        })
        .from(vpnKeys)
        .where(and(eq(vpnKeys.id, keyId), eq(vpnKeys.ownerId, actor.id)))
        .limit(1)
        .for("update");
      if (!key) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
      // Rotation replaces the peer with fresh key material and current rules.
      // It only makes sense for rule-based profiles; a full-tunnel key never
      // needs new rules. This guard is specific to THIS reason to rotate --
      // `renameOwnKey` below rotates for a different reason (forcing a config
      // that shows a stale name to stop working) that applies to every
      // profile, and calls `queueKeyRotate` directly without it.
      if (key.routeProfile === "full_tunnel") {
        throw new ApiError(
          400,
          "Rotation applies only to rule-based route profiles",
          "ROTATION_NOT_APPLICABLE",
        );
      }
      await this.queueKeyRotate(
        tx,
        actor,
        keyId,
        key.state,
        "vpn_key.rotate_requested",
      );
    });
  };

  /**
   * Rename the caller's own key. The label is always written; a re-issue is
   * queued only when the rename actually changes the connection name the
   * client shows -- computed with the same `composeKeyDisplayName` the
   * exported config uses, fed this key's own `nameDisplay` flags.
   *
   * Why a rename needs a rotate at all: the client-visible name is composed
   * fresh into every export (`defaultService.ts`'s `getKeyConfig`), so the
   * NEXT download already carries a plain label update -- no re-issue
   * required for that. What a plain label update does NOT do is touch a
   * config the owner already downloaded and imported: that file keeps
   * working, under the OLD name, forever. Re-issuing replaces the peer, so
   * that stale file stops connecting and the owner is pushed to fetch the one
   * with the new name -- which is the whole point of the confirmation the
   * panel shows before this runs.
   *
   * And why that rotate is skipped when the composed name does not change:
   * if the label is not part of the display (`nameDisplay.label` off), or the
   * new text composes to the same string as the old one, no exported config
   * would differ either way. Forcing a working connection to break for a
   * config that would look identical has no honest justification, so this
   * stays a plain update in that case -- same as `enqueueOwnRotate` already
   * declining to rotate a `full_tunnel` key for a reason that does not apply
   * to it.
   */
  renameOwnKey = async (
    actor: Actor,
    keyId: string,
    deviceLabel: string,
  ): Promise<{ id: string; state: KeyState; reissued: boolean }> => {
    return this.options.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          state: vpnKeys.state,
          deviceLabel: vpnKeys.deviceLabel,
          keyNumber: vpnKeys.keyNumber,
          nameShowNode: vpnKeys.nameShowNode,
          nameShowLabel: vpnKeys.nameShowLabel,
          nameShowNumber: vpnKeys.nameShowNumber,
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
        })
        .from(vpnKeys)
        .where(and(eq(vpnKeys.id, keyId), eq(vpnKeys.ownerId, actor.id)))
        .limit(1)
        .for("update");
      if (!row) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
      const [serverMeta] = await tx
        .select({
          nodeName: nodes.name,
          nodePublicName: nodes.publicName,
          endpointName: nodeVpnEndpoints.name,
        })
        .from(nodes)
        .leftJoin(
          nodeVpnEndpoints,
          row.endpointId
            ? and(
                eq(nodeVpnEndpoints.nodeId, nodes.id),
                eq(nodeVpnEndpoints.id, row.endpointId),
              )
            : and(
                eq(nodeVpnEndpoints.nodeId, nodes.id),
                eq(nodeVpnEndpoints.ordinal, 1),
              ),
        )
        .where(eq(nodes.id, row.nodeId))
        .limit(1);
      if (!serverMeta) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");

      const display = {
        server: row.nameShowNode,
        label: row.nameShowLabel,
        number: row.nameShowNumber,
      };
      const serverName =
        serverMeta.endpointName ?? serverMeta.nodePublicName ?? serverMeta.nodeName;
      const before = composeKeyDisplayName({
        serverName,
        label: row.deviceLabel,
        keyNumber: row.keyNumber,
        display,
      });
      const after = composeKeyDisplayName({
        serverName,
        label: deviceLabel,
        keyNumber: row.keyNumber,
        display,
      });
      const displayChanged = before !== after;

      await tx
        .update(vpnKeys)
        .set({ deviceLabel, updatedAt: new Date() })
        .where(eq(vpnKeys.id, keyId));

      if (!displayChanged) {
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_key.renamed",
          targetType: "vpn_key",
          targetId: keyId,
          metadata: { deviceLabel, reissued: false },
        });
        return { id: keyId, state: row.state, reissued: false };
      }

      await this.queueKeyRotate(tx, actor, keyId, row.state, "vpn_key.renamed", {
        deviceLabel,
        reissued: true,
      });
      return { id: keyId, state: "provisioning", reissued: true };
    });
  };

  listQuotaRequests = async (actor: Actor): Promise<unknown[]> => {
    const rows = await this.options.db
      .select({
        request: quotaRequests,
        nodeName: nodes.name,
        nodePublicName: nodes.publicName,
      })
      .from(quotaRequests)
      .leftJoin(nodes, eq(nodes.id, quotaRequests.nodeId))
      .where(eq(quotaRequests.userId, actor.id))
      .orderBy(desc(quotaRequests.createdAt));
    // Users see the node's public name only; the internal admin name never
    // leaves this method. Null nodeName = the request targets every server.
    return rows.map(({ request, nodeName, nodePublicName }) => ({
      ...request,
      nodeName: request.nodeId ? (nodePublicName ?? nodeName) : null,
    }));
  };

  createQuotaRequest = async (
    actor: Actor,
    request: QuotaRequest,
  ): Promise<{ id: string; status: string }> => {
    const targetNodeId = request.nodeId ?? null;
    try {
      return await this.options.db.transaction(async (tx) => {
        let targetNodeName: string | null = null;
        if (targetNodeId) {
          // A per-server request may only name a server this user can actually
          // use, checked inside the transaction so it cannot race a node being
          // disabled or removed.
          const [node] = await tx
            .select({ id: nodes.id, name: nodes.name, enabled: nodes.enabled })
            .from(nodes)
            .where(eq(nodes.id, targetNodeId))
            .limit(1);
          if (!node || !node.enabled) {
            throw new ApiError(400, "Node not found", "NODE_NOT_FOUND");
          }
          targetNodeName = node.name;
          const [user] = await tx
            .select({ policyOverride: users.policyOverride })
            .from(users)
            .where(eq(users.id, actor.id))
            .limit(1);
          const globalPolicy = (
            await tx.select().from(portalPolicy).limit(1)
          )[0];
          const policy = resolvePortalPolicy(
            toPolicy(globalPolicy),
            user?.policyOverride,
          );
          if (!isNodeAvailable(policy.allowedNodeIds, targetNodeId)) {
            throw new ApiError(
              403,
              "Selected node is not available",
              "NODE_NOT_ALLOWED",
            );
          }
          // In global mode a request has no server: the number is the pool.
          // Refuse rather than silently widen the ask to every server.
          if (policy.keyLimitMode === "global") {
            throw new ApiError(
              400,
              "Per-server requests are not accepted while the key limit is shared",
              "NODE_TARGET_NOT_APPLICABLE",
            );
          }
        }
        // A new request supersedes the user's still-pending one (if any) — the
        // latest ask replaces the stale one instead of being rejected, whatever
        // the old one targeted.
        await tx
          .update(quotaRequests)
          .set({
            status: "cancelled",
            reviewNote: "superseded by a newer request",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(quotaRequests.userId, actor.id),
              eq(quotaRequests.status, "pending"),
            ),
          );
        const [created] = await tx
          .insert(quotaRequests)
          .values({
            userId: actor.id,
            requestedLimit: request.requestedLimit,
            nodeId: targetNodeId,
            reason: request.reason ?? "",
          })
          .returning({
            id: quotaRequests.id,
            status: quotaRequests.status,
            createdAt: quotaRequests.createdAt,
          });
        if (!created) throw new Error("Quota request insert returned no row");
        // Nobody is told about a new request otherwise: the worker sends this
        // to the operator's Telegram chat, or drops it when none is set up.
        const notifyPayload: QuotaRequestNotifyPayload = {
          quotaRequestId: created.id,
          email: actor.email,
          displayName: actor.displayName,
          requestedLimit: request.requestedLimit,
          nodeName: targetNodeName,
          reason: request.reason ?? "",
          createdAt: created.createdAt.toISOString(),
        };
        await tx.insert(jobOutbox).values({
          type: QUOTA_REQUEST_NOTIFY_JOB_TYPE,
          deduplicationKey: `${QUOTA_REQUEST_NOTIFY_JOB_TYPE}:${created.id}`,
          payload: notifyPayload,
        });
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "quota_request.created",
          targetType: "quota_request",
          targetId: created.id,
          metadata: {
            requestedLimit: request.requestedLimit,
            nodeId: targetNodeId,
          },
        });
        return { id: created.id, status: created.status };
      });
    } catch (error) {
      // Safety net for a concurrent double-submit racing the supersede above.
      // Matched by constraint name, not by drizzle's "Failed query" message -
      // the partial index's name never appears in that message.
      if (isUniqueViolation(error, "quota_requests_one_pending_per_user")) {
        throw new ApiError(
          409,
          "A pending quota request already exists",
          "PENDING_QUOTA_REQUEST_EXISTS",
        );
      }
      throw error;
    }
  };

  getAdminOverview = async (): Promise<Record<string, unknown>> => {
    const db = this.options.db;
    const [
      pending,
      byState,
      byProtocol,
      byProfile,
      userCount,
      usersByStatus,
      nodeRows,
      peerAgg,
      bridgesSummary,
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(quotaRequests)
        .where(eq(quotaRequests.status, "pending")),
      // Every key and user count below is about people: the probe's service
      // account and its keys are kept out (see notServiceAccount in @amnezia/db).
      db
        .select({ key: vpnKeys.state, value: count() })
        .from(vpnKeys)
        .innerJoin(users, keyOwnerIsPerson(vpnKeys))
        .groupBy(vpnKeys.state),
      db
        .select({ key: vpnKeys.protocol, value: count() })
        .from(vpnKeys)
        .innerJoin(users, keyOwnerIsPerson(vpnKeys))
        .groupBy(vpnKeys.protocol),
      db
        .select({ key: vpnKeys.routeProfile, value: count() })
        .from(vpnKeys)
        .innerJoin(users, keyOwnerIsPerson(vpnKeys))
        .groupBy(vpnKeys.routeProfile),
      db.select({ value: count() }).from(users).where(notServiceAccount),
      db
        .select({ key: users.status, value: count() })
        .from(users)
        .where(notServiceAccount)
        .groupBy(users.status),
      db
        .select({ enabled: nodes.enabled, lastError: nodes.lastError })
        .from(nodes),
      db
        .select({
          online: sql<number>`count(*) filter (where ${peerCurrent.online} and ${vpnKeys.state} = 'active')`,
          received: sum(peerCurrent.receivedBytes),
          sent: sum(peerCurrent.sentBytes),
        })
        .from(peerCurrent)
        .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
        .innerJoin(users, keyOwnerIsPerson(vpnKeys)),
      // Bridges are not VPN nodes: they get their own block and never count
      // toward the node counters below.
      this.bridges.overviewBridges(),
    ]);

    const tally = (rows: Array<{ key: string; value: number }>) =>
      Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const stateCounts = tally(byState);
    const statusCounts = tally(usersByStatus);
    const totalKeys = byState.reduce((acc, row) => acc + row.value, 0);
    const received = BigInt(peerAgg[0]?.received ?? 0);
    const sent = BigInt(peerAgg[0]?.sent ?? 0);
    const traffic = received + sent;

    return {
      // Preserved for the existing metric cards
      pendingQuotaRequests: pending[0]?.value ?? 0,
      activeKeys: stateCounts.active ?? 0,
      enabledNodes: nodeRows.filter((node) => node.enabled).length,
      // Richer aggregates
      totalKeys,
      totalUsers: userCount[0]?.value ?? 0,
      usersByStatus: statusCounts,
      activeUsers: statusCounts.active ?? 0,
      disabledUsers: statusCounts.disabled ?? 0,
      onlineDevices: Number(peerAgg[0]?.online ?? 0),
      totalTrafficBytes: traffic.toString(),
      totalReceivedBytes: received.toString(),
      totalSentBytes: sent.toString(),
      keysByState: stateCounts,
      keysByProtocol: tally(byProtocol),
      keysByProfile: tally(byProfile),
      nodes: {
        total: nodeRows.length,
        enabled: nodeRows.filter((node) => node.enabled).length,
        healthy: nodeRows.filter((node) => node.enabled && !node.lastError)
          .length,
      },
      ...(bridgesSummary ? { bridges: bridgesSummary } : {}),
    };
  };

  /** The admin nodes list (`GET /api/admin/nodes`), also read by the infrastructure view. */
  private listAdminNodes = async () => {
    const nodeRows = await this.options.db
      .select({
        id: nodes.id,
        name: nodes.name,
        publicName: nodes.publicName,
        apiBaseUrl: nodes.apiBaseUrl,
        enabled: nodes.enabled,
        protocol: nodes.protocol,
        enabledProtocols: nodes.enabledProtocols,
        maxPeers: nodes.maxPeers,
        checksEnabled: nodes.checksEnabled,
        disabledCheckIds: nodes.disabledCheckIds,
        reachabilityEnabled: nodes.reachabilityEnabled,
        capabilities: nodes.capabilities,
        // Where clients reach the node, as reported by its agent and
        // resolved by the worker; null until the first poll of an agent
        // that reports it. Admins get the full pair plus the diagnostic
        // timestamp — users get at most the collapsed string in listNodes.
        publicHost: nodes.publicHost,
        publicIp: nodes.publicIp,
        publicIpResolvedAt: nodes.publicIpResolvedAt,
        lastHealthAt: nodes.lastHealthAt,
        lastSyncAt: nodes.lastSyncAt,
        lastError: nodes.lastError,
        // What the agent reported it is, cached by the telemetry poll.
        // Null means "not known" — never polled yet, or an agent older than
        // 1.1.14, which does not report the field.
        agentVersion: nodes.agentVersion,
        // The node's own view of its last agent update, mirrored by the
        // telemetry poll. The log is what explains a failure without anyone
        // opening an SSH session.
        agentUpdateState: nodes.agentUpdateState,
        agentUpdateImage: nodes.agentUpdateImage,
        agentUpdateMessage: nodes.agentUpdateMessage,
        agentUpdateLog: nodes.agentUpdateLog,
        agentUpdateAt: nodes.agentUpdateAt,
        // Same again for the last capacity change: the state drives the
        // card's control, and the log is why a change failed.
        capacityState: nodes.capacityState,
        capacityRequestedPeers: nodes.capacityRequestedPeers,
        capacityMessage: nodes.capacityMessage,
        capacityLog: nodes.capacityLog,
        capacityAt: nodes.capacityAt,
        ipv6RejectStubEnabled: nodes.ipv6RejectStubEnabled,
        ipv6RejectStubPrefix: nodes.ipv6RejectStubPrefix,
        ipv6RejectStubState: nodes.ipv6RejectStubState,
        ipv6RejectStubReason: nodes.ipv6RejectStubReason,
        ipv6RejectStubObservedAt: nodes.ipv6RejectStubObservedAt,
        egressMode: nodes.egressMode,
        egressModeState: nodes.egressModeState,
        egressModeMessage: nodes.egressModeMessage,
        egressModeAt: nodes.egressModeAt,
        egressDaemonVersion: nodes.egressDaemonVersion,
        egressDaemonState: nodes.egressDaemonState,
        egressDaemonDetail: nodes.egressDaemonDetail,
        egressBlockSmtp: nodes.egressBlockSmtp,
        egressIsolatePrivate: nodes.egressIsolatePrivate,
        egressDefaultIpId: nodes.egressDefaultIpId,
        hostNetworkReport: nodes.hostNetworkReport,
        egressObservedAt: nodes.egressObservedAt,
        awgGenerator: nodes.awgGenerator,
        awgMtu: nodes.awgMtu,
        keyUpdateNotifiedAt: nodes.keyUpdateNotifiedAt,
        keyUpdateNotifyNote: nodes.keyUpdateNotifyNote,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .orderBy(nodes.name);
    // peerCount includes the probe's keys -- each one occupies a real peer
    // slot on the node -- and probeKeyCount says how many of them there
    // are, so the two can be told apart. Same state set for both, so
    // probeKeyCount is always a subset of peerCount.
    const slotRows = await this.options.db
      .select({
        nodeId: vpnKeys.nodeId,
        value: count(),
        // A raw fragment gets no type parser; cast in SQL and coerce below.
        probe: sql<unknown>`(count(*) filter (where ${users.serviceAccount}))::int`,
      })
      .from(vpnKeys)
      .innerJoin(users, eq(users.id, vpnKeys.ownerId))
      .where(inArray(vpnKeys.state, quotaStates))
      .groupBy(vpnKeys.nodeId);
    const peerCounts = new Map(
      slotRows.map((row) => [row.nodeId, row.value]),
    );
    const probeKeyCounts = new Map(
      slotRows.map((row) => [row.nodeId, Number(row.probe)]),
    );
    // Per-node traffic for Today / 7 days / Month (across all users) so each
    // server row shows all three inline.
    const nodeTraffic = new Map(
      (await this.nodeTrafficPeriods({})).map((row) => [row.nodeId, row]),
    );
    const emptyPair = { receivedBytes: "0", sentBytes: "0" };
    // The release the panel currently offers, resolved by the worker. There
    // is at most one repository configured, so the newest row is it. Absent
    // means "cannot resolve the current image" and the button stays off -
    // never a fall back to a tag, which is the mutable reference the node's
    // preflight refuses.
    const [release] = await this.options.db
      .select()
      .from(nodeAgentReleases)
      .orderBy(desc(nodeAgentReleases.resolvedAt))
      .limit(1);
    // Host metrics as of the last poll, and the newest peer handshake on
    // each node. The handshake is the ONLY honest reachability signal the
    // panel has: it cannot probe a node's public endpoint (AWG answers no
    // unauthenticated UDP, and the worker container has no CAP_NET_RAW), so
    // a real user's connection succeeding is the evidence. It can only
    // under-report, never over-report.
    const [metricsRows, handshakeRows, publicEndpoints, egressIpsByNode, onlinePeerRows, endpointKeyRows] = await Promise.all([
      this.options.db.select().from(nodeMetricsCurrent),
      this.options.db
        .select({
          nodeId: vpnKeys.nodeId,
          // Typed as unknown on purpose: a raw fragment gets no type parser, and
          // claiming Date here is what produced a 500 on every admin
          // node listing with a peer. `toDate` below is the only place
          // that decides what this value is.
          latestHandshakeAt: sql<unknown>`max(${peerCurrent.latestHandshakeAt})`,
        })
        .from(peerCurrent)
        .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
        // The probe's own handshakes would make every node it reaches look
        // reachable to people; only a person's connection is evidence here.
        .innerJoin(users, keyOwnerIsPerson(vpnKeys))
        .groupBy(vpnKeys.nodeId),
      this.loadNodePublicEndpoints(nodeRows.map((row) => row.id)),
      this.loadNodeEgressIpsMap(nodeRows.map((row) => row.id)),
      // Online person-owned peers (180s window from node-agent's peer_current.online),
      // excluding probe service accounts, used for topology counters across node/entry/exit.
      this.options.db
        .select({
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
          protocol: vpnKeys.protocol,
        })
        .from(peerCurrent)
        .innerJoin(vpnKeys, eq(vpnKeys.id, peerCurrent.keyId))
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(
          and(
            eq(peerCurrent.online, true),
            eq(vpnKeys.state, "active"),
            eq(users.serviceAccount, false),
          ),
        ),
      this.options.db
        .select({
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
          state: vpnKeys.state,
        })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(and(inArray(vpnKeys.state, quotaStates), eq(users.serviceAccount, false))),
    ]);
    // Byte counters leave as decimal STRINGS, the way every other byte
    // counter in this API does. They are `bigint` in the column and drizzle
    // hands back a JS BigInt, which JSON.stringify refuses outright - a 500
    // on the whole admin nodes page, which is what shipped in v0.9.6. The
    // web and CLI types already declared these as strings; only the
    // repository disagreed, and `adminList` returns `unknown` so nothing
    // typed the gap.
    const metricsByNode = new Map(
      metricsRows.map((row) => [row.nodeId, toMetricsPayload(row)]),
    );
    // Coerced, not trusted. `max(...)` goes through a raw `sql` fragment, so
    // drizzle applies no type parser and postgres-js hands back a STRING -
    // declaring the column as Date made it look like one and .getTime()
    // threw on every admin node listing that had a peer. The integration
    // test missed it because its node had no peers, so the only branch that
    // could throw was the one never taken.
    const toDate = (value: unknown): Date | null => {
      if (value instanceof Date) return value;
      if (typeof value !== "string" && typeof value !== "number") return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const handshakeByNode = new Map(
      handshakeRows.map((row) => [row.nodeId, toDate(row.latestHandshakeAt)]),
    );
    const availableAgent = release
      ? {
          repository: release.repository,
          version: release.version,
          image: `${release.repository}@${release.digest}`,
          resolvedAt: release.resolvedAt,
        }
      : null;

    // Build topology online counters per node, endpoint, and exit IP.
    type ProtoBucket = { total: number; byProtocol: Record<string, number> };
    const bumpBucket = (map: Map<string, ProtoBucket>, id: string, protocol: string) => {
      const bucket = map.get(id) ?? { total: 0, byProtocol: {} };
      bucket.total += 1;
      bucket.byProtocol[protocol] = (bucket.byProtocol[protocol] ?? 0) + 1;
      map.set(id, bucket);
    };
    const nodeById = new Map(nodeRows.map((n) => [n.id, n]));
    const primaryEndpointByNode = new Map<string, AdminNodeEndpoint>();
    const endpointById = new Map<string, AdminNodeEndpoint>();
    for (const [nId, eps] of publicEndpoints) {
      for (const ep of eps) {
        endpointById.set(ep.id, ep);
        if (ep.ordinal === 1 || !primaryEndpointByNode.has(nId)) {
          if (ep.ordinal === 1) primaryEndpointByNode.set(nId, ep);
        }
      }
      if (!primaryEndpointByNode.has(nId) && eps[0]) {
        primaryEndpointByNode.set(nId, eps[0]);
      }
    }
    const onlineByNode = new Map<string, ProtoBucket>();
    const onlineByEndpoint = new Map<string, ProtoBucket>();
    const onlineByEgressIp = new Map<string, ProtoBucket>();
    for (const peer of onlinePeerRows) {
      bumpBucket(onlineByNode, peer.nodeId, peer.protocol);
      const nodeRow = nodeById.get(peer.nodeId);
      const { endpoint: ep, exitIp } = resolveEffectiveKeyAttachment({
        protocol: peer.protocol,
        endpointId: peer.endpointId,
        endpointsById: endpointById,
        primaryEndpoint: primaryEndpointByNode.get(peer.nodeId),
        nodePublicIp: nodeRow?.publicIp ?? null,
        nodeEgressMode: nodeRow?.egressMode ?? null,
        nodeEgressDefaultIpId: nodeRow?.egressDefaultIpId ?? null,
        nodeEgressIps: egressIpsByNode.get(peer.nodeId) ?? [],
      });
      if (ep) {
        bumpBucket(onlineByEndpoint, ep.id, peer.protocol);
      }
      if (exitIp) {
        bumpBucket(onlineByEgressIp, exitIp.id, peer.protocol);
      }
    }
    const assignedByEndpoint = new Map<string, number>();
    const activeByEndpoint = new Map<string, number>();
    for (const k of endpointKeyRows) {
      const ep =
        (k.endpointId ? endpointById.get(k.endpointId) : undefined) ??
        primaryEndpointByNode.get(k.nodeId);
      if (!ep) continue;
      assignedByEndpoint.set(ep.id, (assignedByEndpoint.get(ep.id) ?? 0) + 1);
      if (k.state === "active") {
        activeByEndpoint.set(ep.id, (activeByEndpoint.get(ep.id) ?? 0) + 1);
      }
    }

    const now = Date.now();
    return nodeRows.map((row) => {
      const observedMode =
        row.hostNetworkReport &&
        typeof row.hostNetworkReport === "object" &&
        "observedMode" in row.hostNetworkReport
          ? (row.hostNetworkReport as { observedMode?: unknown }).observedMode
          : undefined;
      const modeDrift =
        (observedMode === "masquerade" || observedMode === "routed") &&
        observedMode !== row.egressMode;
      const nodeOnline = onlineByNode.get(row.id);
      const enrichedEndpoints = (publicEndpoints.get(row.id) ?? []).map((ep) => {
        const epOnline = onlineByEndpoint.get(ep.id);
        return {
          ...ep,
          onlinePeerCount: epOnline?.total ?? 0,
          onlineByProtocol: epOnline?.byProtocol ?? {},
          assignedKeyCount: assignedByEndpoint.get(ep.id) ?? 0,
          activeKeyCount: activeByEndpoint.get(ep.id) ?? 0,
        };
      });
      const enrichedEgressIps = (egressIpsByNode.get(row.id) ?? []).map((ip) => {
        const ipOnline = onlineByEgressIp.get(ip.id);
        return {
          ...ip,
          onlinePeerCount: ipOnline?.total ?? 0,
          onlineByProtocol: ipOnline?.byProtocol ?? {},
        };
      });
      return {
        ...row,
        keyUpdateNotifiedAt: row.keyUpdateNotifiedAt?.toISOString() ?? null,
        keyUpdateNotifyNote: row.keyUpdateNotifyNote ?? null,
        publicEndpoints: enrichedEndpoints,
        egressIps: enrichedEgressIps,
        modeDrift,
        availableAgent,
      metrics: metricsByNode.get(row.id) ?? null,
      endpoint: {
        // Stated as "last handshake N minutes ago", never as a probe result.
        // ONLINE_THRESHOLD_SECONDS is 180 in the node-agent's own contract.
        status: (() => {
          const last = handshakeByNode.get(row.id) ?? null;
          if (last === null) return "unknown";
          return now - last.getTime() <= 180_000 ? "reachable" : "stale";
        })(),
        lastHandshakeAt: handshakeByNode.get(row.id) ?? null,
      },
      peerCount: peerCounts.get(row.id) ?? 0,
      probeKeyCount: probeKeyCounts.get(row.id) ?? 0,
      onlinePeerCount: nodeOnline?.total ?? 0,
      onlineByProtocol: nodeOnline?.byProtocol ?? {},
      traffic: {
        today: nodeTraffic.get(row.id)?.today ?? emptyPair,
        week: nodeTraffic.get(row.id)?.week ?? emptyPair,
        month: nodeTraffic.get(row.id)?.month ?? emptyPair,
      },
      supportedProtocols: deriveSupportedProtocols(
        row.protocol,
        row.capabilities,
      ),
      ipv6RejectStub: {
        enabled: row.ipv6RejectStubEnabled,
        prefix: row.ipv6RejectStubPrefix,
        state: row.ipv6RejectStubState,
        reason: row.ipv6RejectStubReason,
        observedAt: row.ipv6RejectStubObservedAt
          ? row.ipv6RejectStubObservedAt.toISOString()
          : null,
      },
    };
    });
  };

  adminList = async (_actor: Actor, resource: string): Promise<unknown> => {
    switch (resource) {
      case "users":
        // Every column, so the admin UI sees keyLimitOverride, nodeKeyLimits
        // and policyOverride (which carries allowedNodeIds) in one round trip.
        // The probe's service account is managed by the panel, not an admin.
        return this.options.db
          .select()
          .from(users)
          .where(notServiceAccount)
          .orderBy(users.email);
      case "keys": {
        const endpointEgress = alias(nodeEgressIps, "admin_key_endpoint_egress");
        const defaultEgress = alias(nodeEgressIps, "admin_key_default_egress");
        const [globalPolicyRow, rows] = await Promise.all([
          this.options.db.select().from(portalPolicy).limit(1),
          this.options.db
            .select({
              id: vpnKeys.id,
              ownerId: vpnKeys.ownerId,
              nodeId: vpnKeys.nodeId,
              endpointId: vpnKeys.endpointId,
              endpointName: nodeVpnEndpoints.name,
              endpointAddress: nodeVpnEndpoints.address,
              endpointBridgeMode: nodeVpnEndpoints.bridgeMode,
              publicKey: vpnKeys.publicKey,
              tunnelIpv4: vpnKeys.tunnelIpv4,
              protocol: vpnKeys.protocol,
              state: vpnKeys.state,
              deviceType: vpnKeys.deviceType,
              deviceLabel: vpnKeys.deviceLabel,
              // Operator-only. This is the ONE projection that carries it: the
              // owner-facing `listKeys` and `findKeyConfig` both list their
              // columns explicitly and must keep leaving it out.
              internalName: vpnKeys.internalName,
              keyNumber: vpnKeys.keyNumber,
              nameShowNode: vpnKeys.nameShowNode,
              nameShowLabel: vpnKeys.nameShowLabel,
              nameShowNumber: vpnKeys.nameShowNumber,
              routeProfile: vpnKeys.routeProfile,
              routeRuleVersionId: vpnKeys.routeRuleVersionId,
              bridgeMode: vpnKeys.bridgeMode,
              vpnBridgeRouteId: vpnKeys.vpnBridgeRouteId,
              ownerPolicyOverride: users.policyOverride,
              nodePublicIp: nodes.publicIp,
              nodeEgressMode: nodes.egressMode,
              endpointEgressIpv4: endpointEgress.ipv4,
              endpointEgressLabel: endpointEgress.label,
              endpointEgressDns1: endpointEgress.dnsPrimary,
              endpointEgressDns2: endpointEgress.dnsSecondary,
              defaultEgressIpv4: defaultEgress.ipv4,
              defaultEgressLabel: defaultEgress.label,
              defaultEgressDns1: defaultEgress.dnsPrimary,
              defaultEgressDns2: defaultEgress.dnsSecondary,
              // Admin-only client settings of the key, and the levels its
              // effective profile and MTU are resolved from.
              awgGenerator: vpnKeys.awgGenerator,
              awgMtu: vpnKeys.awgMtu,
              ownerAwgGenerator: users.awgGenerator,
              ownerAwgMtu: users.awgMtu,
              ownerDeviceRules: users.awgDeviceRules,
              endpointAwgGenerator: nodeVpnEndpoints.awgGenerator,
              endpointAwgMtu: nodeVpnEndpoints.awgMtu,
              endpointDeviceRules: nodeVpnEndpoints.awgDeviceRules,
              nodeAwgGenerator: nodes.awgGenerator,
              nodeAwgMtu: nodes.awgMtu,
              lastUsedAt: vpnKeys.lastUsedAt,
              revokedAt: vpnKeys.revokedAt,
              failureReason: vpnKeys.failureReason,
              createdAt: vpnKeys.createdAt,
              updatedAt: vpnKeys.updatedAt,
              configUpdatedAt: vpnKeys.configUpdatedAt,
              online: peerCurrent.online,
              receivedBytes: peerCurrent.receivedBytes,
              sentBytes: peerCurrent.sentBytes,
              // Read only to tell a bridged device from a direct one; the
              // address itself never leaves this function.
              peerEndpoint: peerCurrent.endpoint,
            })
            .from(vpnKeys)
            .innerJoin(users, keyOwnerIsPerson(vpnKeys))
            .leftJoin(nodes, eq(nodes.id, vpnKeys.nodeId))
            .leftJoin(nodeVpnEndpoints, keyEndpointJoin)
            .leftJoin(endpointEgress, eq(endpointEgress.id, nodeVpnEndpoints.egressIpId))
            .leftJoin(defaultEgress, eq(defaultEgress.id, nodes.egressDefaultIpId))
            .leftJoin(peerCurrent, eq(peerCurrent.keyId, vpnKeys.id))
            .orderBy(desc(vpnKeys.createdAt)),
        ]);
        const basePolicy = toPolicy(globalPolicyRow[0]);
        const bridgeRoutes = await this.loadKeyBridgeRoutes(
          rows.map((row) => row.nodeId),
          rows
            .map((row) => row.vpnBridgeRouteId)
            .filter((id): id is string => id !== null),
        );
        return rows.map(
          ({
            receivedBytes,
            sentBytes,
            online,
            nameShowNode,
            nameShowLabel,
            nameShowNumber,
            bridgeMode,
            endpointBridgeMode,
            vpnBridgeRouteId,
            ownerPolicyOverride,
            peerEndpoint,
            ownerAwgGenerator,
            ownerAwgMtu,
            ownerDeviceRules,
            endpointAwgGenerator,
            endpointAwgMtu,
            endpointDeviceRules,
            nodeAwgGenerator,
            nodeAwgMtu,
            nodePublicIp,
            nodeEgressMode,
            endpointAddress,
            endpointEgressIpv4,
            endpointEgressLabel,
            endpointEgressDns1,
            endpointEgressDns2,
            defaultEgressIpv4,
            defaultEgressLabel,
            defaultEgressDns1,
            defaultEgressDns2,
            ...row
          }) => {
            const ownerPolicy = resolvePortalPolicy(basePolicy, ownerPolicyOverride);
            const endpointEgress =
              endpointEgressIpv4 !== null
                ? {
                    ipv4: endpointEgressIpv4,
                    label: endpointEgressLabel,
                    dnsPrimary: endpointEgressDns1 ?? "1.1.1.1",
                    dnsSecondary: endpointEgressDns2,
                  }
                : null;
            const defaultEgress =
              defaultEgressIpv4 !== null
                ? {
                    ipv4: defaultEgressIpv4,
                    label: defaultEgressLabel,
                    dnsPrimary: defaultEgressDns1 ?? "1.1.1.1",
                    dnsSecondary: defaultEgressDns2,
                  }
                : null;
            const egress = resolveKeyEgressInfo({
              protocol: row.protocol,
              nodePublicIp,
              nodeEgressMode,
              endpointAddress,
              endpointEgress,
              defaultEgress,
            });
            const levels = {
              key: row,
              owner: { awgGenerator: ownerAwgGenerator, awgMtu: ownerAwgMtu, awgDeviceRules: ownerDeviceRules },
              endpoint: row.endpointName === null ? null : {
                awgGenerator: endpointAwgGenerator, awgMtu: endpointAwgMtu, awgDeviceRules: endpointDeviceRules,
              },
              node: { awgGenerator: nodeAwgGenerator, awgMtu: nodeAwgMtu },
            };
            const settings = resolveKeyClientSettings(levels);
            const manual: readonly string[] = ["key", "userDevice", "user", "device"];
            return {
              ...row,
              // What an AWG 3.1 key's exports are built with and where it
              // comes from; the probe measures only the address and node levels.
              config: row.protocol === "awg3"
                ? {
                    ...settings,
                    probeChecked: !manual.includes(settings.profileFrom ?? "") && !manual.includes(settings.mtuFrom),
                    // Without the key's own settings: what its editor offers to inherit.
                    inherited: resolveKeyClientSettings({
                      ...levels,
                      key: { ...row, awgGenerator: null, awgMtu: null },
                    }),
                  }
                : null,
              // Same shape the owner-facing key list uses, so both views can feed
              // `composeKeyDisplayName` directly.
              nameDisplay: {
                server: nameShowNode,
                label: nameShowLabel,
                number: nameShowNumber,
              },
              bridge: {
                ...resolveKeyBridgeInfo({
                  protocol: row.protocol,
                  bridgeMode,
                  pinnedRouteId: vpnBridgeRouteId,
                  pinnedRoute: vpnBridgeRouteId
                    ? (bridgeRoutes.byRouteId.get(vpnBridgeRouteId) ?? null)
                    : null,
                  activeRoute: bridgeRoutes.activeByNode.get(row.nodeId) ?? null,
                  useBridge: ownerPolicy.useBridge,
                  endpointBridgeMode: endpointBridgeMode ?? undefined,
                }),
                observed: observedKeyPath(peerEndpoint),
              },
              egress,
              online: online ?? false,
              traffic:
                receivedBytes !== null && sentBytes !== null
                  ? {
                      receivedBytes: receivedBytes.toString(),
                      sentBytes: sentBytes.toString(),
                    }
                  : null,
            };
          },
        );
      }
      case "nodes":
        return this.listAdminNodes();
      case "quota-requests": {
        const rows = await this.options.db
          .select({ request: quotaRequests, nodeName: nodes.name })
          .from(quotaRequests)
          .leftJoin(nodes, eq(nodes.id, quotaRequests.nodeId))
          .orderBy(desc(quotaRequests.createdAt));
        // Admins see the internal node name. Null = every-server request.
        return rows.map(({ request, nodeName }) => ({
          ...request,
          nodeName: request.nodeId ? nodeName : null,
        }));
      }
      case "rules": {
        // Everything but the payload. Every version ever fetched is kept, each
        // carries the whole feed (~80k domains), and this list is loaded on
        // every admin page: with the payload it grew past control-api's heap
        // limit. Nothing reading the list uses it -- the preview fetches one
        // version by id (getRuleVersion).
        return this.options.db
          .select({
            id: routeRuleVersions.id,
            profile: routeRuleVersions.profile,
            version: routeRuleVersions.version,
            sourceUrl: routeRuleVersions.sourceUrl,
            sourceEtag: routeRuleVersions.sourceEtag,
            sourceChecksum: routeRuleVersions.sourceChecksum,
            status: routeRuleVersions.status,
            cidrCount: routeRuleVersions.cidrCount,
            domainCount: routeRuleVersions.domainCount,
            validationReport: routeRuleVersions.validationReport,
            publishedAt: routeRuleVersions.publishedAt,
            createdAt: routeRuleVersions.createdAt,
            updatedAt: routeRuleVersions.updatedAt,
            pinnedAt: routeRuleVersions.pinnedAt,
            notifiedAt: routeRuleVersions.notifiedAt,
            notifyNote: routeRuleVersions.notifyNote,
          })
          .from(routeRuleVersions)
          .orderBy(desc(routeRuleVersions.createdAt));
      }
      case "audit":
        return this.options.db
          .select()
          .from(auditEvents)
          .orderBy(desc(auditEvents.createdAt))
          .limit(500);
      case "portal-policy": {
        const rows = await this.options.db.select().from(portalPolicy).limit(1);
        if (rows[0]) {
          const policyRow = rows[0];
          // Same rule as installGuideVideos above: the admin page posts this
          // row straight back, so the read must not emit anything the write
          // refuses. A node id that names no node is inert everywhere it is
          // READ (it matches nothing) but the update's existence check rejects
          // it, which would make the whole policy page unsaveable. deleteNode
          // scrubs both lists, so a stale id means a row was removed
          // out-of-band; dropping it here also means the next save cleans the
          // stored lists up.
          const referenced = [
            ...new Set([
              ...policyRow.recommendedNodeIds,
              ...policyRow.nodeOrder,
            ]),
          ];
          const referencedEndpoints = [
            ...new Set([
              ...policyRow.recommendedEndpointIds,
              ...policyRow.endpointOrder,
              ...(policyRow.allowedEndpointIds ?? []),
            ]),
          ];
          let nextRow = policyRow;
          if (referenced.length > 0) {
            const known = new Set(
              (
                await this.options.db
                  .select({ id: nodes.id })
                  .from(nodes)
                  .where(inArray(nodes.id, referenced))
              ).map((row) => row.id),
            );
            if (known.size !== referenced.length) {
              nextRow = {
                ...nextRow,
                recommendedNodeIds: nextRow.recommendedNodeIds.filter((id) => known.has(id)),
                nodeOrder: nextRow.nodeOrder.filter((id) => known.has(id)),
              };
            }
          }
          if (referencedEndpoints.length > 0) {
            const [knownNodes, knownEndpoints] = await Promise.all([
              this.options.db
                .select({ id: nodes.id })
                .from(nodes)
                .where(inArray(nodes.id, referencedEndpoints)),
              this.options.db
                .select({ id: nodeVpnEndpoints.id })
                .from(nodeVpnEndpoints)
                .where(inArray(nodeVpnEndpoints.id, referencedEndpoints)),
            ]);
            const knownTargets = new Set([
              ...knownNodes.map((row) => row.id),
              ...knownEndpoints.map((row) => row.id),
            ]);
            if (knownTargets.size !== referencedEndpoints.length) {
              nextRow = {
                ...nextRow,
                recommendedEndpointIds: nextRow.recommendedEndpointIds.filter((id) => knownTargets.has(id)),
                endpointOrder: nextRow.endpointOrder.filter((id) => knownTargets.has(id)),
                ...(nextRow.allowedEndpointIds !== null
                  ? { allowedEndpointIds: nextRow.allowedEndpointIds.filter((id) => knownTargets.has(id)) }
                  : {}),
              };
            }
          }
          return [stripPolicySecrets(nextRow)];
        }
        // Fresh install with no row yet: report exactly the contract defaults so
        // the UI cannot show a setting the API would apply differently.
        return [
          {
            id: true,
            ...defaultPortalPolicy,
            allowedNodeIds: defaultPortalPolicy.allowedNodeIds ?? null,
            allowedEndpointIds: defaultPortalPolicy.allowedEndpointIds ?? null,
            recommendedNodeIds: [] as string[],
            nodeOrder: [] as string[],
            recommendedEndpointIds: [] as string[],
            endpointOrder: [] as string[],
            defaultKeyLimit: 5,
            dailyRetentionDays: 730,
            cfAccessAccountId: null,
            cfAccessAppId: null,
            cfAccessPolicyId: null,
            cfAccessAllowedDomains: [] as string[],
            cfApiTokenSet: false,
            // Every worker period unset, which is what the column actually is
            // on a fresh install: null reads as "use the worker's default", and
            // emitting a number here would tell the admin form a period had
            // been chosen when nothing had.
            ...Object.fromEntries(
              WORKER_PERIOD_FIELD_NAMES.map((field) => [field, null]),
            ),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }
      case "service-checks": {
        // Definitions plus every node's latest verdict, joined here rather than
        // fetched per check by the UI: there are single digits of both, and a
        // card that issued one request per check would make the page's cost
        // depend on how many checks an admin had added.
        const [definitions, results, egressResults] = await Promise.all([
          this.options.db
            .select()
            .from(nodeServiceChecks)
            .orderBy(nodeServiceChecks.name),
          this.options.db
            .select({
              checkId: nodeServiceCheckResults.checkId,
              nodeId: nodeServiceCheckResults.nodeId,
              nodeName: nodes.name,
              status: nodeServiceCheckResults.status,
              httpStatus: nodeServiceCheckResults.httpStatus,
              latencyMs: nodeServiceCheckResults.latencyMs,
              detail: nodeServiceCheckResults.detail,
              finalUrl: nodeServiceCheckResults.finalUrl,
              checkedAt: nodeServiceCheckResults.checkedAt,
              failingSince: nodeServiceCheckResults.failingSince,
            })
            .from(nodeServiceCheckResults)
            .innerJoin(nodes, eq(nodes.id, nodeServiceCheckResults.nodeId))
            .orderBy(nodes.name),
          this.options.db
            .select({
              checkId: nodeEgressServiceCheckResults.checkId,
              egressIpId: nodeEgressServiceCheckResults.egressIpId,
              egressIpv4: nodeEgressIps.ipv4,
              egressLabel: nodeEgressIps.label,
              nodeId: nodeEgressIps.nodeId,
              nodeName: nodes.name,
              status: nodeEgressServiceCheckResults.status,
              httpStatus: nodeEgressServiceCheckResults.httpStatus,
              latencyMs: nodeEgressServiceCheckResults.latencyMs,
              detail: nodeEgressServiceCheckResults.detail,
              finalUrl: nodeEgressServiceCheckResults.finalUrl,
              checkedAt: nodeEgressServiceCheckResults.checkedAt,
              failingSince: nodeEgressServiceCheckResults.failingSince,
            })
            .from(nodeEgressServiceCheckResults)
            .innerJoin(nodeEgressIps, eq(nodeEgressIps.id, nodeEgressServiceCheckResults.egressIpId))
            .innerJoin(nodes, eq(nodes.id, nodeEgressIps.nodeId))
            .where(and(eq(nodeEgressIps.enabled, true), eq(nodes.egressMode, "routed")))
            .orderBy(nodes.name, nodeEgressIps.ipv4),
        ]);
        return definitions.map((check) => ({
          ...check,
          results: results.filter((row) => row.checkId === check.id),
          egressResults: egressResults.filter((row) => row.checkId === check.id),
        }));
      }
      case "global-routes":
        return [await this.getGlobalRoutes()];
      default:
        throw new ApiError(404, "Admin resource not found", "NOT_FOUND");
    }
  };

  /**
   * One audit row for a service-check change. These four methods are the only
   * writers of that table's rows, so the helper stays here rather than becoming
   * a general one the rest of the file would have to be rewritten to use.
   */
  private writeAudit = async (
    actor: Actor,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    await this.options.db.insert(auditEvents).values({
      actorUserId: actor.id,
      actorType: "user",
      action: `admin.${action}`,
      targetType: "service_check",
      targetId,
      metadata,
    });
  };

  createServiceCheck = async (
    actor: Actor,
    request: CreateServiceCheckRequest,
  ): Promise<unknown> => {
    const [created] = await this.options.db
      .insert(nodeServiceChecks)
      .values({
        name: request.name,
        probe: request.probe,
        assertions: request.assertions,
        intervalSec: request.intervalSec,
        enabled: request.enabled,
      })
      .returning()
      .catch((error: unknown) => {
        throw duplicateCheckName(error);
      });
    if (!created) throw new ApiError(500, "Check was not created", "CHECK_NOT_CREATED");
    await this.writeAudit(actor, "service_check.create", created.id, {
      name: created.name,
    });
    return created;
  };

  updateServiceCheck = async (
    actor: Actor,
    checkId: string,
    request: UpdateServiceCheckRequest,
  ): Promise<unknown> => {
    // Exactly the keys the caller named. The update schema is built from a
    // DEFAULTLESS shape for this reason: a partial built from the defaulted one
    // would materialise every key and turn "disable this check" into "disable
    // it AND reset its period AND replace its assertions".
    const patch = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.probe === undefined ? {} : { probe: request.probe }),
      ...(request.assertions === undefined
        ? {}
        : { assertions: request.assertions }),
      ...(request.intervalSec === undefined
        ? {}
        : { intervalSec: request.intervalSec }),
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      updatedAt: new Date(),
    };
    const [updated] = await this.options.db
      .update(nodeServiceChecks)
      .set(patch)
      .where(eq(nodeServiceChecks.id, checkId))
      .returning()
      .catch((error: unknown) => {
        throw duplicateCheckName(error);
      });
    if (!updated) throw new ApiError(404, "Check not found", "CHECK_NOT_FOUND");
    await this.writeAudit(actor, "service_check.update", checkId, {
      fields: Object.keys(patch).filter((key) => key !== "updatedAt"),
    });
    return updated;
  };

  deleteServiceCheck = async (
    actor: Actor,
    checkId: string,
  ): Promise<unknown> => {
    const [deleted] = await this.options.db
      .delete(nodeServiceChecks)
      .where(eq(nodeServiceChecks.id, checkId))
      .returning({ id: nodeServiceChecks.id, name: nodeServiceChecks.name });
    if (!deleted) throw new ApiError(404, "Check not found", "CHECK_NOT_FOUND");
    // Results are removed with it by the foreign key: a verdict with no
    // definition is a chip nobody can explain.
    await this.writeAudit(actor, "service_check.delete", checkId, {
      name: deleted.name,
    });
    return { id: deleted.id };
  };

  runServiceCheckNow = async (
    actor: Actor,
    checkId: string,
  ): Promise<unknown> => {
    // A marker, not an execution. The panel cannot reach a node synchronously -
    // it talks to them on the telemetry tick - so this sets the "due" mark and
    // every node whose last result predates it runs the check once. Returning a
    // result here would mean an HTTP request that waits on the whole fleet.
    const now = new Date();
    const [updated] = await this.options.db
      .update(nodeServiceChecks)
      .set({ nextDueAt: now, updatedAt: now })
      .where(eq(nodeServiceChecks.id, checkId))
      .returning({ id: nodeServiceChecks.id, nextDueAt: nodeServiceChecks.nextDueAt });
    if (!updated) throw new ApiError(404, "Check not found", "CHECK_NOT_FOUND");
    await this.writeAudit(actor, "service_check.run", checkId, {});
    return updated;
  };

  resetServiceCheckResults = async (
    actor: Actor,
    checkId: string | null,
  ): Promise<unknown> => {
    // Deleting a result is not losing data - the result IS the schedule, so a
    // check with no result is due on the next tick and measures itself again.
    // That is exactly what an operator needs after changing what a check
    // asserts: the old verdict describes a question nobody is asking any more.
    const deleted = checkId
      ? await this.options.db
          .delete(nodeServiceCheckResults)
          .where(eq(nodeServiceCheckResults.checkId, checkId))
          .returning({ nodeId: nodeServiceCheckResults.nodeId })
      : await this.options.db
          .delete(nodeServiceCheckResults)
          .returning({ nodeId: nodeServiceCheckResults.nodeId });
    const deletedEgress = checkId
      ? await this.options.db
          .delete(nodeEgressServiceCheckResults)
          .where(eq(nodeEgressServiceCheckResults.checkId, checkId))
          .returning({ egressIpId: nodeEgressServiceCheckResults.egressIpId })
      : await this.options.db
          .delete(nodeEgressServiceCheckResults)
          .returning({ egressIpId: nodeEgressServiceCheckResults.egressIpId });
    const cleared = deleted.length + deletedEgress.length;
    await this.writeAudit(
      actor,
      "service_check.reset",
      checkId ?? "all",
      { cleared },
    );
    return { cleared };
  };

  // --- External reachability probe -------------------------------------------
  // One settings row (id = 1) or none. The worker owns everything about a run;
  // the panel only edits the settings, moves the "run now" marker and reads the
  // results the worker stored.

  private toReachabilityProbeView = (
    row: typeof reachabilityProbe.$inferSelect,
    now: Date,
  ): ReachabilityProbeView => ({
    label: row.label,
    apiBaseUrl: row.apiBaseUrl,
    enabled: row.enabled,
    controlUrl: row.controlUrl,
    egressUrl: row.egressUrl,
    intervalSec: row.intervalSec,
    failThreshold: row.failThreshold,
    staleAfterSec: row.staleAfterSec,
    lastResultAt: row.lastResultAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    // The same rule the worker alerts on, so the badge and the message agree.
    stale: isProbeStale({
      now,
      staleAfterSec: row.staleAfterSec,
      intervalSec: row.intervalSec,
      lastResultAt: row.lastResultAt,
      since: row.enabledAt,
    }),
    runInFlight: row.currentRunId !== null,
    // Only while it waits: a run started since then has served it.
    runRequestedAt: row.runRequestedAt !== null &&
      (row.currentRunStartedAt === null || row.runRequestedAt > row.currentRunStartedAt)
      ? row.runRequestedAt.toISOString()
      : null,
    ...(row.requestedRunId === null ? {} : { requestedRunId: row.requestedRunId }),
    timeZone: row.timeZone,
    probeDirectWhenBridged: row.probeDirectWhenBridged,
    stealthMode: row.stealthMode,
    widgetUpdatedAt: row.widgetUpdatedAt?.toISOString() ?? null,
    widgetLastError: row.widgetLastError,
  });

  getReachability = async (_actor: Actor): Promise<AdminReachabilityView> => {
    const db = this.options.db;
    const [probeRows, nodeRows, resultRows, keyRows, bridges] = await Promise.all([
      db.select().from(reachabilityProbe).where(eq(reachabilityProbe.id, 1)),
      // Every registered node, a disabled one included: the probe keeps
      // testing it so that its recovery is noticed.
      db
        .select({
          id: nodes.id,
          name: nodes.name,
          enabled: nodes.enabled,
          reachabilityEnabled: nodes.reachabilityEnabled,
          protocol: nodes.protocol,
          capabilities: nodes.capabilities,
          enabledProtocols: nodes.enabledProtocols,
          state: nodeReachabilityState,
        })
        .from(nodes)
        .leftJoin(
          nodeReachabilityState,
          eq(nodeReachabilityState.nodeId, nodes.id),
        )
        .orderBy(nodes.name),
      db.select().from(nodeReachabilityResults),
      // The newest probe key per (node, protocol). Only the service account's
      // keys: a person's key on the same node says nothing about the probe.
      db
        .selectDistinctOn([vpnKeys.nodeId, vpnKeys.protocol], {
          nodeId: vpnKeys.nodeId,
          protocol: vpnKeys.protocol,
          state: vpnKeys.state,
        })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(eq(users.serviceAccount, true))
        .orderBy(
          vpnKeys.nodeId,
          vpnKeys.protocol,
          desc(vpnKeys.createdAt),
          desc(vpnKeys.id),
        ),
      this.bridges.listReachability(),
    ]);
    const now = new Date();
    const probe = probeRows[0];
    const publicEndpoints = await this.loadNodePublicEndpoints(nodeRows.map((node) => node.id));
    const slot = (nodeId: string, protocol: ProtocolKind): string =>
      `${nodeId}:${protocol}`;
    const results = new Map(
      resultRows.map((row) => [slot(row.nodeId, row.protocol), row]),
    );
    const keyStates = new Map(
      keyRows.map((row) => [slot(row.nodeId, row.protocol), row.state]),
    );
    return {
      probe: probe ? this.toReachabilityProbeView(probe, now) : null,
      bridges,
      nodes: nodeRows.map((node) => {
        // Every protocol the node serves to anyone, without user policy: the
        // shared rule the worker keeps a probe key by.
        const served = nodeServedProtocols(node);
        const endpoints = publicEndpoints.get(node.id);
        const directCheckedAt = node.state?.directCheckedAt ?? null;
        const hasCurrentDirectResult = probe?.enabled && probe.probeDirectWhenBridged &&
          probe.staleAlertedAt === null && node.reachabilityEnabled && directCheckedAt &&
          directCheckedAt >= probe.enabledAt && !isProbeStale({
            now,
            lastResultAt: directCheckedAt,
            staleAfterSec: probe.staleAfterSec,
            intervalSec: probe.intervalSec,
            since: directCheckedAt,
          });
        return {
          nodeId: node.id,
          nodeName: node.name,
          ...(endpoints?.length ? { publicEndpoints: endpoints } : {}),
          nodeEnabled: node.enabled,
          reachabilityEnabled: node.reachabilityEnabled,
          status: node.state?.status ?? null,
          checkedAt: node.state?.checkedAt.toISOString() ?? null,
          failingSince: node.state?.failingSince?.toISOString() ?? null,
          consecutiveFailures: node.state?.consecutiveFailures ?? 0,
          incidentOpen: (node.state?.alertedAt ?? null) !== null,
          detail: node.state?.detail ?? null,
          directStatus: hasCurrentDirectResult ? node.state?.directStatus ?? null : null,
          directCheckedAt: hasCurrentDirectResult ? directCheckedAt.toISOString() : null,
          directDetail: hasCurrentDirectResult ? node.state?.directDetail ?? null : null,
          protocols: served.map((protocol) => {
            const result = results.get(slot(node.id, protocol));
            return {
              protocol,
              status: result?.status ?? null,
              // Written by the worker from a validated probe response, or `{}`
              // when nothing was measured (an `error`). Parsed again so that,
              // like a row in an older shape, reads as "no levels" rather than
              // breaking the whole view.
              levels: result
                ? (probeLevelsSchema.safeParse(result.levels).data ?? null)
                : null,
              egressIp: result?.egressIp ?? null,
              detail: result?.detail ?? null,
              checkedAt: result?.checkedAt.toISOString() ?? null,
              keyState: keyStates.get(slot(node.id, protocol)) ?? null,
            };
          }),
        };
      }),
    };
  };

  getBridgeRotationEvidence = async (_actor: Actor, bridgeId: string): Promise<BridgeRotationEvidence> => {
    // A single statement ties registrations, the active endpoint revision, and
    // probe evidence to the same database snapshot. Older results cannot be
    // carried into the latest run, even for a currently registered route.
    const rows = await this.options.db
      .select({
        bridge: {
          managementStatus: vpnBridges.managementStatus,
          lastObservedAt: vpnBridges.lastObservedAt,
        },
        route: vpnBridgeRoutes,
        endpointRevision: nodes.vpnEndpointRevision,
        reachabilityEnabled: nodes.reachabilityEnabled,
        probeEnabled: reachabilityProbe.enabled,
        probeCapabilities: reachabilityProbe.capabilities,
        capabilitiesCheckedAt: reachabilityProbe.capabilitiesCheckedAt,
        lastIngestedRunId: reachabilityProbe.lastIngestedRunId,
        resultLevels: nodeReachabilityResults.levels,
        resultStatus: nodeReachabilityResults.status,
      })
      .from(vpnBridges)
      .leftJoin(vpnBridgeRoutes, and(
        eq(vpnBridgeRoutes.bridgeId, vpnBridges.id),
        inArray(vpnBridgeRoutes.state, ["active", "retiring"]),
      ))
      .leftJoin(nodes, eq(nodes.id, vpnBridgeRoutes.nodeId))
      .leftJoin(reachabilityProbe, eq(reachabilityProbe.id, 1))
      .leftJoin(nodeReachabilityResults, and(
        eq(nodeReachabilityResults.nodeId, vpnBridgeRoutes.nodeId),
        eq(nodeReachabilityResults.protocol, "awg3"),
        eq(nodeReachabilityResults.runId, reachabilityProbe.lastIngestedRunId),
      ))
      .where(eq(vpnBridges.id, bridgeId))
      .orderBy(vpnBridgeRoutes.id)
      .limit(501);
    const first = rows[0];
    if (!first) throw new ApiError(404, "Bridge not found", "BRIDGE_NOT_FOUND");
    if (rows.length > 500) throw new ApiError(409, "Too many routes for a single rotation check", "BRIDGE_ROTATION_LIMIT");
    const now = new Date();
    const staleMs = this.options.bridgeObservationStaleMs ?? BRIDGE_OBSERVATION_STALE_MS_DEFAULT;
    const supports = this.options.probeSupportsBridgeMeasurement ?? probeSupportsBridgeMeasurement;
    return {
      bridgeId,
      latestRunId: first.lastIngestedRunId,
      probeReady: first.probeEnabled === true && supports(
        probeCapabilityInputOf(first.probeCapabilities, first.capabilitiesCheckedAt),
        now,
      ),
      routes: rows.flatMap(({ bridge, route, endpointRevision, reachabilityEnabled, resultLevels, resultStatus }) => {
        if (route === null || endpointRevision === null) return [];
        const levels = reachabilityEnabled ? probeLevelsSchema.safeParse(resultLevels).data : undefined;
        return [{
          id: route.id,
          nodeId: route.nodeId,
          state: route.state,
          publicUdpPort: route.publicUdpPort,
          vpnEndpointRevision: endpointRevision,
          registration: routeRegistration(route, bridge, now, staleMs),
          result: levels ? {
            handshake: levels.handshake.ok === true,
            http: resultStatus === "ok" && levels.http.ok === true,
            download: levels.download?.ok ?? null,
          } : null,
        }];
      }),
    };
  };

  upsertReachabilityProbe = async (
    actor: Actor,
    request: UpsertReachabilityProbeRequest,
  ): Promise<ReachabilityProbeView> => {
    const credentials =
      request.apiKey === undefined
        ? null
        : encryptSecret(request.apiKey, this.options.keyring, this.activeKeyVersion);
    const credentialColumns = credentials
      ? {
          credentialsCiphertext: credentials.ciphertext,
          credentialsNonce: credentials.nonce,
          credentialsAuthTag: credentials.authTag,
          credentialsKeyVersion: credentials.keyVersion,
        }
      : null;
    // Omitted optional fields keep what is stored; on create they take the
    // defaults below.
    const settings = {
      label: request.label,
      apiBaseUrl: request.apiBaseUrl.replace(/\/$/, ""),
      controlUrl: request.controlUrl,
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      ...(request.egressUrl === undefined ? {} : { egressUrl: request.egressUrl }),
      ...(request.intervalSec === undefined
        ? {}
        : { intervalSec: request.intervalSec }),
      ...(request.failThreshold === undefined
        ? {}
        : { failThreshold: request.failThreshold }),
      ...(request.staleAfterSec === undefined
        ? {}
        : { staleAfterSec: request.staleAfterSec }),
      ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
      ...(request.probeDirectWhenBridged === undefined ? {} : { probeDirectWhenBridged: request.probeDirectWhenBridged }),
      ...(request.stealthMode === undefined ? {} : { stealthMode: request.stealthMode }),
    };
    return this.options.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(reachabilityProbe)
        .where(eq(reachabilityProbe.id, 1))
        .for("update");
      let row: typeof reachabilityProbe.$inferSelect | undefined;
      // Field NAMES only. The key is named when it is replaced, never written.
      let fields: string[];
      if (current) {
        fields = Object.entries(settings)
          .filter(
            ([field, value]) =>
              current[field as keyof typeof settings] !== value,
          )
          .map(([field]) => field);
        if (credentialColumns) fields.push("apiKey");
        // Switching it back on restarts the stale clock: a pause is not a
        // silent probe.
        const reenabled = !current.enabled && request.enabled === true;
        [row] = await tx
          .update(reachabilityProbe)
          .set({
            ...settings,
            ...credentialColumns,
            ...(reenabled ? { enabledAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(reachabilityProbe.id, 1))
          .returning();
      } else {
        if (!credentialColumns) {
          throw new ApiError(
            400,
            "An API key is required to register the probe",
            "API_KEY_REQUIRED",
          );
        }
        fields = Object.keys(request);
        [row] = await tx
          .insert(reachabilityProbe)
          .values({
            id: 1,
            egressUrl: REACHABILITY_DEFAULTS.egressUrl,
            intervalSec: REACHABILITY_DEFAULTS.intervalSec,
            failThreshold: REACHABILITY_DEFAULTS.failThreshold,
            staleAfterSec: REACHABILITY_DEFAULTS.staleAfterSec,
            timeZone: REACHABILITY_DEFAULTS.timeZone,
            probeDirectWhenBridged: REACHABILITY_DEFAULTS.probeDirectWhenBridged,
            stealthMode: REACHABILITY_DEFAULTS.stealthMode,
            ...settings,
            ...credentialColumns,
          })
          .onConflictDoNothing()
          .returning();
        // A row that did not exist cannot be locked, so a concurrent create
        // can win the insert. Refuse rather than overwrite what it wrote.
        if (!row) {
          throw new ApiError(
            409,
            "The probe was registered concurrently; reload and retry",
            "PROBE_CONFLICT",
          );
        }
      }
      if (!row) throw new ApiError(500, "Probe was not saved", "PROBE_NOT_SAVED");
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.reachability.probe_set",
        targetType: "reachability_probe",
        targetId: null,
        metadata: { created: !current, fields },
      });
      return this.toReachabilityProbeView(row, new Date());
    });
  };

  deleteReachabilityProbe = async (actor: Actor): Promise<void> =>
    this.options.db.transaction(async (tx) => {
      // Results stay: they belong to the nodes and go when a node is deleted.
      const [deleted] = await tx
        .delete(reachabilityProbe)
        .where(eq(reachabilityProbe.id, 1))
        .returning({ label: reachabilityProbe.label });
      if (!deleted) {
        throw new ApiError(404, "No reachability probe is configured", "PROBE_NOT_FOUND");
      }
      // Its keys go with it: their configs were handed to the probe host, and
      // nothing else would ever revoke them (they are hidden from admins).
      const revoked = await tx
        .update(vpnKeys)
        .set({ state: "revoking", updatedAt: new Date() })
        .where(
          and(
            inArray(vpnKeys.state, ["provisioning", "active", "disabled"]),
            inArray(
              vpnKeys.ownerId,
              tx.select({ id: users.id }).from(users).where(eq(users.serviceAccount, true)),
            ),
          ),
        )
        .returning({ id: vpnKeys.id });
      for (const key of revoked) {
        await tx.insert(jobOutbox).values({
          type: "vpn-key.revoke",
          deduplicationKey: revokeJobDedupKey(key.id, randomUUID()),
          payload: { keyId: key.id },
        });
      }
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.reachability.probe_deleted",
        targetType: "reachability_probe",
        targetId: null,
        metadata: { label: deleted.label, revokedKeys: revoked.length },
      });
    });

  runReachabilityNow = async (actor: Actor, requireNew = false): Promise<ReachabilityProbeView> =>
    this.options.db.transaction(async (tx) => {
      // Serialize callers with each other and the worker clearing the pending slot.
      const now = new Date();
      const [probe] = await tx
        .select()
        .from(reachabilityProbe)
        .where(eq(reachabilityProbe.id, 1))
        .for("update");
      if (!probe) {
        throw new ApiError(404, "No reachability probe is configured", "PROBE_NOT_FOUND");
      }
      if (requireNew && probe.requestedRunId !== null) {
        throw new ApiError(409, "A reachability run is already queued", "PROBE_RUN_PENDING");
      }
      const [queued] = probe.requestedRunId !== null
        ? [probe]
        : await tx
            .update(reachabilityProbe)
            .set({ runRequestedAt: now, requestedRunId: randomUUID(), updatedAt: now })
            .where(eq(reachabilityProbe.id, 1))
            .returning();
      if (!queued) {
        throw new ApiError(404, "No reachability probe is configured", "PROBE_NOT_FOUND");
      }
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.reachability.run",
        targetType: "reachability_probe",
        targetId: null,
        metadata: { requestedRunId: queued.requestedRunId },
      });
      return this.toReachabilityProbeView(queued, now);
    });

  listReachabilityHistory = async (
    _actor: Actor,
    { nodeId, limit }: ReachabilityHistoryQuery,
  ): Promise<ReachabilityHistoryEntry[]> => {
    const rows = await this.options.db
      .select({
        runId: nodeReachabilityHistory.runId,
        status: nodeReachabilityHistory.status,
        detail: nodeReachabilityHistory.detail,
        checkedAt: nodeReachabilityHistory.checkedAt,
      })
      .from(nodeReachabilityHistory)
      .where(eq(nodeReachabilityHistory.nodeId, nodeId))
      .orderBy(desc(nodeReachabilityHistory.checkedAt), desc(nodeReachabilityHistory.id))
      .limit(limit);
    return rows.map((row) => ({ ...row, checkedAt: row.checkedAt.toISOString() }));
  };

  /**
   * Ask the worker to reconcile with Cloudflare Access now. Joins the
   * caller's transaction: if the mutation rolls back, so does the arm.
   * Unconditional -- control-api cannot know whether the worker has the sync
   * enabled or whether Cloudflare is configured, so the handler decides (it
   * fails the job with a readable reason rather than pretending to succeed).
   * The upsert lives in @amnezia/db (armAccessSyncRow) -- the worker arms the
   * same row from its own timer, so two copies of this statement would only
   * ever drift.
   */
  private armAccessSync = async (
    tx: DbTransaction,
    reason: AccessSyncArmReason,
  ): Promise<void> => {
    await armAccessSyncRow(tx, reason);
  };

  /**
   * Arm the singleton `rules.refresh` outbox row so the worker fetches and
   * recompacts route rules on its next poll. Returns the updated row when it
   * was newly armed, or undefined when a refresh is already pending/processing.
   */
  private armRulesRefresh = async (
    tx: DbTransaction,
    requestedAt: Date,
  ) => {
    const [armed] = await tx
      .insert(jobOutbox)
      .values({
        type: RULES_REFRESH_JOB_TYPE,
        deduplicationKey: RULES_REFRESH_DEDUPLICATION_KEY,
        payload: { requestedAt: requestedAt.toISOString() },
        availableAt: requestedAt,
      })
      // The deduplication key is UNIQUE and survives a completed run, so a
      // second ask reuses that row. `setWhere` re-arms only a finished run:
      // while one is pending or processing the write is a no-op and cannot
      // queue a second fetch.
      .onConflictDoUpdate({
        target: jobOutbox.deduplicationKey,
        set: {
          status: "pending",
          payload: { requestedAt: requestedAt.toISOString() },
          availableAt: requestedAt,
          attempts: 0,
          lockedAt: null,
          completedAt: null,
          lastError: null,
          updatedAt: requestedAt,
        },
        setWhere: inArray(jobOutbox.status, ["completed", "failed"]),
      })
      .returning();
    return armed;
  };

  adminAction = async (
    actor: Actor,
    resource: string,
    targetId: string | null,
    action: string,
    payload: unknown,
  ): Promise<unknown> => {
    if (!targetId) throw new ApiError(400, "Target id is required", "BAD_REQUEST");
    if (resource === "keys" && !UUID_PATTERN.test(targetId)) {
      throw new ApiError(400, "Key id must be a UUID", "BAD_REQUEST");
    }
    let result: unknown;

    // The probe's service account is managed by the panel: no admin action may
    // offboard, delete, re-role, re-limit or hand it a key. Checked before any
    // payload is parsed, so the refusal is the same whatever is sent. A target
    // that is not a uuid -- the bulk "purge" sweep's literal "offboarded",
    // which excludes the account in its own eligibility rule -- or not a user
    // falls through to each action's own handling.
    if (resource === "users" && UUID_PATTERN.test(targetId)) {
      const [target] = await this.options.db
        .select({ serviceAccount: users.serviceAccount })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (target?.serviceAccount) {
        throw new ApiError(
          409,
          "Service account is managed by the panel",
          "SERVICE_ACCOUNT",
        );
      }
    }
    // Its keys likewise: the worker creates and revokes them. A pin writes
    // only to the owner and refuses a probe key with its own code.
    if (resource === "keys" && action !== "pin-config" && UUID_PATTERN.test(targetId)) {
      const [owner] = await this.options.db
        .select({ serviceAccount: users.serviceAccount })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(eq(vpnKeys.id, targetId))
        .limit(1);
      if (owner?.serviceAccount) {
        throw new ApiError(
          409,
          "Service account keys are managed by the panel",
          "SERVICE_ACCOUNT",
        );
      }
    }

    if (resource === "keys" && ["disable", "enable", "revoke"].includes(action)) {
      const state =
        action === "disable" ? "disabled" : action === "enable" ? "active" : "revoking";
      return this.options.db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: vpnKeys.id,
            state: vpnKeys.state,
            ownerId: vpnKeys.ownerId,
            nodeId: vpnKeys.nodeId,
            endpointId: vpnKeys.endpointId,
            protocol: vpnKeys.protocol,
            routeProfile: vpnKeys.routeProfile,
            deviceType: vpnKeys.deviceType,
            deviceLabel: vpnKeys.deviceLabel,
            keyNumber: vpnKeys.keyNumber,
            internalName: vpnKeys.internalName,
          })
          .from(vpnKeys)
          .where(eq(vpnKeys.id, targetId))
          .for("update");
        if (!current) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        // A key already in `revoking` is NOT a no-op for `revoke`: that is the
        // state a delete sits in when the node was unreachable, and asking
        // again is the retry. Returning early there is what let an operator
        // press Delete on a stuck key and see nothing happen.
        const isNoOp =
          (action !== "revoke" && current.state === state) ||
          (action === "revoke" && current.state === "revoked");
        if (isNoOp) return current;
        const allowed =
          (action === "disable" && current.state === "active") ||
          (action === "enable" && current.state === "disabled") ||
          (action === "revoke" && revocableStates.includes(current.state));
        if (!allowed) {
          throw new ApiError(
            409,
            `Cannot ${action} a key in state ${current.state}`,
            "INVALID_KEY_TRANSITION",
          );
        }

        const [updated] = await tx
          .update(vpnKeys)
          .set({ state, updatedAt: new Date() })
          .where(eq(vpnKeys.id, targetId))
          .returning({ id: vpnKeys.id, state: vpnKeys.state });
        if (!updated) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        await tx
          .insert(jobOutbox)
          .values({
            type: `vpn-key.${action}`,
            // Revoke shares its dedup key shape with every other revoke path;
            // disable/enable are not revoke attempts, so they keep their own.
            deduplicationKey:
              action === "revoke"
                ? revokeJobDedupKey(targetId, randomUUID())
                : `vpn-key.${action}:${targetId}:${randomUUID()}`,
            payload: { keyId: targetId },
          })
          .onConflictDoNothing();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: keyAuditSnapshot(current),
        });
        return updated;
      });
    } else if (resource === "keys" && action === "set-internal-name") {
      // The operator's own note on a key. It changes nothing about the key --
      // no job, no state -- so it is a plain update, but it is still audited:
      // it is the field that says who a key belongs to in the real world.
      const parsed = setKeyInternalNameRequestSchema.parse(payload);
      const internalName = parsed.internalName === "" ? null : parsed.internalName;
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(vpnKeys)
          .set({ internalName, updatedAt: new Date() })
          .where(eq(vpnKeys.id, targetId))
          .returning({
            id: vpnKeys.id,
            ownerId: vpnKeys.ownerId,
            nodeId: vpnKeys.nodeId,
            endpointId: vpnKeys.endpointId,
            protocol: vpnKeys.protocol,
            routeProfile: vpnKeys.routeProfile,
            deviceType: vpnKeys.deviceType,
            deviceLabel: vpnKeys.deviceLabel,
            keyNumber: vpnKeys.keyNumber,
            internalName: vpnKeys.internalName,
          });
        if (!updated) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: keyAuditSnapshot(updated),
        });
        return { id: updated.id, internalName: updated.internalName };
      });
    } else if (resource === "keys" && action === "purge") {
      // Delete the row, not the peer. The peer is already gone -- that is what
      // `revoked` means, and it is the only state this accepts (see
      // PURGEABLE_KEY_STATES). In any other state the node may still be
      // carrying the peer, and deleting the row is what would strand it: the
      // reconcile path finds an orphan by the label the row holds, so with the
      // row gone nothing on the panel knows that peer ever existed.
      return this.options.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            id: vpnKeys.id,
            state: vpnKeys.state,
            ownerId: vpnKeys.ownerId,
            nodeId: vpnKeys.nodeId,
            endpointId: vpnKeys.endpointId,
            protocol: vpnKeys.protocol,
            routeProfile: vpnKeys.routeProfile,
            deviceType: vpnKeys.deviceType,
            nodeLabel: vpnKeys.nodeLabel,
            deviceLabel: vpnKeys.deviceLabel,
            internalName: vpnKeys.internalName,
            keyNumber: vpnKeys.keyNumber,
            createdAt: vpnKeys.createdAt,
            revokedAt: vpnKeys.revokedAt,
          })
          .from(vpnKeys)
          .where(eq(vpnKeys.id, targetId))
          .limit(1);
        if (!existing) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        if (!isPurgeableKeyState(existing.state)) {
          throw new ApiError(
            409,
            `A key can only be deleted from the panel once the node has confirmed its peer is gone. This one is ${existing.state} — delete the key first, then remove it.`,
            "KEY_NOT_PURGEABLE",
          );
        }
        // job_outbox does NOT reference vpn_keys -- the key id lives in the
        // payload -- so its rows have to go explicitly or the worker keeps
        // retrying jobs for a key that no longer exists. peer_current,
        // traffic_samples and traffic_rollups all cascade.
        await tx
          .delete(jobOutbox)
          .where(sql`${jobOutbox.payload} ->> 'keyId' = ${targetId}`);
        await tx.delete(vpnKeys).where(eq(vpnKeys.id, targetId));
        // The row is about to stop existing, so this event is the only record
        // that it ever did. It carries what an operator would need to answer
        // "what was this?" afterwards.
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: {
            ...keyAuditSnapshot(existing),
            nodeLabel: existing.nodeLabel,
            deviceLabel: existing.deviceLabel,
            internalName: existing.internalName,
            keyNumber: existing.keyNumber,
            createdAt: existing.createdAt?.toISOString() ?? null,
            revokedAt: existing.revokedAt?.toISOString() ?? null,
          },
        });
        return { id: targetId, purged: true };
      });
    } else if (resource === "users" && action === "offboard") {
      return this.options.db.transaction(async (tx) => {
        // Lock the active-admin rows FOR NO KEY UPDATE, like set-role, so two
        // concurrent offboards serialize instead of both reading "2 admins"
        // and both proceeding. KEY SHARE audit FK checks remain compatible.
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "admin"), eq(users.status, "active")))
          .for("no key update");
        const [target] = await tx
          .select({ role: users.role, status: users.status })
          .from(users)
          .where(eq(users.id, targetId))
          .limit(1);
        if (!target) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        // Independent of the last-admin check below: an admin among five
        // would otherwise get a diagnosis about being the last one, when the
        // real reason to refuse is that offboard is partly irreversible --
        // reinstate restores the row but not the revoked keys, and offboard
        // arms the Access sync, so the admin would lose the door they would
        // undo it through.
        if (actor.id === targetId) {
          throw new ApiError(409, "Cannot offboard yourself", "SELF_OFFBOARD");
        }
        // A single well-behaved admin actor can never trip this
        // sequentially: it is itself one of the locked `admins` rows, so any
        // *other* active admin target keeps `admins.length` at two or more,
        // and offboarding itself is already refused above by SELF_OFFBOARD.
        // The only way `admins` ever locks down to exactly one row is two
        // admins racing to offboard each other at once -- row locking
        // serialises them, and the loser's re-read (under READ COMMITTED)
        // finds the winner's target already disabled, leaving one active
        // admin, namely itself, as this call's target. That race is what
        // this guard actually protects against: without it, both concurrent
        // offboards would succeed and the panel would be left with no active
        // administrator at all.
        // `status === "active"` is deliberate: without it, offboarding an
        // already-disabled admin while exactly one other active admin exists
        // would falsely trip this, because a disabled admin never appears in
        // the locked `admins` set above.
        if (
          target.role === "admin" &&
          target.status === "active" &&
          admins.length <= 1
        ) {
          throw new ApiError(
            409,
            "Cannot offboard the last administrator",
            "LAST_ADMIN",
          );
        }
        const [updatedUser] = await tx
          .update(users)
          .set({
            status: "disabled",
            disabledAt: new Date(),
            deactivationReason: "admin_offboard",
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetId))
          .returning({ id: users.id, status: users.status });
        if (!updatedUser) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        const keysToRevoke = await tx
          .update(vpnKeys)
          .set({ state: "revoking", updatedAt: new Date() })
          .where(
            and(
              eq(vpnKeys.ownerId, targetId),
              // `revocableStates` (REVOCABLE_KEY_STATES from the contract),
              // not the narrower `quotaStates` this used before: that left out
              // `failed`, so an offboarded user could keep a key that had
              // failed to provision forever, exactly like the worker's own
              // disableAndRevoke is meant to prevent. It also reaches
              // `revoking`, which disableAndRevoke does not select from --
              // queuing a second job for a key already mid-revoke is safe
              // here only because Fix 1 gave every revoke attempt its own
              // deduplication key.
              inArray(vpnKeys.state, revocableStates),
            ),
          )
          .returning({ id: vpnKeys.id, nodeId: vpnKeys.nodeId });
        for (const key of keysToRevoke) {
          await tx.insert(jobOutbox).values({
            type: "vpn-key.revoke",
            deduplicationKey: revokeJobDedupKey(key.id, randomUUID()),
            payload: { keyId: key.id },
          });
        }
        // An offboarded user must leave the Access allowlist along with them.
        await this.armAccessSync(tx, "user-change");
        const revokedNodeIds = [...new Set(keysToRevoke.map((key) => key.nodeId))];
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: {
            keysQueuedForRevoke: keysToRevoke.length,
            ...(revokedNodeIds.length > 0 ? { nodeIds: revokedNodeIds } : {}),
          },
        });
        return { ...updatedUser, keysQueuedForRevoke: keysToRevoke.length };
      });
    } else if (resource === "users" && action === "set-limit") {
      // One action owns a user's whole quota: the flat override, which nodes
      // they may use, and the per-node limits. Applied in a single transaction
      // so the three can never land half-written.
      const parsed = setUserLimitRequestSchema.parse(payload);
      return this.options.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: users.id, policyOverride: users.policyOverride })
          .from(users)
          .where(eq(users.id, targetId))
          .for("update");
        if (!current) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        // Reject references to nodes that do not exist, so the stored quota can
        // never contain a dead node id that silently does nothing.
        const referencedNodeIds = [
          ...new Set([
            ...Object.keys(parsed.nodeKeyLimits ?? {}),
            ...(parsed.allowedNodeIds ?? []),
          ]),
        ];
        if (referencedNodeIds.length > 0) {
          const known = await tx
            .select({ id: nodes.id })
            .from(nodes)
            .where(inArray(nodes.id, referencedNodeIds));
          if (known.length !== referencedNodeIds.length) {
            throw new ApiError(400, "Unknown node id", "NODE_NOT_FOUND");
          }
        }
        const referencedEndpointIds = [...new Set(parsed.allowedEndpointIds ?? [])];
        if (referencedEndpointIds.length > 0) {
          const [knownNodes, knownEndpoints] = await Promise.all([
            tx
              .select({ id: nodes.id })
              .from(nodes)
              .where(inArray(nodes.id, referencedEndpointIds)),
            tx
              .select({ id: nodeVpnEndpoints.id })
              .from(nodeVpnEndpoints)
              .where(inArray(nodeVpnEndpoints.id, referencedEndpointIds)),
          ]);
          const knownTargetIds = new Set([
            ...knownNodes.map((row) => row.id),
            ...knownEndpoints.map((row) => row.id),
          ]);
          if (knownTargetIds.size !== referencedEndpointIds.length) {
            throw new ApiError(400, "Unknown endpoint id", "NODE_ENDPOINT_NOT_FOUND");
          }
        }
        const changes: Partial<typeof users.$inferInsert> = {
          keyLimitOverride: parsed.keyLimitOverride,
          updatedAt: new Date(),
        };
        if (parsed.nodeKeyLimits !== undefined) {
          // An empty map carries no information; store it as null so "no
          // per-node limits" always has one shape on disk.
          changes.nodeKeyLimits =
            parsed.nodeKeyLimits && Object.keys(parsed.nodeKeyLimits).length > 0
              ? parsed.nodeKeyLimits
              : null;
        }
        if (
          parsed.allowedNodeIds !== undefined ||
          parsed.allowedEndpointIds !== undefined ||
          parsed.keyLimitMode !== undefined
        ) {
          // Merge into the existing per-user policy override instead of
          // replacing it, so the other override fields survive. A null clears
          // just that key and the global value applies again.
          const merged: PortalPolicyOverride = { ...(current.policyOverride ?? {}) };
          if (parsed.allowedNodeIds !== undefined) {
            delete merged.allowedNodeIds;
            if (parsed.allowedNodeIds !== null) {
              merged.allowedNodeIds = parsed.allowedNodeIds;
            }
          }
          if (parsed.allowedEndpointIds !== undefined) {
            delete merged.allowedEndpointIds;
            if (parsed.allowedEndpointIds !== null) {
              merged.allowedEndpointIds = parsed.allowedEndpointIds;
            }
          }
          if (parsed.keyLimitMode !== undefined) {
            delete merged.keyLimitMode;
            if (parsed.keyLimitMode !== null) {
              merged.keyLimitMode = parsed.keyLimitMode;
            }
          }
          changes.policyOverride =
            Object.keys(merged).length > 0 ? merged : null;
        }
        const [updated] = await tx
          .update(users)
          .set(changes)
          .where(eq(users.id, targetId))
          .returning({
            id: users.id,
            keyLimitOverride: users.keyLimitOverride,
            nodeKeyLimits: users.nodeKeyLimits,
            policyOverride: users.policyOverride,
          });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        const allowedNodeIds = updated.policyOverride?.allowedNodeIds ?? null;
        const allowedEndpointIds = updated.policyOverride?.allowedEndpointIds ?? null;
        // Null means "inherit the global mode", which is what an absent
        // override key means everywhere else in this codebase.
        const keyLimitMode = updated.policyOverride?.keyLimitMode ?? null;
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          // Counts and the limit only — never the node ids themselves.
          metadata: {
            keyLimitOverride: updated.keyLimitOverride,
            nodeKeyLimitCount: Object.keys(updated.nodeKeyLimits ?? {}).length,
            allowedNodeCount: allowedNodeIds === null ? null : allowedNodeIds.length,
            allowedEndpointCount:
              allowedEndpointIds === null ? null : allowedEndpointIds.length,
            keyLimitMode,
          },
        });
        return {
          id: updated.id,
          keyLimitOverride: updated.keyLimitOverride,
          nodeKeyLimits: updated.nodeKeyLimits ?? null,
          allowedNodeIds,
          allowedEndpointIds,
          keyLimitMode,
        };
      });
    } else if (resource === "users" && action === "set-policy") {
      // zod's .partial() makes a key optional but does NOT drop its .default(),
      // so parsing an override materialises every field the global policy has a
      // default for -- fourteen of them -- however few the admin actually sent.
      // Storing that pins the user to today's global values forever:
      // resolvePortalPolicy spreads the override over the global policy, so a
      // later global change would silently never reach anyone who has ever had
      // a policy saved. Persist only what the caller named, so an absent field
      // still means "inherit".
      const parsed = portalPolicyOverrideSchema.parse(payload);
      const named = new Set(
        payload && typeof payload === "object" ? Object.keys(payload) : [],
      );
      const policyOverride = Object.fromEntries(
        Object.entries(parsed).filter(([field]) => named.has(field)),
      ) as PortalPolicyOverride;
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({ policyOverride, updatedAt: new Date() })
          .where(eq(users.id, targetId))
          .returning({ id: users.id, policyOverride: users.policyOverride });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: { policyOverride },
        });
        return updated;
      });
    } else if (resource === "users" && action === "set-custom-routes") {
      // The write schema, not the storage one: an admin setting a user's routes
      // is refused a site name for the same reason the user is.
      const customRoutes = dedupeCustomRoutes(
        updateCustomRoutesRequestSchema.parse(payload),
      );
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({ customRoutes, updatedAt: new Date() })
          .where(eq(users.id, targetId))
          .returning({ id: users.id, customRoutes: users.customRoutes });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: {
            cidrCount: customRoutes.ru_blacklist.cidrs.length,
            domainCount: customRoutes.ru_blacklist.domains.length,
          },
        });
        return updated;
      });
    } else if (resource === "users" && action === "reset-notices") {
      // Put a user back in front of the notices they have already answered.
      // Support's job, not a user's: "walk me through it again" and "prove to
      // me you read it again" are both reasons an operator has and the person
      // themselves does not.
      const parsed = resetNoticesRequestSchema.parse(payload ?? {});
      const kinds = parsed.notices ?? [...NOTICE_KINDS];
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            ...(kinds.includes("install") ? { installNoticeAcks: 0 } : {}),
            ...(kinds.includes("update") ? { updateNoticeAcks: 0 } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetId))
          .returning({
            id: users.id,
            install: users.installNoticeAcks,
            update: users.updateNoticeAcks,
          });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: { notices: kinds },
        });
        return { id: updated.id, notices: noticeAcksSchema.parse(updated) };
      });
    } else if (resource === "users" && action === "reinstate") {
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            status: "active",
            disabledAt: null,
            deactivationReason: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetId))
          .returning({ id: users.id, status: users.status });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        // A reinstated user is a candidate for the Access allowlist again.
        await this.armAccessSync(tx, "user-change");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
        });
        return updated;
      });
    } else if (resource === "users" && action === "delete") {
      // Rung two of the Delete-button ladder: pressing it on a user already
      // offboarded (rung one, the "offboard" action above) removes the
      // account for good. A distinct action name on purpose -- the existing
      // bulk sweep below is "users"/"purge" with the literal target id
      // "offboarded", and giving the same action name a second, per-user
      // meaning distinguished only by "the id happens to be a UUID" would
      // make the route table something a reader has to reverse-engineer
      // rather than read.
      return this.options.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ id: users.id, email: users.email, status: users.status })
          .from(users)
          .where(eq(users.id, targetId))
          .for("update");
        if (!target) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        // Rung one must already have happened. An active account still has a
        // live session and (potentially) an Access allowlist entry; this
        // button does not promise to tear either of those down itself.
        if (target.status !== "disabled") {
          throw new ApiError(
            409,
            "This account is still active. Offboard it first, then delete it.",
            "USER_NOT_DISABLED",
          );
        }
        // Same "live" state set the retention-gated bulk purge uses (see
        // hasLiveKeys / findOffboardedUsersEligibleForPurge in @amnezia/db) --
        // reused rather than re-derived so the two paths can never disagree
        // about what counts as safe to delete. A key in any of those states
        // could still hold a peer on a node; deleting the user row out from
        // under it is exactly what would strand that peer with nothing left
        // pointing at it.
        if (await hasLiveKeys(tx, targetId)) {
          throw new ApiError(
            409,
            "This account still holds a live key. Revoke or purge it before deleting the account.",
            "USER_HAS_LIVE_KEYS",
          );
        }
        // Deliberately does NOT consult offboardedUserRetentionDays. That
        // window governs how long the panel waits before acting ON ITS OWN --
        // the automatic sweep, and the bulk manual purge above that mirrors
        // its eligibility rule so the two can never disagree. An admin
        // pointing at one account and confirming this dialog is not the panel
        // acting on its own; there is no unattended action here to put a
        // waiting period in front of, however recently the account was
        // disabled.
        await purgeOneOffboardedUser(tx, targetId);
        // Same event the bulk manual purge writes, with an actor for the same
        // reason: unlike the automatic sweep, a human asked for this one.
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "user.deleted",
          targetType: "user",
          targetId,
          metadata: { email: target.email },
        });
        return { id: targetId, deleted: true, email: target.email };
      });
    } else if (resource === "users" && action === "set-role") {
      const { role } = z
        .object({ role: z.enum(["user", "admin"]) })
        .parse(payload);
      return this.options.db.transaction(async (tx) => {
        // Never allow demoting the last remaining admin (avoids lockout).
        if (role === "user") {
          // Lock the active-admin rows FOR NO KEY UPDATE so concurrent set-role
          // calls serialize: the second sees the first's committed demotion
          // instead of both reading "2 admins" and both demoting to zero.
          // Non-key updates permit concurrent audit FK checks (KEY SHARE).
          const admins = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, "admin"), eq(users.status, "active")))
            .for("no key update");
          const [target] = await tx
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, targetId))
            .limit(1);
          if (target?.role === "admin" && admins.length <= 1) {
            throw new ApiError(
              409,
              "Cannot demote the last administrator",
              "LAST_ADMIN",
            );
          }
        }
        const [updated] = await tx
          .update(users)
          .set({ role, updatedAt: new Date() })
          .where(eq(users.id, targetId))
          .returning({ id: users.id, role: users.role });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: { role },
        });
        return updated;
      });
    } else if (resource === "users" && action === "create-key") {
      const target = (
        await this.options.db.select().from(users).where(eq(users.id, targetId)).limit(1)
      )[0];
      if (!target) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      const parsed = createKeyRequestSchema.parse(payload);
      result = await this.createProvisioningKey(toActor(target), parsed, {
        allowBridgeSelection: true,
      });
      await this.appendAudit({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.users.create-key",
        targetType: "user",
        targetId,
        metadata: {
          keyId: (result as { id: string }).id,
          bridgeMode: parsed.bridgeMode ?? "inherit",
          vpnBridgeRouteId: parsed.vpnBridgeRouteId ?? null,
          ...clientSettingsAudit(parsed),
        },
      });
      return result;
    } else if (resource === "users" && action === "set-config") {
      const request = setUserClientConfigRequestSchema.parse(payload);
      const [updated] = await this.options.db.update(users)
        .set({
          ...(request.awgGenerator !== undefined ? { awgGenerator: request.awgGenerator } : {}),
          ...(request.awgMtu !== undefined ? { awgMtu: request.awgMtu } : {}),
          // An object replaces the whole map; null clears every rule.
          ...(request.awgDeviceRules !== undefined ? { awgDeviceRules: request.awgDeviceRules } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, targetId), notServiceAccount))
        .returning();
      if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
      await this.appendAudit({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.users.set-config",
        targetType: "user",
        targetId,
        metadata: {
          ...clientSettingsAudit(updated),
          // The device types that now have a rule, when the request set them.
          ...(request.awgDeviceRules !== undefined
            ? { deviceRules: Object.keys(updated.awgDeviceRules ?? {}).sort() }
            : {}),
        },
      });
      return updated;
    } else if (resource === "keys" && action === "set-config") {
      const request = setAwgClientConfigRequestSchema.parse(payload);
      return this.options.db.transaction(async (tx) => {
        const [key] = await tx.select({ id: vpnKeys.id, protocol: vpnKeys.protocol })
          .from(vpnKeys)
          .innerJoin(users, keyOwnerIsPerson(vpnKeys))
          .where(eq(vpnKeys.id, targetId))
          .for("update", { of: vpnKeys });
        if (!key) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        if (key.protocol !== "awg3") {
          throw new ApiError(409, "Client settings require AWG 3.1", "AWG_GENERATOR_UNSUPPORTED");
        }
        const [updated] = await tx.update(vpnKeys)
          .set({
            ...(request.awgGenerator !== undefined ? { awgGenerator: request.awgGenerator } : {}),
            ...(request.awgMtu !== undefined ? { awgMtu: request.awgMtu } : {}),
            updatedAt: new Date(),
          })
          .where(eq(vpnKeys.id, targetId))
          .returning({ id: vpnKeys.id, awgGenerator: vpnKeys.awgGenerator, awgMtu: vpnKeys.awgMtu });
        if (!updated) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "vpn_key.config_set",
          targetType: "vpn_key",
          targetId,
          metadata: clientSettingsAudit(updated),
        });
        return updated;
      });
    } else if (resource === "keys" && action === "pin-config") {
      const { target } = pinClientConfigRequestSchema.parse(payload);
      return this.options.db.transaction(async (tx) => {
        // Follow the owner -> key order used by offboarding and provisioning.
        // Read the owner id without a key lock, then recheck it after locking.
        const [identity] = await tx.select({ ownerId: vpnKeys.ownerId })
          .from(vpnKeys).where(eq(vpnKeys.id, targetId));
        if (!identity) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        // Only non-key settings change. Allow audit FK checks (KEY SHARE)
        // while still serializing edits of the same owner's rules.
        const [owner] = await tx.select({
          serviceAccount: users.serviceAccount,
          awgGenerator: users.awgGenerator,
          awgMtu: users.awgMtu,
          awgDeviceRules: users.awgDeviceRules,
        }).from(users).where(eq(users.id, identity.ownerId)).for("no key update");
        if (!owner) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        const [key] = await tx.select({
          id: vpnKeys.id,
          ownerId: vpnKeys.ownerId,
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
          protocol: vpnKeys.protocol,
          deviceType: vpnKeys.deviceType,
          awgGenerator: vpnKeys.awgGenerator,
          awgMtu: vpnKeys.awgMtu,
        }).from(vpnKeys).where(and(eq(vpnKeys.id, targetId), eq(vpnKeys.ownerId, identity.ownerId))).for("update");
        if (!key) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        if (key.protocol !== "awg3") {
          throw new ApiError(409, "Only AWG 3.1 keys can be pinned", PIN_UNAVAILABLE);
        }
        if (owner.serviceAccount) {
          throw new ApiError(409, "Service account keys are managed by the panel", PIN_UNAVAILABLE);
        }
        if (target === "device" && key.deviceType === "unspecified") {
          throw new ApiError(409, "A key without a device type matches no device rule", PIN_UNAVAILABLE);
        }
        const settings = resolveKeyClientSettings({
          key,
          owner,
          ...(await this.keyAddressAndNodeLevels(tx, key)),
        });
        // Both fields as concrete values, so later node or address edits do
        // not reach the owner: "as issued" pins the issued preset and an MTU
        // from the profile or the default pins as that number.
        const pinned = asClientRule({
          awgGenerator: settings.awgGenerator ?? issuedPresetSettings(),
          awgMtu: settings.mtu,
        });
        if (!pinned) {
          throw new ApiError(409, "The key's settings cannot be pinned", PIN_UNAVAILABLE);
        }
        const held = target === "user"
          ? asClientRule({ awgGenerator: owner.awgGenerator, awgMtu: owner.awgMtu })
          : deviceRuleFor(owner.awgDeviceRules, key.deviceType);
        const scope = target === "device" ? { deviceType: key.deviceType } : {};
        const result = {
          keyId: key.id,
          ownerId: key.ownerId,
          target,
          ...scope,
          awgGenerator: pinned.awgGenerator,
          awgMtu: pinned.awgMtu,
          changed: !isDeepStrictEqual(held, pinned),
        };
        if (!result.changed) return result;
        const rules = owner.awgDeviceRules !== null && typeof owner.awgDeviceRules === "object"
          ? owner.awgDeviceRules
          : {};
        await tx.update(users)
          .set(target === "user"
            ? { awgGenerator: pinned.awgGenerator, awgMtu: pinned.awgMtu, updatedAt: new Date() }
            // The rule for the key's type is replaced; other types stay as they are.
            : { awgDeviceRules: { ...rules, [key.deviceType]: pinned }, updatedAt: new Date() })
          .where(eq(users.id, key.ownerId));
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.keys.pin-config",
          targetType: "vpn_key",
          targetId: key.id,
          metadata: { target, ownerId: key.ownerId, ...scope, ...clientSettingsAudit(pinned) },
        });
        return result;
      });
    } else if (
      resource === "quota-requests" &&
      ["approve", "reject"].includes(action)
    ) {
      const review = z
        .object({ note: z.string().trim().max(1_000).optional() })
        .parse(payload ?? {});
      return this.options.db.transaction(async (tx) => {
        const request = (
          await tx
            .select()
            .from(quotaRequests)
            .where(
              and(
                eq(quotaRequests.id, targetId),
                eq(quotaRequests.status, "pending"),
              ),
            )
            .for("update")
        )[0];
        if (!request) {
          throw new ApiError(404, "Pending request not found", "NOT_FOUND");
        }
        let approval: QuotaApproval | null = null;
        let keyLimitMode: KeyLimitMode | null = null;
        if (action === "approve") {
          // The grant follows the request's own target and must actually hold:
          // an every-server grant also clears the per-node entries that would
          // otherwise shadow it. Node availability is never widened here.
          const [owner] = await tx
            .select({
              keyLimitOverride: users.keyLimitOverride,
              nodeKeyLimits: users.nodeKeyLimits,
              policyOverride: users.policyOverride,
            })
            .from(users)
            .where(eq(users.id, request.userId))
            .for("update");
          if (!owner) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
          // The owner's effective mode decides what the granted number means:
          // a per-server limit, or the shared pool. Approving only ever moves a
          // number — the mode itself is an admin-only setting and is never
          // changed here, in either direction.
          const globalPolicy = (await tx.select().from(portalPolicy).limit(1))[0];
          keyLimitMode = resolvePortalPolicy(
            toPolicy(globalPolicy),
            owner.policyOverride,
          ).keyLimitMode;
          approval = resolveQuotaApproval(
            owner,
            {
              requestedLimit: request.requestedLimit,
              nodeId: request.nodeId,
            },
            keyLimitMode,
          );
          await tx
            .update(users)
            .set({
              keyLimitOverride: approval.keyLimitOverride,
              nodeKeyLimits: approval.nodeKeyLimits,
              updatedAt: new Date(),
            })
            .where(eq(users.id, request.userId));
        }
        const [updated] = await tx
          .update(quotaRequests)
          .set({
            status: action === "approve" ? "approved" : "rejected",
            reviewedBy: actor.id,
            reviewedAt: new Date(),
            reviewNote: review.note,
            updatedAt: new Date(),
          })
          .where(eq(quotaRequests.id, targetId))
          .returning();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: {
            requestedLimit: request.requestedLimit,
            nodeId: request.nodeId,
            status: updated?.status,
            ...(approval
              ? {
                  keyLimitMode,
                  clearedNodeLimitCount: approval.clearedNodeLimitCount,
                  targetCoerced: approval.targetCoerced,
                }
              : {}),
          },
        });
        return updated;
      });
    } else if (resource === "portal-policy" && action === "update") {
      const parsed = adminPolicyUpdateSchema.parse(payload);
      // `.partial()` does NOT strip `.default()`: parsing `{ defaultKeyLimit: 10 }`
      // hands back every defaulted policy field as well. Writing that wholesale
      // would reset showNodeAddress, keyLimitMode, installGuideVideos and the
      // rest to their defaults on any single-field update — and `policy-set`
      // sends exactly the flags it was given. Keep only what the caller named.
      const named = new Set(
        payload && typeof payload === "object" ? Object.keys(payload) : [],
      );
      const provided = Object.fromEntries(
        Object.entries(parsed).filter(([field]) => named.has(field)),
      ) as typeof parsed;
      const {
        cfApiToken,
        recommendedNodeIds,
        nodeOrder,
        recommendedEndpointIds,
        endpointOrder,
        ...rest
      } = provided;
      const changes: Partial<typeof portalPolicy.$inferInsert> = { ...rest };
      if (cfApiToken) {
        const encrypted = encryptSecret(
          cfApiToken,
          this.options.keyring,
          this.activeKeyVersion,
        );
        changes.cfApiTokenCiphertext = encrypted.ciphertext;
        changes.cfApiTokenNonce = encrypted.nonce;
        changes.cfApiTokenAuthTag = encrypted.authTag;
        changes.cfApiTokenKeyVersion = encrypted.keyVersion;
      }
      // Canonical form: no duplicates, and every id must name a real node so a
      // stored list can never contain an id that silently does nothing (same
      // rule as the per-user node lists in users/set-limit).
      const recommended =
        recommendedNodeIds === undefined
          ? undefined
          : dedupeNodeIds(recommendedNodeIds);
      const order =
        nodeOrder === undefined ? undefined : dedupeNodeIds(nodeOrder);
      const recommendedEndpoints =
        recommendedEndpointIds === undefined
          ? undefined
          : dedupeNodeIds(recommendedEndpointIds);
      const epOrder =
        endpointOrder === undefined ? undefined : dedupeNodeIds(endpointOrder);
      const allowedEndpoints =
        named.has("allowedEndpointIds")
          ? provided.allowedEndpointIds === null || provided.allowedEndpointIds === undefined
            ? null
            : dedupeNodeIds(provided.allowedEndpointIds)
          : undefined;
      if (allowedEndpoints !== undefined) {
        changes.allowedEndpointIds = allowedEndpoints;
      }
      // The sync connects to Cloudflare with these fields; nothing else about
      // the policy is visible to it, so only naming one of them re-arms it.
      const touchesAccessConfig = CF_ACCESS_CONFIG_FIELDS.some((field) =>
        named.has(field),
      );
      // The bridge default moves every address that inherits it onto or off
      // its node's bridge, so the probe re-checks once the change commits.
      let bridgeDefaultChanged = false;
      const policy = await this.options.db.transaction(async (tx) => {
        const previousUseBridge = named.has("useBridge")
          ? ((await tx.select({ useBridge: portalPolicy.useBridge }).from(portalPolicy).limit(1))[0]
              ?.useBridge ?? false)
          : undefined;
        // The domain list widens who can reach the panel through Cloudflare,
        // so a bare list of changed FIELD NAMES in the audit event cannot say
        // who was let in. Read the value this update is about to replace
        // before the write below, so the audit event can record both sides —
        // never done for `cfApiToken` itself, which must never reach the log.
        const previousDomains = named.has("cfAccessAllowedDomains")
          ? ((
              await tx
                .select({
                  cfAccessAllowedDomains: portalPolicy.cfAccessAllowedDomains,
                })
                .from(portalPolicy)
                .limit(1)
            )[0]?.cfAccessAllowedDomains ?? [])
          : undefined;
        // One existence check for both lists: fewer round trips, and the
        // rejection is all-or-nothing, so a bad id never half-applies. This
        // runs BEFORE the prefix rule, so an id that names no node is reported
        // as such rather than as "not at the top of the order".
        const referenced = [
          ...new Set([...(recommended ?? []), ...(order ?? [])]),
        ];
        if (referenced.length > 0) {
          const known = await tx
            .select({ id: nodes.id })
            .from(nodes)
            .where(inArray(nodes.id, referenced));
          if (known.length !== referenced.length) {
            throw new ApiError(400, "Unknown node id", "NODE_NOT_FOUND");
          }
        }
        const referencedEndpoints = [
          ...new Set([
            ...(recommendedEndpoints ?? []),
            ...(epOrder ?? []),
            ...(allowedEndpoints ?? []),
          ]),
        ];
        if (referencedEndpoints.length > 0) {
          const [knownNodes, knownEndpoints] = await Promise.all([
            tx
              .select({ id: nodes.id })
              .from(nodes)
              .where(inArray(nodes.id, referencedEndpoints)),
            tx
              .select({ id: nodeVpnEndpoints.id })
              .from(nodeVpnEndpoints)
              .where(inArray(nodeVpnEndpoints.id, referencedEndpoints)),
          ]);
          const knownTargets = new Set([
            ...knownNodes.map((row) => row.id),
            ...knownEndpoints.map((row) => row.id),
          ]);
          if (knownTargets.size !== referencedEndpoints.length) {
            throw new ApiError(400, "Unknown endpoint id", "NODE_ENDPOINT_NOT_FOUND");
          }
        }
        // A sample period below the telemetry poll period is not a faster
        // history, it is the same history with a setting that lies about it:
        // only a poll can write a sample row, for host metrics and for peers
        // alike. It used to be caught at worker boot, which is no help to an
        // admin who has just saved the pair here — so it is refused on the way
        // in, checked against the EFFECTIVE state so naming only one of the two
        // is still validated against the other. The worker clamps on read as
        // well, because it can see an environment poll period that this cannot;
        // refusing here is what stops the panel DISPLAYING a sample period that
        // is not the one running.
        if (
          named.has("telemetryPollSec") ||
          POLL_BOUND_SAMPLE_FIELDS.some((field) => named.has(field))
        ) {
          const [storedPeriods] = await tx
            .select({
              telemetryPollSec: portalPolicy.telemetryPollSec,
              nodeMetricsSampleSec: portalPolicy.nodeMetricsSampleSec,
              peerSampleSec: portalPolicy.peerSampleSec,
            })
            .from(portalPolicy)
            .limit(1);
          // A field the caller named as `null` means "use the default", so it
          // resolves to the fallback rather than to the value being cleared.
          const effective = (
            field: "telemetryPollSec" | PollBoundSampleField,
          ): number =>
            (named.has(field) ? provided[field] : storedPeriods?.[field]) ??
            WORKER_PERIOD_FIELDS[field].fallback;
          for (const field of POLL_BOUND_SAMPLE_FIELDS) {
            const conflict = sampleBelowPoll(
              field,
              effective("telemetryPollSec"),
              effective(field),
            );
            if (!conflict) continue;
            throw new ApiError(
              400,
              `The ${POLL_BOUND_SAMPLE_LABELS[field]} (${conflict.sampleSec} s) cannot be shorter than the server-status poll period (${conflict.telemetryPollSec} s): only a poll can write a sample, so a shorter sample period would keep no extra history. Note that a worker whose environment sets TELEMETRY_POLL_SEC uses that as the poll period when none is set here.`,
              "SAMPLE_BELOW_POLL",
            );
          }
        }
        if (order) changes.nodeOrder = order;
        // Only the servers at the TOP of the manual order may be recommended.
        // The rule spans both columns, so it is checked on the EFFECTIVE state:
        // a write that touches only one field is validated against the stored
        // value of the other. A reorder that would leave a recommended server
        // behind is rejected - never silently un-recommended, because that
        // would be a policy change nobody asked for and nothing would record it.
        if (recommended !== undefined || order !== undefined) {
          const [stored] = await tx
            .select({
              recommendedNodeIds: portalPolicy.recommendedNodeIds,
              nodeOrder: portalPolicy.nodeOrder,
            })
            .from(portalPolicy)
            .limit(1);
          const effectiveRecommended =
            recommended ?? stored?.recommendedNodeIds ?? [];
          const effectiveOrder = order ?? stored?.nodeOrder ?? [];
          const check = checkRecommendedPrefix(
            effectiveRecommended,
            effectiveOrder,
          );
          if (!check.ok) {
            throw new ApiError(
              400,
              check.reason === "unpositioned"
                ? `Node ${check.nodeId} cannot be recommended: it has no place in the server order. Only servers at the top of the order can be recommended.`
                : `Node ${check.nodeId} cannot be recommended: it is at position ${check.position} of the server order, behind servers that are not recommended. Only servers at the top of the order can be recommended.`,
              "RECOMMENDED_NOT_PREFIX",
            );
          }
          // Store the canonical form (order sequence), even when only the order
          // moved: a reorder inside the recommended prefix must be reflected.
          // The recommended SET is unchanged in that case, so the audit event
          // still describes the change honestly as a nodeOrder edit.
          if (recommended !== undefined || check.canonical.length > 0) {
            changes.recommendedNodeIds = check.canonical;
          }
        }
        if (epOrder) changes.endpointOrder = epOrder;
        if (recommendedEndpoints !== undefined || epOrder !== undefined) {
          const [stored] = await tx
            .select({
              recommendedEndpointIds: portalPolicy.recommendedEndpointIds,
              endpointOrder: portalPolicy.endpointOrder,
            })
            .from(portalPolicy)
            .limit(1);
          const effectiveRecommended =
            recommendedEndpoints ?? stored?.recommendedEndpointIds ?? [];
          const effectiveOrder = epOrder ?? stored?.endpointOrder ?? [];
          const check = checkRecommendedPrefix(
            effectiveRecommended,
            effectiveOrder,
          );
          if (!check.ok) {
            throw new ApiError(
              400,
              check.reason === "unpositioned"
                ? `Endpoint ${check.nodeId} cannot be recommended: it has no place in the server order. Only servers at the top of the order can be recommended.`
                : `Endpoint ${check.nodeId} cannot be recommended: it is at position ${check.position} of the server order, behind servers that are not recommended. Only servers at the top of the order can be recommended.`,
              "RECOMMENDED_NOT_PREFIX",
            );
          }
          if (recommendedEndpoints !== undefined || check.canonical.length > 0) {
            changes.recommendedEndpointIds = check.canonical;
          }
        }
        if (previousUseBridge !== undefined && changes.useBridge !== undefined &&
          changes.useBridge !== previousUseBridge) {
          await this.resetInheritingAddressEvidence(tx, new Date());
        }
        const [updated] = await tx
          .insert(portalPolicy)
          .values({ id: true, ...changes })
          .onConflictDoUpdate({
            target: portalPolicy.id,
            set: { ...changes, updatedAt: new Date() },
          })
          .returning();
        if (touchesAccessConfig) await this.armAccessSync(tx, "config");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.portal-policy.update",
          targetType: "portal-policy",
          targetId: "global",
          metadata: {
            fields: Object.keys(provided),
            ...(recommended ? { recommendedNodeCount: recommended.length } : {}),
            ...(order ? { orderedNodeCount: order.length } : {}),
            // The field NAME alone does not say who this let in — record the
            // value too. Before-and-after, since "widened the allowlist" and
            // "narrowed it" are very different events to reconstruct later.
            ...(named.has("cfAccessAllowedDomains")
              ? {
                  cfAccessAllowedDomains: provided.cfAccessAllowedDomains,
                  cfAccessAllowedDomainsBefore: previousDomains,
                }
              : {}),
          },
        });
        bridgeDefaultChanged = previousUseBridge !== undefined &&
          updated !== undefined && updated.useBridge !== previousUseBridge;
        return updated ? stripPolicySecrets(updated) : updated;
      });
      if (bridgeDefaultChanged) await this.queueReachabilityRun();
      return policy;
    } else if (resource === "global-routes" && action === "update") {
      const routes = dedupeGlobalRoutes(
        updateGlobalRoutesRequestSchema.parse(payload),
      );
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .insert(globalRouteOverrides)
          .values({ id: true, payload: routes })
          .onConflictDoUpdate({
            target: globalRouteOverrides.id,
            set: { payload: routes, updatedAt: new Date() },
          })
          .returning({ payload: globalRouteOverrides.payload });
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.global-routes.update",
          targetType: "global-routes",
          targetId: "global",
          // Counts only — the entries themselves stay out of the audit log.
          metadata: globalRouteCounts(routes),
        });
        // Re-arm the singleton `rules.refresh` job so the worker bakes the
        // updated admin additions/exclusions into a compacted rule snapshot
        // and bumps `route_rule_versions` (flagging keys as `rulesOutdated`).
        await this.armRulesRefresh(tx, new Date());
        return updated?.payload ?? routes;
      });
    } else if (resource === "nodes" && action === "reconcile") {
      return this.options.db.transaction(async (tx) => {
        const [node] = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(eq(nodes.id, targetId));
        if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
        await tx.insert(jobOutbox).values({
          type: "node.reconcile",
          deduplicationKey: `node.reconcile:${targetId}:${randomUUID()}`,
          payload: { nodeId: targetId },
        });
        await this.enqueueNodeSyncEgress(tx, targetId);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.nodes.reconcile",
          targetType: "node",
          targetId,
        });
        return { id: targetId, queued: true };
      });
    } else if (resource === "nodes" && action === "agent-update") {
      // Modelled on "reconcile" above: check the target, enqueue, audit. The
      // difference that matters is the image - the panel resolves it, the admin
      // confirms exactly what was shown, and that digest travels unchanged to
      // the node. Nothing downstream re-resolves anything.
      const requested = nodeAgentUpdateActionSchema.parse(payload ?? {});
      return this.options.db.transaction(async (tx) => {
        const [node] = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(eq(nodes.id, targetId));
        if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
        const [release] = await tx
          .select()
          .from(nodeAgentReleases)
          .orderBy(desc(nodeAgentReleases.resolvedAt))
          .limit(1);
        if (!release) {
          throw new ApiError(
            409,
            "No published node-agent image has been resolved yet",
            "AGENT_IMAGE_UNRESOLVED",
          );
        }
        const image = requested.image ?? `${release.repository}@${release.digest}`;
        // The admin may only confirm what the panel resolved. A pasted digest
        // for another repository, or a tag, is refused here as well as on the
        // node and in the host-side updater.
        if (!isPublishableAgentImage(image, release.repository)) {
          throw new ApiError(
            400,
            "The image must be a digest in the published repository",
            "AGENT_IMAGE_INVALID",
          );
        }
        await tx.insert(jobOutbox).values({
          type: "node.agent-update",
          deduplicationKey: `node.agent-update:${targetId}:${randomUUID()}`,
          payload: { nodeId: targetId, image },
        });
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.nodes.agent-update",
          targetType: "node",
          targetId,
          metadata: { image },
        });
        return { id: targetId, image, queued: true };
      });
    } else if (resource === "nodes" && action === "set-capacity") {
      // The same shape as "agent-update" above: check the target, enqueue,
      // audit. The number the admin typed travels unchanged to the node, which
      // re-validates it, as does the host-side applier and set-capacity.sh
      // after that. Three checks across three threat models, not duplication.
      const requested = nodeCapacityActionSchema.parse(payload ?? {});
      return this.options.db.transaction(async (tx) => {
        const [node] = await tx
          .select({ id: nodes.id, maxPeers: nodes.maxPeers })
          .from(nodes)
          .where(eq(nodes.id, targetId));
        if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
        await tx.insert(jobOutbox).values({
          type: "node.set-capacity",
          deduplicationKey: `node.set-capacity:${targetId}:${randomUUID()}`,
          payload: { nodeId: targetId, maxPeers: requested.maxPeers },
        });
        // The panel's own limit follows the node's, so the two cannot drift
        // into the state that produces a key stuck in provisioning: the panel
        // sending keys to a node that is already full by its own count.
        await tx
          .update(nodes)
          .set({
            maxPeers: requested.maxPeers,
            capacityState: "requested",
            capacityRequestedPeers: requested.maxPeers,
            capacityMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(nodes.id, targetId));
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.nodes.set-capacity",
          targetType: "node",
          targetId,
          metadata: {
            maxPeers: requested.maxPeers,
            previousMaxPeers: node.maxPeers,
          },
        });
        return { id: targetId, maxPeers: requested.maxPeers, queued: true };
      });
    } else if (resource === "rules" && action === "activate") {
      // Activating PINS the profile to this version. The worker's fetcher
      // reads that pin and stops publishing: it keeps downloading and keeps
      // recording every newer version it finds (as `superseded`, never
      // published), but the profile stays on the admin's choice until someone
      // activates another version or presses "follow the feed". Without the
      // pin the next fetch tick would quietly undo this click, which is the
      // whole reason the column exists.
      return this.options.db.transaction(async (tx) => {
        const now = new Date();
        const [targetRule] = await tx
          .select()
          .from(routeRuleVersions)
          .where(eq(routeRuleVersions.id, targetId));
        if (!targetRule) throw new ApiError(404, "Rule version not found", "NOT_FOUND");
        // Demote whatever was live, and drop the profile's old pin. Both
        // BEFORE the target is pinned below, or the "at most one pin per
        // profile" unique index would fire mid-transaction. The second
        // statement is belt and braces: by invariant only an active row can
        // carry a pin, so it normally matches nothing.
        await tx
          .update(routeRuleVersions)
          .set({ status: "superseded", pinnedAt: null, updatedAt: now })
          .where(
            and(
              eq(routeRuleVersions.profile, targetRule.profile),
              eq(routeRuleVersions.status, "active"),
              ne(routeRuleVersions.id, targetId),
            ),
          );
        await tx
          .update(routeRuleVersions)
          .set({ pinnedAt: null, updatedAt: now })
          .where(
            and(
              eq(routeRuleVersions.profile, targetRule.profile),
              isNotNull(routeRuleVersions.pinnedAt),
              ne(routeRuleVersions.id, targetId),
            ),
          );
        const [activated] = await tx
          .update(routeRuleVersions)
          .set({
            status: "active",
            publishedAt: now,
            pinnedAt: now,
            updatedAt: now,
          })
          .where(eq(routeRuleVersions.id, targetId))
          .returning();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.activate",
          targetType: "rules",
          targetId,
          metadata: {
            profile: targetRule.profile,
            version: targetRule.version,
            pinned: true,
          },
        });
        return activated;
      });
    } else if (resource === "rules" && action === "follow") {
      // The other half of the pin: hand the profile back to the worker. The
      // active version stays exactly as it is — this only says "publish the
      // next thing you fetch", which the worker does on its next tick.
      return this.options.db.transaction(async (tx) => {
        const now = new Date();
        const [targetRule] = await tx
          .select()
          .from(routeRuleVersions)
          .where(eq(routeRuleVersions.id, targetId));
        if (!targetRule) throw new ApiError(404, "Rule version not found", "NOT_FOUND");
        // Clear by PROFILE, not by row: the caller names a version, but the
        // pin is a property of the profile and only one may exist.
        const cleared = await tx
          .update(routeRuleVersions)
          .set({ pinnedAt: null, updatedAt: now })
          .where(
            and(
              eq(routeRuleVersions.profile, targetRule.profile),
              isNotNull(routeRuleVersions.pinnedAt),
            ),
          )
          .returning({ id: routeRuleVersions.id });
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.follow",
          targetType: "rules",
          targetId,
          metadata: {
            profile: targetRule.profile,
            version: targetRule.version,
            wasPinned: cleared.length > 0,
          },
        });
        return { profile: targetRule.profile, pinned: false };
      });
    } else if (resource === "rules" && action === "notify") {
      if (!UUID_PATTERN.test(targetId)) {
        throw new ApiError(400, "Rule version id must be a UUID", "BAD_REQUEST");
      }
      const parsed = ruleNotifySchema.parse(payload ?? {});
      return this.options.db.transaction(async (tx) => {
        const now = new Date();
        const [targetRule] = await tx
          .select({
            id: routeRuleVersions.id,
            profile: routeRuleVersions.profile,
            version: routeRuleVersions.version,
            status: routeRuleVersions.status,
            notifiedAt: routeRuleVersions.notifiedAt,
          })
          .from(routeRuleVersions)
          .where(eq(routeRuleVersions.id, targetId))
          .limit(1);
        if (!targetRule) {
          throw new ApiError(404, "Rule version not found", "NOT_FOUND");
        }
        if (targetRule.status !== "active") {
          throw new ApiError(
            409,
            "Only the active rule version can be marked as an important update",
            "RULE_NOT_ACTIVE",
          );
        }
        if (targetRule.notifiedAt !== null) {
          throw new ApiError(
            409,
            "Important update has already been triggered for this rule version",
            "ALREADY_NOTIFIED",
          );
        }
        const [updated] = await tx
          .update(routeRuleVersions)
          .set({
            notifiedAt: now,
            notifyNote: parsed.note,
            updatedAt: now,
          })
          .where(
            and(
              eq(routeRuleVersions.id, targetId),
              eq(routeRuleVersions.status, "active"),
              isNull(routeRuleVersions.notifiedAt),
            ),
          )
          .returning({
            id: routeRuleVersions.id,
            profile: routeRuleVersions.profile,
            version: routeRuleVersions.version,
            notifiedAt: routeRuleVersions.notifiedAt,
            notifyNote: routeRuleVersions.notifyNote,
          });
        if (!updated) {
          throw new ApiError(
            409,
            "Important update has already been triggered for this rule version",
            "ALREADY_NOTIFIED",
          );
        }
        const [affectedRow] = await tx
          .select({ total: count() })
          .from(vpnKeys)
          .where(
            and(
              eq(vpnKeys.state, "active"),
              eq(vpnKeys.routeProfile, targetRule.profile),
              sql`${vpnKeys.routeRuleVersionId} IS DISTINCT FROM ${targetRule.id}`,
            ),
          );
        const affectedKeys = Number(affectedRow?.total ?? 0);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.notify",
          targetType: "rules",
          targetId,
          metadata: {
            profile: targetRule.profile,
            version: targetRule.version,
            affectedKeys,
            hasNote: parsed.note !== null,
          },
        });
        return {
          ...updated,
          affectedKeys,
        };
      });
    } else if (resource === "rules" && action === "refresh") {
      // Control-api never fetches a feed itself: `RULE_FEEDS` and the
      // fetch/validate/quarantine logic belong to the worker. This only
      // enqueues the job the periodic timer already runs.
      return this.options.db.transaction(async (tx) => {
        const armed = await this.armRulesRefresh(tx, new Date());
        const row =
          armed ??
          (
            await tx
              .select()
              .from(jobOutbox)
              .where(
                eq(jobOutbox.deduplicationKey, RULES_REFRESH_DEDUPLICATION_KEY),
              )
              .limit(1)
          )[0];
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.refresh",
          targetType: "rules",
          targetId,
          metadata: { alreadyRunning: !armed },
        });
        return toRulesRefreshStatus(row);
      });
    } else if (resource === "rules" && action === "import") {
      // Rule lists come from the worker's feeds or from an explicit operator
      // upload. There is deliberately no bundled starter list to fall back on,
      // so an import without entries is rejected instead of silently publishing
      // a stub feed as the active routing rules.
      const input = z
        .object({
          profile: z.enum(["ru_blacklist"]),
          version: z.string().trim().min(1).max(96),
          sourceUrl: z.string().trim().min(1).max(2_048).default("manual://import"),
          cidrs: z.array(z.string()).default([]),
          domains: z.array(z.string()).default([]),
          activate: z.boolean().default(true),
        })
        .refine(
          (value) => value.cidrs.length + value.domains.length > 0,
          "An imported rule version must contain at least one entry",
        )
        .parse(payload ?? {});
      return this.options.db.transaction(async (tx) => {
        const now = new Date();
        if (!input.activate) {
          // Nothing else in the rules API can un-publish a live version
          // (`rules/activate` only promotes, `rules/follow` only clears the
          // pin), so `import` must not become the back door for it. Refuse
          // BEFORE any write if this exact (profile, version) row is the one
          // currently serving the profile - quarantining it here would leave
          // the profile with no active version at all.
          const [existing] = await tx
            .select({ status: routeRuleVersions.status })
            .from(routeRuleVersions)
            .where(
              and(
                eq(routeRuleVersions.profile, input.profile),
                eq(routeRuleVersions.version, input.version),
              ),
            );
          if (existing?.status === "active") {
            throw new ApiError(
              409,
              "This version is the profile's active rule set; activate a different version for this profile before quarantining it",
              "RULE_VERSION_ACTIVE",
            );
          }
        }
        if (input.activate) {
          // Demote the incumbent AND drop its pin - both before anything is
          // pinned below, or route_rule_versions_pinned_profile_unique fires
          // mid-transaction.
          await tx
            .update(routeRuleVersions)
            .set({ status: "superseded", pinnedAt: null, updatedAt: now })
            .where(
              and(
                eq(routeRuleVersions.profile, input.profile),
                eq(routeRuleVersions.status, "active"),
              ),
            );
          // Belt and braces, and the repair path for a pin this action itself
          // orphaned before this fix: by invariant only an active row may
          // carry a pin.
          await tx
            .update(routeRuleVersions)
            .set({ pinnedAt: null, updatedAt: now })
            .where(
              and(
                eq(routeRuleVersions.profile, input.profile),
                isNotNull(routeRuleVersions.pinnedAt),
              ),
            );
        }
        const [saved] = await tx
          .insert(routeRuleVersions)
          .values({
            profile: input.profile,
            version: input.version,
            sourceUrl: input.sourceUrl,
            sourceChecksum: input.version,
            status: input.activate ? "active" : "quarantined",
            cidrCount: input.cidrs.length,
            domainCount: input.domains.length,
            payload: { cidrs: input.cidrs, domains: input.domains },
            publishedAt: input.activate ? now : null,
            pinnedAt: input.activate ? now : null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [routeRuleVersions.profile, routeRuleVersions.version],
            set: {
              sourceUrl: input.sourceUrl,
              status: input.activate ? "active" : "quarantined",
              cidrCount: input.cidrs.length,
              domainCount: input.domains.length,
              payload: { cidrs: input.cidrs, domains: input.domains },
              publishedAt: input.activate ? now : null,
              pinnedAt: input.activate ? now : null,
              updatedAt: now,
            },
          })
          .returning();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.import",
          targetType: "rules",
          targetId: saved?.id,
          metadata: {
            profile: input.profile,
            version: input.version,
            pinned: input.activate,
          },
        });
        return saved;
      });
    } else if (resource === "access-sync" && action === "run") {
      // Control-api never talks to Cloudflare itself: this only enqueues the
      // job the hourly timer and every armed user change already run.
      return this.options.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ status: jobOutbox.status })
          .from(jobOutbox)
          .where(eq(jobOutbox.deduplicationKey, ACCESS_SYNC_DEDUPLICATION_KEY))
          .for("update");
        const alreadyRunning =
          existing?.status === "pending" || existing?.status === "processing";
        await this.armAccessSync(tx, "operator");
        const [row] = await tx
          .select()
          .from(jobOutbox)
          .where(eq(jobOutbox.deduplicationKey, ACCESS_SYNC_DEDUPLICATION_KEY))
          .limit(1);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.access-sync.run",
          targetType: "access-sync",
          targetId,
          metadata: { alreadyRunning },
        });
        return toRulesRefreshStatus(row);
      });
    } else if (resource === "users" && action === "purge") {
      // The deliberate, manual, BULK counterpart to the automatic sweep in
      // apps/worker/src/maintenance.ts -- this one is never gated on
      // autoPurgeOffboardedUsers, because an admin choosing to remove an
      // eligible account by hand is exactly the "no" this whole feature exists
      // to let an operator say to the automatic path, not a second instance of
      // the thing being gated. Its target id is always the literal string
      // "offboarded"; the one-at-a-time equivalent is "users"/"delete" above,
      // which takes a real user id and (unlike this one) ignores the
      // retention window entirely -- see the comment there for why.
      //
      // A dry run is the default: without `confirm: true` this reports what
      // would be deleted and deletes nothing. Modeled on deleteNode's
      // `deleteKeys` above -- destructive, so it must be asked for.
      const { confirm } = z
        .object({ confirm: z.boolean().optional() })
        .parse(payload ?? {});
      return this.options.db.transaction(async (tx) => {
        const [policyRow] = await tx
          .select({
            offboardedUserRetentionDays: portalPolicy.offboardedUserRetentionDays,
          })
          .from(portalPolicy)
          .limit(1);
        const retentionDays =
          clampWorkerPeriod(
            "offboardedUserRetentionDays",
            policyRow?.offboardedUserRetentionDays,
          ) ?? WORKER_PERIOD_FIELDS.offboardedUserRetentionDays.fallback;
        const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
        // Same predicate the automatic sweep uses -- see the comment on
        // findOffboardedUsersEligibleForPurge for why this must never fork
        // into a second copy.
        const eligible = await findOffboardedUsersEligibleForPurge(tx, cutoff);
        const deleted: string[] = [];
        if (confirm) {
          for (const user of eligible) {
            await purgeOneOffboardedUser(tx, user.id);
            // Same event the automatic sweep writes (`user.deleted`), but with
            // an actor: the automatic path has none, a manual purge names the
            // admin who asked for it.
            await tx.insert(auditEvents).values({
              actorUserId: actor.id,
              actorType: "user",
              action: "user.deleted",
              targetType: "user",
              targetId: user.id,
              metadata: { email: user.email },
            });
            deleted.push(user.email);
          }
        }
        return {
          confirmed: Boolean(confirm),
          retentionDays,
          eligible: eligible.map((user) => ({
            id: user.id,
            email: user.email,
            disabledAt: user.disabledAt.toISOString(),
            revokedKeyCount: user.revokedKeyCount,
          })),
          deleted,
        };
      });
    } else {
      throw new ApiError(404, "Admin action not found", "NOT_FOUND");
    }
  };

  getRulesRefreshStatus = async (): Promise<RulesRefreshStatus> => {
    const [row] = await this.options.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, RULES_REFRESH_DEDUPLICATION_KEY))
      .limit(1);
    return toRulesRefreshStatus(row);
  };

  // `access.sync` shares job_outbox's shape with `rules.refresh`, and
  // AccessSyncStatus is the same type as RulesRefreshStatus (Task 2), so the
  // same row-to-status mapper applies unchanged.
  getAccessSyncStatus = async (): Promise<AccessSyncStatus> => {
    const [row] = await this.options.db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.deduplicationKey, ACCESS_SYNC_DEDUPLICATION_KEY))
      .limit(1);
    return row ? toRulesRefreshStatus(row) : idleAccessSyncStatus;
  };

  appendAudit = async (event: AuditInput): Promise<void> => {
    await this.options.db.insert(auditEvents).values(event);
  };

  listNodeEgressIps = async (_actor: Actor, nodeId: string): Promise<NodeEgressIp[]> => {
    const [node] = await this.options.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
    const map = await this.loadNodeEgressIpsMap([nodeId]);
    return map.get(nodeId) ?? [];
  };

  createNodeEgressIp = async (
    actor: Actor,
    nodeId: string,
    request: CreateNodeEgressIpRequest,
  ): Promise<NodeEgressIp> => {
    try {
      return await this.options.db.transaction(async (tx) => {
        const [node] = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(eq(nodes.id, nodeId))
          .for("no key update");
        if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
        const existing = await tx
          .select({ routingTableId: nodeEgressIps.routingTableId })
          .from(nodeEgressIps)
          .where(eq(nodeEgressIps.nodeId, nodeId));
        let routingTableId = request.routingTableId ?? null;
        if (routingTableId === null) {
          const used = new Set(
            existing.map((r) => r.routingTableId).filter((id): id is number => id !== null),
          );
          for (let candidate = 200; candidate <= 219; candidate += 1) {
            if (!used.has(candidate)) {
              routingTableId = candidate;
              break;
            }
          }
          if (routingTableId === null) {
            throw new ApiError(
              409,
              "All 20 routing tables (200-219) are allocated on this node",
              "EGRESS_TABLE_EXHAUSTED",
            );
          }
        }
        const [created] = await tx
          .insert(nodeEgressIps)
          .values({
            nodeId,
            ipv4: request.ipv4,
            label: request.label ?? null,
            interfaceName: request.interfaceName ?? null,
            gatewayIpv4: request.gatewayIpv4 ?? null,
            routingTableId,
            dnsPrimary: request.dnsPrimary,
            dnsSecondary: request.dnsSecondary ?? null,
            amneziaDnsDnat: request.amneziaDnsDnat,
            enforceDnsDnat: request.enforceDnsDnat,
            allowAsEntry: request.allowAsEntry,
            enabled: request.enabled,
          })
          .returning();
        if (!created) throw new Error("Exit IP insert returned no row");
        const endpoints = await tx
          .select({ address: nodeVpnEndpoints.address })
          .from(nodeVpnEndpoints)
          .where(eq(nodeVpnEndpoints.nodeId, nodeId));
        await this.enqueueNodeSyncEgress(tx, nodeId);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "node.egress_created",
          targetType: "node",
          targetId: nodeId,
          metadata: {
            egressIpId: created.id,
            ipv4: created.ipv4,
            routingTableId: created.routingTableId,
          },
        });
        return this.toNodeEgressIpView(
          created,
          [...new Set(endpoints.map((ep) => ep.address))],
          0,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, "node_egress_ips_node_ipv4_unique")) {
        throw new ApiError(409, "This Exit IPv4 already exists on this node", "EGRESS_IP_EXISTS");
      }
      if (isUniqueViolation(error, "node_egress_ips_node_table_unique")) {
        throw new ApiError(409, "Routing table ID is already used on this node", "EGRESS_TABLE_IN_USE");
      }
      throw error;
    }
  };

  updateNodeEgressIp = async (
    actor: Actor,
    nodeId: string,
    ipId: string,
    request: UpdateNodeEgressIpRequest,
  ): Promise<NodeEgressIp> => {
    try {
      return await this.options.db.transaction(async (tx) => {
        const [node] = await tx
          .select({
            id: nodes.id,
            egressMode: nodes.egressMode,
            egressModeState: nodes.egressModeState,
            egressDefaultIpId: nodes.egressDefaultIpId,
          })
          .from(nodes)
          .where(eq(nodes.id, nodeId))
          .for("no key update");
        if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
        const [current] = await tx
          .select()
          .from(nodeEgressIps)
          .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)))
          .for("update");
        if (!current) throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
        if (request.enabled === false && current.enabled) {
          if (node.egressModeState === "switching") {
            throw new ApiError(409, "Egress mode switch is already in progress", "EGRESS_MODE_SWITCHING");
          }
          const [inUse] = await tx
            .select({ id: nodeVpnEndpoints.id })
            .from(nodeVpnEndpoints)
            .where(
              and(
                eq(nodeVpnEndpoints.nodeId, nodeId),
                eq(nodeVpnEndpoints.egressIpId, ipId),
                eq(nodeVpnEndpoints.enabled, true),
              ),
            )
            .limit(1);
          if (inUse) {
            throw new ApiError(
              409,
              "Exit IP is assigned to one or more enabled server variants; reassign or disable them first",
              "EGRESS_IP_IN_USE",
            );
          }
          if (node.egressMode === "routed" && node.egressDefaultIpId === ipId) {
            throw new ApiError(
              409,
              "Exit IP is selected as this routed node's default exit; choose another default exit first",
              "EGRESS_IP_IN_USE",
            );
          }
          if (node.egressMode === "routed") {
            const otherEnabled = await tx
              .select({ id: nodeEgressIps.id })
              .from(nodeEgressIps)
              .where(
                and(
                  eq(nodeEgressIps.nodeId, nodeId),
                  ne(nodeEgressIps.id, ipId),
                  eq(nodeEgressIps.enabled, true),
                ),
              )
              .limit(1);
            if (otherEnabled.length === 0) {
              throw new ApiError(
                409,
                "At least one enabled Exit IP must remain on a routed node",
                "LAST_ENABLED_EXIT_REQUIRED",
              );
            }
          }
        }
        const changes: Partial<typeof nodeEgressIps.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (request.label !== undefined) changes.label = request.label ?? null;
        if (request.interfaceName !== undefined) changes.interfaceName = request.interfaceName ?? null;
        if (request.gatewayIpv4 !== undefined) changes.gatewayIpv4 = request.gatewayIpv4 ?? null;
        if (request.routingTableId !== undefined) changes.routingTableId = request.routingTableId ?? null;
        if (request.dnsPrimary !== undefined) changes.dnsPrimary = request.dnsPrimary;
        if (request.dnsSecondary !== undefined) changes.dnsSecondary = request.dnsSecondary ?? null;
        if (request.amneziaDnsDnat !== undefined) changes.amneziaDnsDnat = request.amneziaDnsDnat;
        if (request.enforceDnsDnat !== undefined) changes.enforceDnsDnat = request.enforceDnsDnat;
        if (request.allowAsEntry !== undefined) changes.allowAsEntry = request.allowAsEntry;
        if (request.enabled !== undefined) changes.enabled = request.enabled;
        const [updated] = await tx
          .update(nodeEgressIps)
          .set(changes)
          .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)))
          .returning();
        if (!updated) throw new Error("Exit IP update returned no row");
        if (request.enabled === false && current.enabled) {
          await tx
            .delete(nodeEgressServiceCheckResults)
            .where(eq(nodeEgressServiceCheckResults.egressIpId, ipId));
        }
        const endpoints = await tx
          .select({ address: nodeVpnEndpoints.address, egressIpId: nodeVpnEndpoints.egressIpId })
          .from(nodeVpnEndpoints)
          .where(eq(nodeVpnEndpoints.nodeId, nodeId));
        await this.enqueueNodeSyncEgress(tx, nodeId);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "node.egress_updated",
          targetType: "node",
          targetId: nodeId,
          metadata: {
            egressIpId: ipId,
            ipv4: updated.ipv4,
            fields: Object.keys(request),
          },
        });
        return this.toNodeEgressIpView(
          updated,
          [...new Set(endpoints.map((ep) => ep.address))],
          endpoints.filter((ep) => ep.egressIpId === ipId).length,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, "node_egress_ips_node_table_unique")) {
        throw new ApiError(409, "Routing table ID is already used on this node", "EGRESS_TABLE_IN_USE");
      }
      throw error;
    }
  };

  deleteNodeEgressIp = async (
    actor: Actor,
    nodeId: string,
    ipId: string,
  ): Promise<{ id: string; deleted: boolean; affectedEndpoints: number }> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({
          id: nodes.id,
          egressMode: nodes.egressMode,
          egressModeState: nodes.egressModeState,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      if (node.egressModeState === "switching") {
        throw new ApiError(409, "Egress mode switch is already in progress", "EGRESS_MODE_SWITCHING");
      }
      const [current] = await tx
        .select({ id: nodeEgressIps.id, ipv4: nodeEgressIps.ipv4 })
        .from(nodeEgressIps)
        .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)))
        .for("update");
      if (!current) throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
      const [inUse] = await tx
        .select({ id: nodeVpnEndpoints.id })
        .from(nodeVpnEndpoints)
        .where(and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.egressIpId, ipId)))
        .limit(1);
      if (inUse) {
        throw new ApiError(
          409,
          "Exit IP is assigned to one or more server variants; reassign or remove them first",
          "EGRESS_IP_IN_USE",
        );
      }
      if (node.egressMode === "routed") {
        const otherEnabled = await tx
          .select({ id: nodeEgressIps.id })
          .from(nodeEgressIps)
          .where(
            and(
              eq(nodeEgressIps.nodeId, nodeId),
              ne(nodeEgressIps.id, ipId),
              eq(nodeEgressIps.enabled, true),
            ),
          )
          .limit(1);
        if (otherEnabled.length === 0) {
          throw new ApiError(
            409,
            "At least one enabled Exit IP must remain on a routed node",
            "LAST_ENABLED_EXIT_REQUIRED",
          );
        }
      }
      await tx
        .update(nodes)
        .set({ egressDefaultIpId: null, updatedAt: new Date() })
        .where(and(eq(nodes.id, nodeId), eq(nodes.egressDefaultIpId, ipId)));
      const affectedEndpoints = await tx
        .select({
          id: nodeVpnEndpoints.id,
          egressAutoRotatePoolIds: nodeVpnEndpoints.egressAutoRotatePoolIds,
        })
        .from(nodeVpnEndpoints)
        .where(eq(nodeVpnEndpoints.nodeId, nodeId));
      for (const ep of affectedEndpoints) {
        const pool = ep.egressAutoRotatePoolIds ?? [];
        if (!pool.includes(ipId)) continue;
        const filtered = pool.filter((id) => id !== ipId);
        await tx
          .update(nodeVpnEndpoints)
          .set({
            egressAutoRotatePoolIds: filtered,
            ...(filtered.length === 0 ? { egressAutoRotateEnabled: false } : {}),
          })
          .where(eq(nodeVpnEndpoints.id, ep.id));
      }
      await tx
        .delete(nodeEgressIps)
        .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)));
      await this.enqueueNodeSyncEgress(tx, nodeId);
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.egress_deleted",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          egressIpId: ipId,
          ipv4: current.ipv4,
          affectedEndpoints: 0,
        },
      });
      return {
        id: ipId,
        deleted: true,
        affectedEndpoints: 0,
      };
    });

  swapNodeEgressIp = async (
    actor: Actor,
    nodeId: string,
    ipId: string,
    request: SwapNodeEgressIpRequest,
  ): Promise<{ ip: NodeEgressIp; replacedIpv4: string; affectedEndpoints: number }> => {
    try {
      return await this.options.db.transaction(async (tx) => {
        const [node] = await tx
          .select({ egressDefaultIpId: nodes.egressDefaultIpId })
          .from(nodes)
          .where(eq(nodes.id, nodeId))
          .limit(1);
        const [current] = await tx
          .select()
          .from(nodeEgressIps)
          .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)))
          .for("update");
        if (!current) throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
        const [updated] = await tx
          .update(nodeEgressIps)
          .set({
            ipv4: request.ipv4,
            // Reset NIC/gateway overrides unless the caller supplies values for the new IP,
            // so egress-daemon auto-discovers the new subnet rather than keeping stale routes.
            interfaceName: request.interfaceName ?? null,
            gatewayIpv4: request.gatewayIpv4 ?? null,
            ...(request.label !== undefined ? { label: request.label ?? null } : {}),
            hostState: "pending",
            hostDetail: null,
            observedSubnetCidr: null,
            detectedGatewayIpv4: null,
            txBytes: 0n,
            txPackets: 0n,
            hostObservedAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)))
          .returning();
        if (!updated) throw new Error("Exit IP swap returned no row");
        await tx
          .delete(nodeEgressServiceCheckResults)
          .where(eq(nodeEgressServiceCheckResults.egressIpId, ipId));
        const touchedEndpoints = await tx
          .update(nodeVpnEndpoints)
          .set({
            probeObservedEgressIp: null,
            probeEgressMatch: null,
            probeStatus: null,
            probeLevels: null,
            probeCheckedAt: null,
            probeConsecutiveFailures: 0,
            probeFailingSince: null,
            probeDetail: null,
            probeAlertedAt: null,
            probeAlertKind: null,
            revision: sql`${nodeVpnEndpoints.revision} + 1`,
          })
          .where(
            node?.egressDefaultIpId === ipId
              ? and(
                  eq(nodeVpnEndpoints.nodeId, nodeId),
                  or(
                    eq(nodeVpnEndpoints.egressIpId, ipId),
                    isNull(nodeVpnEndpoints.egressIpId),
                  ),
                )
              : and(eq(nodeVpnEndpoints.nodeId, nodeId), eq(nodeVpnEndpoints.egressIpId, ipId)),
          )
          .returning({ id: nodeVpnEndpoints.id });
        const allEndpoints = await tx
          .select({ address: nodeVpnEndpoints.address, egressIpId: nodeVpnEndpoints.egressIpId })
          .from(nodeVpnEndpoints)
          .where(eq(nodeVpnEndpoints.nodeId, nodeId));
        await this.enqueueNodeSyncEgress(tx, nodeId);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "node.egress_swapped",
          targetType: "node",
          targetId: nodeId,
          metadata: {
            egressIpId: ipId,
            fromIpv4: current.ipv4,
            toIpv4: request.ipv4,
            affectedEndpoints: touchedEndpoints.length,
          },
        });
        return {
          ip: this.toNodeEgressIpView(
            updated,
            [...new Set(allEndpoints.map((ep) => ep.address))],
            allEndpoints.filter((ep) => ep.egressIpId === ipId).length,
          ),
          replacedIpv4: current.ipv4,
          affectedEndpoints: touchedEndpoints.length,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, "node_egress_ips_node_ipv4_unique")) {
        throw new ApiError(409, "Target Exit IPv4 already exists on this node", "EGRESS_IP_EXISTS");
      }
      throw error;
    }
  };

  getNodeEgressVerifyTarget = async (
    nodeId: string,
    ipId: string,
  ): Promise<NodeEgressVerifyTarget | null> => {
    const [row] = await this.options.db
      .select({
        nodeId: nodes.id,
        apiBaseUrl: nodes.apiBaseUrl,
        ciphertext: nodes.credentialsCiphertext,
        nonce: nodes.credentialsNonce,
        authTag: nodes.credentialsAuthTag,
        keyVersion: nodes.credentialsKeyVersion,
        egressIpId: nodeEgressIps.id,
        egressIpv4: nodeEgressIps.ipv4,
        dnsPrimary: nodeEgressIps.dnsPrimary,
      })
      .from(nodeEgressIps)
      .innerJoin(nodes, eq(nodes.id, nodeEgressIps.nodeId))
      .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.id, ipId)))
      .limit(1);
    if (!row) return null;
    const [probe] = await this.options.db
      .select({ egressUrl: reachabilityProbe.egressUrl })
      .from(reachabilityProbe)
      .limit(1);
    return {
      nodeId: row.nodeId,
      apiBaseUrl: row.apiBaseUrl,
      credentials: {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      egressIpId: row.egressIpId,
      egressIpv4: row.egressIpv4,
      dnsPrimary: row.dnsPrimary,
      probeUrl: probe?.egressUrl ?? null,
    };
  };

  setNodeEgressMode = async (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeEgressModeRequest,
  ): Promise<{ nodeId: string; mode: NodeEgressMode; state: NodeEgressModeState; queued: boolean }> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({
          id: nodes.id,
          protocol: nodes.protocol,
          capabilities: nodes.capabilities,
          egressMode: nodes.egressMode,
          egressModeState: nodes.egressModeState,
          egressDaemonState: nodes.egressDaemonState,
          hostNetworkReport: nodes.hostNetworkReport,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      if (node.egressModeState === "switching") {
        throw new ApiError(409, "Egress mode switch is already in progress", "EGRESS_MODE_SWITCHING");
      }
      if (!deriveSupportedProtocols(node.protocol, node.capabilities).includes("awg3")) {
        throw new ApiError(409, "Multi-exit routing requires AWG 3.1 on this node", "NODE_ENDPOINT_NOT_AWG3");
      }
      if (node.egressDaemonState === "unavailable") {
        throw new ApiError(
          409,
          "Egress daemon is currently unavailable on this node",
          "EGRESS_DAEMON_UNAVAILABLE",
        );
      }
      const tunnelConflict =
        node.hostNetworkReport &&
        typeof node.hostNetworkReport === "object" &&
        "tunnelSubnetConflict" in node.hostNetworkReport &&
        (node.hostNetworkReport as { tunnelSubnetConflict?: unknown }).tunnelSubnetConflict === true;
      if (request.mode === "routed") {
        if (tunnelConflict) {
          throw new ApiError(
            409,
            "Host subnet conflicts with AWG 3.1 tunnel subnet; resolve conflict before switching to routed mode",
            "EGRESS_SUBNET_CONFLICT",
          );
        }
        const enabledIps = await tx
          .select({ id: nodeEgressIps.id })
          .from(nodeEgressIps)
          .where(and(eq(nodeEgressIps.nodeId, nodeId), eq(nodeEgressIps.enabled, true)))
          .limit(1);
        if (enabledIps.length === 0) {
          throw new ApiError(
            409,
            "Add and enable at least one Exit IP before switching to routed mode",
            "EGRESS_IP_REQUIRED",
          );
        }
      }
      const now = new Date();
      // Keep nodes.egressMode at the active mode until the worker confirms the switch.
      await tx
        .update(nodes)
        .set({
          egressModeState: "switching",
          egressModeMessage: null,
          egressModeAt: now,
          ...(request.blockSmtp !== undefined ? { egressBlockSmtp: request.blockSmtp } : {}),
          ...(request.isolatePrivate !== undefined ? { egressIsolatePrivate: request.isolatePrivate } : {}),
          updatedAt: now,
        })
        .where(eq(nodes.id, nodeId));
      await tx.insert(jobOutbox).values({
        type: NODE_SWITCH_EGRESS_MODE_JOB_TYPE,
        deduplicationKey: `${NODE_SWITCH_EGRESS_MODE_JOB_TYPE}:${nodeId}:${randomUUID()}`,
        payload: {
          nodeId,
          mode: request.mode,
          previousMode: node.egressMode,
          ...(request.blockSmtp !== undefined ? { blockSmtp: request.blockSmtp } : {}),
          ...(request.isolatePrivate !== undefined ? { isolatePrivate: request.isolatePrivate } : {}),
        },
      });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.egress_mode_requested",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          previousMode: node.egressMode,
          mode: request.mode,
          blockSmtp: request.blockSmtp,
          isolatePrivate: request.isolatePrivate,
        },
        createdAt: now,
      });
      return {
        nodeId,
        mode: request.mode,
        state: "switching",
        queued: true,
      };
    });

  adoptNodeEgressMode = async (
    actor: Actor,
    nodeId: string,
  ): Promise<{ nodeId: string; mode: NodeEgressMode; state: NodeEgressModeState }> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({
          id: nodes.id,
          egressMode: nodes.egressMode,
          hostNetworkReport: nodes.hostNetworkReport,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      const observedMode =
        node.hostNetworkReport &&
        typeof node.hostNetworkReport === "object" &&
        "observedMode" in node.hostNetworkReport
          ? (node.hostNetworkReport as { observedMode?: unknown }).observedMode
          : undefined;
      if (observedMode !== "masquerade" && observedMode !== "routed") {
        throw new ApiError(
          409,
          "No host egress observation available to adopt on this node",
          "EGRESS_DAEMON_UNAVAILABLE",
        );
      }
      const now = new Date();
      await tx
        .update(nodes)
        .set({
          egressMode: observedMode,
          egressModeState: "idle",
          egressModeMessage: "Adopted observed host egress mode",
          egressModeAt: now,
          updatedAt: now,
        })
        .where(eq(nodes.id, nodeId));
      await this.enqueueNodeSyncEgress(tx, nodeId);
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.egress_mode_adopted",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          previousMode: node.egressMode,
          adoptedMode: observedMode,
        },
        createdAt: now,
      });
      return {
        nodeId,
        mode: observedMode,
        state: "idle",
      };
    });

  reassignKeyEndpoint = async (
    actor: Actor,
    keyId: string,
    request: AdminReassignKeyEndpointRequest,
  ): Promise<{ id: string; nodeId: string; endpointId: string; previousEndpointId: string | null }> =>
    this.options.db.transaction(async (tx) => {
      const [key] = await tx
        .select({
          id: vpnKeys.id,
          nodeId: vpnKeys.nodeId,
          endpointId: vpnKeys.endpointId,
          protocol: vpnKeys.protocol,
          state: vpnKeys.state,
          serviceAccount: users.serviceAccount,
        })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(eq(vpnKeys.id, keyId))
        .for("update", { of: vpnKeys });
      if (!key) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
      if (key.serviceAccount) {
        throw new ApiError(409, "Service account keys cannot be reassigned manually", "SERVICE_ACCOUNT");
      }
      if (key.protocol !== "awg3") {
        throw new ApiError(409, "Endpoint reassignment is supported only for AWG 3.1 keys", "NODE_ENDPOINT_NOT_AWG3");
      }
      if (key.state === "revoked" || key.state === "revoking") {
        throw new ApiError(409, "Cannot reassign a revoked key", "KEY_NOT_ACTIVE");
      }
      const [targetEndpoint] = await tx
        .select({
          id: nodeVpnEndpoints.id,
          nodeId: nodeVpnEndpoints.nodeId,
          enabled: nodeVpnEndpoints.enabled,
          enabledProtocols: nodeVpnEndpoints.enabledProtocols,
          address: nodeVpnEndpoints.address,
          egressIpId: nodeVpnEndpoints.egressIpId,
        })
        .from(nodeVpnEndpoints)
        .where(eq(nodeVpnEndpoints.id, request.endpointId))
        .limit(1);
      if (!targetEndpoint) {
        throw new ApiError(404, "Endpoint not found", "NODE_ENDPOINT_NOT_FOUND");
      }
      if (targetEndpoint.nodeId !== key.nodeId) {
        throw new ApiError(
          409,
          "Target endpoint belongs to a different node",
          "KEY_REASSIGN_WRONG_NODE",
        );
      }
      if (!targetEndpoint.enabled) {
        throw new ApiError(
          409,
          "Target endpoint is disabled on this node",
          "NODE_ENDPOINT_UNAVAILABLE",
        );
      }
      if (!endpointAllowsProtocol(targetEndpoint, key.protocol)) {
        throw new ApiError(
          403,
          "Selected protocol is not permitted on this address",
          "PROTOCOL_NOT_ALLOWED",
        );
      }
      if (key.endpointId !== request.endpointId) {
        const [previousEndpoint] = await tx
          .select({
            id: nodeVpnEndpoints.id,
            address: nodeVpnEndpoints.address,
            egressIpId: nodeVpnEndpoints.egressIpId,
          })
          .from(nodeVpnEndpoints)
          .where(
            key.endpointId
              ? eq(nodeVpnEndpoints.id, key.endpointId)
              : and(eq(nodeVpnEndpoints.nodeId, key.nodeId), eq(nodeVpnEndpoints.ordinal, 1)),
          )
          .limit(1);
        const endpointTransportChanged =
          !previousEndpoint ||
          previousEndpoint.address !== targetEndpoint.address ||
          (previousEndpoint.egressIpId ?? null) !== (targetEndpoint.egressIpId ?? null);
        await tx
          .update(vpnKeys)
          .set({
            endpointId: request.endpointId,
            ...(endpointTransportChanged ? { configDeliveredAt: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(vpnKeys.id, key.id));
        await this.enqueueNodeSyncEgress(tx, key.nodeId);
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.keys.endpoint_reassigned",
          targetType: "vpn_key",
          targetId: key.id,
          metadata: {
            nodeId: key.nodeId,
            previousEndpointId: key.endpointId,
            endpointId: request.endpointId,
          },
        });
      }
      return {
        id: key.id,
        nodeId: key.nodeId,
        endpointId: request.endpointId,
        previousEndpointId: key.endpointId,
      };
    });

  notifyNodeKeyUpdate = async (
    actor: Actor,
    nodeId: string,
    request: NotifyKeyUpdateRequest,
  ): Promise<NotifyKeyUpdateResult> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      const now = new Date();
      const note = request.note ?? null;
      await tx
        .update(nodes)
        .set({ keyUpdateNotifiedAt: now, keyUpdateNotifyNote: note, updatedAt: now })
        .where(eq(nodes.id, nodeId));
      const [affected] = await tx
        .select({ value: count() })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(
          and(
            eq(vpnKeys.nodeId, nodeId),
            eq(vpnKeys.state, "active"),
            eq(users.serviceAccount, false),
          ),
        );
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.key_update_notified",
        targetType: "node",
        targetId: nodeId,
        metadata: { scope: "node", note, affectedActiveKeys: affected?.value ?? 0 },
      });
      return {
        scope: "node",
        notifiedAt: now.toISOString(),
        note,
        affectedActiveKeys: affected?.value ?? 0,
      };
    });

  clearNodeKeyUpdate = async (
    actor: Actor,
    nodeId: string,
  ): Promise<NotifyKeyUpdateResult> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      await tx
        .update(nodes)
        .set({ keyUpdateNotifiedAt: null, keyUpdateNotifyNote: null, updatedAt: new Date() })
        .where(eq(nodes.id, nodeId));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.key_update_notice_cleared",
        targetType: "node",
        targetId: nodeId,
        metadata: { scope: "node" },
      });
      return { scope: "node", notifiedAt: null, note: null, affectedActiveKeys: 0 };
    });

  notifyNodeEgressIpKeyUpdate = async (
    actor: Actor,
    nodeId: string,
    ipId: string,
    request: NotifyKeyUpdateRequest,
  ): Promise<NotifyKeyUpdateResult> =>
    this.options.db.transaction(async (tx) => {
      const [node] = await tx
        .select({
          id: nodes.id,
          publicIp: nodes.publicIp,
          egressMode: nodes.egressMode,
          egressDefaultIpId: nodes.egressDefaultIpId,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("no key update");
      if (!node) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");
      const [exitIp] = await tx
        .select({ id: nodeEgressIps.id, ipv4: nodeEgressIps.ipv4 })
        .from(nodeEgressIps)
        .where(and(eq(nodeEgressIps.id, ipId), eq(nodeEgressIps.nodeId, nodeId)))
        .for("update");
      if (!exitIp) {
        throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
      }
      const now = new Date();
      const note = request.note ?? null;
      await tx
        .update(nodeEgressIps)
        .set({ keyUpdateNotifiedAt: now, keyUpdateNotifyNote: note, updatedAt: now })
        .where(eq(nodeEgressIps.id, ipId));
      const [endpoints, activeKeys] = await Promise.all([
        tx
          .select({
            id: nodeVpnEndpoints.id,
            ordinal: nodeVpnEndpoints.ordinal,
            address: nodeVpnEndpoints.address,
            egressIpId: nodeVpnEndpoints.egressIpId,
          })
          .from(nodeVpnEndpoints)
          .where(eq(nodeVpnEndpoints.nodeId, nodeId)),
        tx
          .select({
            endpointId: vpnKeys.endpointId,
            protocol: vpnKeys.protocol,
          })
          .from(vpnKeys)
          .innerJoin(users, eq(users.id, vpnKeys.ownerId))
          .where(
            and(
              eq(vpnKeys.nodeId, nodeId),
              eq(vpnKeys.state, "active"),
              eq(users.serviceAccount, false),
            ),
          ),
      ]);
      const epById = new Map(endpoints.map((ep) => [ep.id, ep]));
      const primaryEp = endpoints.find((ep) => ep.ordinal === 1) ?? endpoints[0];
      let affectedActiveKeys = 0;
      for (const k of activeKeys) {
        const { exitIp: resolved } = resolveEffectiveKeyAttachment({
          protocol: k.protocol,
          endpointId: k.endpointId,
          endpointsById: epById,
          primaryEndpoint: primaryEp,
          nodePublicIp: node.publicIp,
          nodeEgressMode: node.egressMode,
          nodeEgressDefaultIpId: node.egressDefaultIpId,
          nodeEgressIps: [exitIp],
        });
        if (resolved?.id === ipId) affectedActiveKeys += 1;
      }
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.egress_key_update_notified",
        targetType: "node",
        targetId: nodeId,
        metadata: { scope: "exit", egressIpId: ipId, note, affectedActiveKeys },
      });
      return {
        scope: "exit",
        notifiedAt: now.toISOString(),
        note,
        affectedActiveKeys,
      };
    });

  clearNodeEgressIpKeyUpdate = async (
    actor: Actor,
    nodeId: string,
    ipId: string,
  ): Promise<NotifyKeyUpdateResult> =>
    this.options.db.transaction(async (tx) => {
      const [exitIp] = await tx
        .select({ id: nodeEgressIps.id })
        .from(nodeEgressIps)
        .where(and(eq(nodeEgressIps.id, ipId), eq(nodeEgressIps.nodeId, nodeId)))
        .for("update");
      if (!exitIp) {
        throw new ApiError(404, "Exit IP not found on node", "NODE_EGRESS_IP_NOT_FOUND");
      }
      await tx
        .update(nodeEgressIps)
        .set({ keyUpdateNotifiedAt: null, keyUpdateNotifyNote: null, updatedAt: new Date() })
        .where(eq(nodeEgressIps.id, ipId));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.egress_key_update_notice_cleared",
        targetType: "node",
        targetId: nodeId,
        metadata: { scope: "exit", egressIpId: ipId },
      });
      return { scope: "exit", notifiedAt: null, note: null, affectedActiveKeys: 0 };
    });

  notifyNodeEndpointKeyUpdate = async (
    actor: Actor,
    nodeId: string,
    endpointId: string,
    request: NotifyKeyUpdateRequest,
  ): Promise<NotifyKeyUpdateResult> =>
    this.options.db.transaction(async (tx) => {
      const [endpoint] = await tx
        .select({ id: nodeVpnEndpoints.id, ordinal: nodeVpnEndpoints.ordinal })
        .from(nodeVpnEndpoints)
        .where(and(eq(nodeVpnEndpoints.id, endpointId), eq(nodeVpnEndpoints.nodeId, nodeId)))
        .for("update");
      if (!endpoint) {
        throw new ApiError(404, "Address not found on this node", "NODE_ENDPOINT_NOT_FOUND");
      }
      const now = new Date();
      const note = request.note ?? null;
      await tx
        .update(nodeVpnEndpoints)
        .set({ keyUpdateNotifiedAt: now, keyUpdateNotifyNote: note })
        .where(eq(nodeVpnEndpoints.id, endpointId));
      const [affected] = await tx
        .select({ value: count() })
        .from(vpnKeys)
        .innerJoin(users, eq(users.id, vpnKeys.ownerId))
        .where(
          and(
            eq(vpnKeys.nodeId, nodeId),
            eq(vpnKeys.state, "active"),
            eq(vpnKeys.protocol, "awg3"),
            eq(users.serviceAccount, false),
            endpoint.ordinal === 1
              ? or(eq(vpnKeys.endpointId, endpointId), isNull(vpnKeys.endpointId))
              : eq(vpnKeys.endpointId, endpointId),
          ),
        );
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.endpoint_key_update_notified",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          scope: "endpoint",
          endpointId,
          note,
          affectedActiveKeys: affected?.value ?? 0,
        },
      });
      return {
        scope: "endpoint",
        notifiedAt: now.toISOString(),
        note,
        affectedActiveKeys: affected?.value ?? 0,
      };
    });

  clearNodeEndpointKeyUpdate = async (
    actor: Actor,
    nodeId: string,
    endpointId: string,
  ): Promise<NotifyKeyUpdateResult> =>
    this.options.db.transaction(async (tx) => {
      const [endpoint] = await tx
        .select({ id: nodeVpnEndpoints.id })
        .from(nodeVpnEndpoints)
        .where(and(eq(nodeVpnEndpoints.id, endpointId), eq(nodeVpnEndpoints.nodeId, nodeId)))
        .for("update");
      if (!endpoint) {
        throw new ApiError(404, "Address not found on this node", "NODE_ENDPOINT_NOT_FOUND");
      }
      await tx
        .update(nodeVpnEndpoints)
        .set({ keyUpdateNotifiedAt: null, keyUpdateNotifyNote: null })
        .where(eq(nodeVpnEndpoints.id, endpointId));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.endpoint_key_update_notice_cleared",
        targetType: "node",
        targetId: nodeId,
        metadata: { scope: "endpoint", endpointId },
      });
      return { scope: "endpoint", notifiedAt: null, note: null, affectedActiveKeys: 0 };
    });
}
