import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  or,
  sql,
  sum,
} from "drizzle-orm";
import type {
  CreateNodeRequest,
  CreateServiceCheckRequest,
  CreateKeyRequest,
  CreateUserRequest,
  CustomRoutes,
  DeleteNodeOptions,
  GlobalRoutes,
  KeyLimitMode,
  KeyState,
  PortalPolicy,
  PortalPolicyOverride,
  ProtocolKind,
  QuotaRequest,
  RouteProfile,
  RulesRefreshStatus,
  UpdateNodeRequest,
  UpdateServiceCheckRequest,
} from "@amnezia/contracts";
import { nodeRunsCheck, toUserCheckState } from "@amnezia/contracts";
import type { ServiceCheckUserState } from "@amnezia/contracts";
import {
  createKeyRequestSchema,
  customRoutesSchema,
  DEFAULT_ALLOWED_PROTOCOLS,
  defaultPortalPolicy,
  emptyGlobalRoutes,
  globalRoutesSchema,
  installGuideVideosSchema,
  isPublishableAgentImage,
  nodeAgentUpdateActionSchema,
  nodeOrderSchema,
  PROTOCOL_KINDS,
  recommendedNodeIdsSchema,
  portalPolicyOverrideSchema,
  portalPolicySchema,
  RULES_REFRESH_DEDUPLICATION_KEY,
  RULES_REFRESH_JOB_TYPE,
  setUserLimitRequestSchema,
  updateGlobalRoutesRequestSchema,
} from "@amnezia/contracts";
import {
  auditEvents,
  decryptSecret,
  deterministicPeerLabel,
  encryptSecret,
  globalRouteOverrides,
  identities,
  jobOutbox,
  nodeAgentReleases,
  nodeMetricsCurrent,
  nodeServiceCheckResults,
  nodeServiceChecks,
  nodes,
  peerCurrent,
  portalPolicy,
  quotaRequests,
  resolvePortalPolicy,
  routeRuleVersions,
  trafficRollups,
  users,
  vpnKeys,
  type Database,
  type EncryptionKeyring,
} from "@amnezia/db";
import type {
  ActiveRule,
  AuditInput,
  ControlRepository,
  NodeTrafficPeriods,
  RouteProfileAvailability,
  StoredKeyConfig,
} from "./repository.js";
import { ApiError, type Actor, type IdentityClaim, type KeyView } from "./service.js";
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

const quotaStates: KeyState[] = ["provisioning", "active", "disabled"];

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
  // Global-only, exactly like defaultKeyLimit above: keeping them out of
  // portalPolicySchema is what stops them being overridable per user.
  recommendedNodeIds: recommendedNodeIdsSchema.optional(),
  nodeOrder: nodeOrderSchema.optional(),
  // Accept the pre-0017 null as "no videos" instead of refusing the request.
  // Null and {} mean the same thing here, and a client echoing back a row it
  // read from an older panel must not be unable to save anything at all.
  installGuideVideos: installGuideVideosSchema
    .nullish()
    .transform((value) => value ?? {})
    .optional(),
});

type PortalPolicyRow = typeof portalPolicy.$inferSelect;

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
  ru_whitelist: {
    add: dedupeGlobalRouteList(routes.ru_whitelist.add),
    exclude: dedupeGlobalRouteList(routes.ru_whitelist.exclude),
  },
  ru_blacklist: {
    add: dedupeGlobalRouteList(routes.ru_blacklist.add),
    exclude: dedupeGlobalRouteList(routes.ru_blacklist.exclude),
  },
});

// Audit metadata for a global-routes update: sizes only, never the entries.
const globalRouteCounts = (routes: GlobalRoutes): Record<string, number> => ({
  whitelistAddCidrs: routes.ru_whitelist.add.cidrs.length,
  whitelistAddDomains: routes.ru_whitelist.add.domains.length,
  whitelistExcludeCidrs: routes.ru_whitelist.exclude.cidrs.length,
  whitelistExcludeDomains: routes.ru_whitelist.exclude.domains.length,
  blacklistAddCidrs: routes.ru_blacklist.add.cidrs.length,
  blacklistAddDomains: routes.ru_blacklist.add.domains.length,
  blacklistExcludeCidrs: routes.ru_blacklist.exclude.cidrs.length,
  blacklistExcludeDomains: routes.ru_blacklist.exclude.domains.length,
});

// Canonicalize a validated custom-routes object: de-duplicate each list so the
// stored value and the export-time union stay minimal.
const dedupeCustomRoutes = (routes: CustomRoutes): CustomRoutes => ({
  ru_whitelist: {
    cidrs: [...new Set(routes.ru_whitelist.cidrs)],
    domains: [...new Set(routes.ru_whitelist.domains)],
  },
  ru_blacklist: {
    cidrs: [...new Set(routes.ru_blacklist.cidrs)],
    domains: [...new Set(routes.ru_blacklist.domains)],
  },
});

const toPolicy = (row: PortalPolicyRow | undefined): PortalPolicy =>
  row
    ? {
        allowKeyCreation: row.allowKeyCreation,
        allowNodeSelection: row.allowNodeSelection,
        allowedProtocols:
          row.allowedProtocols && row.allowedProtocols.length > 0
            ? row.allowedProtocols
            : DEFAULT_ALLOWED_PROTOCOLS,
        allowedNodeIds: row.allowedNodeIds ?? null,
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
        showPublicKey: row.showPublicKey,
        showLastUsed: row.showLastUsed,
        showTraffic: row.showTraffic,
        showNodeStatus: row.showNodeStatus,
        showNodeAddress: row.showNodeAddress,
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
 * `node_service_checks_name_unique` exists so two checks cannot share a name -
 * the name is what a user sees on a chip, and two "Gemini" chips with different
 * verdicts are unreadable. Without this translation an admin retyping a name
 * gets a 500 for an ordinary mistake.
 */
const isUniqueViolation = (error: unknown): boolean => {
  // drizzle wraps the driver's error, so the SQLSTATE is on `cause`, not on the
  // error it throws. Checking only the top level looks right, passes a unit
  // test with a hand-made error, and never fires against a real database -
  // which is exactly what it did until CI ran it against Postgres.
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: string }).code === "23505"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const duplicateCheckName = (error: unknown): unknown =>
  isUniqueViolation(error)
    ? new ApiError(409, "A check with this name already exists", "CHECK_NAME_TAKEN")
    : error;

export class PostgresControlRepository implements ControlRepository {
  private readonly activeKeyVersion: number;

  constructor(private readonly options: PostgresRepositoryOptions) {
    this.activeKeyVersion =
      options.activeKeyVersion ??
      Math.max(...Object.keys(options.keyring).map(Number));
    if (!options.keyring[this.activeKeyVersion]) {
      throw new Error("The active encryption key version is not in the keyring");
    }
  }

  resolveIdentity = async (claim: IdentityClaim): Promise<Actor> => {
    const email = normalizeEmail(claim.email);
    return this.options.db.transaction(async (tx) => {
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
          const allowed =
            this.options.allowedEmailDomains?.has(domain) ||
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
    };
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

  listNodes = async (actor: Actor): Promise<unknown[]> => {
    const [rows, policyRow, userRow, checkRows] = await Promise.all([
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
          checksEnabled: nodes.checksEnabled,
          disabledCheckIds: nodes.disabledCheckIds,
        })
        .from(nodes)
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
    }
    const nodeOrder = policyRow[0]?.nodeOrder ?? [];
    // A null/absent allowedNodeIds means "all nodes"; a list restricts to it.
    // The SELECT above has no ORDER BY and the worker rewrites node rows on
    // every telemetry poll, so the order is fixed here, on the name the user
    // sees — after the availability filter, never before it.
    return orderNodesForUsers(
      rows
        .filter((row) => isNodeAvailable(policy.allowedNodeIds, row.id))
        .map(
          ({
            capabilities,
            enabledProtocols,
            publicName,
            publicHost,
            publicIp,
            checksEnabled,
            disabledCheckIds,
            ...row
          }) => {
            const supportedProtocols = deriveSupportedProtocols(
              row.protocol,
              capabilities,
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
            return {
              ...row,
              // Users see the public name; the internal admin name never leaves here.
              name: publicName ?? row.name,
              recommended: recommended.has(row.id),
              // Spread conditionally rather than assigning `undefined`: there is no
              // "unknown address" state on the user side, so the key must be truly
              // absent — a user cannot fix a node's DNS, and a null would only
              // invite the UI to render an empty line.
              ...(publicAddress === null ? {} : { publicAddress }),
              supportedProtocols,
              selectableProtocols: computeSelectableProtocols(
                supportedProtocols,
                enabledProtocols,
                policy.allowedProtocols,
              ),
              // Only `checks`, deliberately. There is no node state word here
              // and there must never be one: node health is already shown from
              // enabled/lastError/lastHealthAt, and a second vocabulary for the
              // same thing is what the three-state narrowing exists to prevent.
              // Only checks this node actually runs. A chip for one it has
              // been taken out of would show a user a verdict that will never
              // change again - worse than showing nothing, because it looks
              // live. Destructured above so the two flags cannot leak into the
              // user payload with the rest of the row.
              ...(policy.showNodeStatus
                ? {
                    status: {
                      checks: (checksByNode.get(row.id) ?? []).filter((chip) =>
                        nodeRunsCheck(
                          { checksEnabled, disabledCheckIds },
                          chip.checkId,
                        ),
                      ).map(({ name, state }) => ({ name, state })),
                    },
                  }
                : {}),
            };
          },
        ),
      nodeOrder,
    );
  };

  createUser = async (
    actor: Actor,
    request: CreateUserRequest,
  ): Promise<unknown> => {
    const email = normalizeEmail(request.email);
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
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApiError(409, "Node name already exists", "NODE_EXISTS");
      }
      throw error;
    }
  };

  updateNode = async (
    actor: Actor,
    nodeId: string,
    request: UpdateNodeRequest,
  ): Promise<unknown> =>
    this.options.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for("update");
      if (!current) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");

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
          updatedAt: nodes.updatedAt,
        });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.updated",
        targetType: "node",
        targetId: nodeId,
        metadata: { fields: Object.keys(request) },
      });
      return updated;
    });

  deleteNode = async (
    actor: Actor,
    nodeId: string,
    options: DeleteNodeOptions = { deleteKeys: false },
  ): Promise<unknown> =>
    this.options.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: nodes.id, name: nodes.name })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (!existing) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");

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
      const [policyRow] = await tx
        .select({
          recommendedNodeIds: portalPolicy.recommendedNodeIds,
          nodeOrder: portalPolicy.nodeOrder,
        })
        .from(portalPolicy)
        .limit(1);
      let scrubbedFromRecommended = false;
      let scrubbedFromOrder = false;
      if (policyRow) {
        scrubbedFromRecommended = policyRow.recommendedNodeIds.includes(nodeId);
        scrubbedFromOrder = policyRow.nodeOrder.includes(nodeId);
        if (scrubbedFromRecommended || scrubbedFromOrder) {
          await tx
            .update(portalPolicy)
            .set({
              recommendedNodeIds: policyRow.recommendedNodeIds.filter(
                (id) => id !== nodeId,
              ),
              // Removing an element shifts the rest up by one, which is exactly
              // right: positions are relative, so the surviving order is kept.
              // Filtering the same id out of both lists also preserves the
              // "recommended must be a prefix of the order" invariant, so this
              // path needs no reconciliation of its own.
              nodeOrder: policyRow.nodeOrder.filter((id) => id !== nodeId),
              updatedAt: new Date(),
            })
            .where(eq(portalPolicy.id, true));
        }
      }

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

  listKeys = async (actor: Actor): Promise<KeyView[]> => {
    const rows = await this.options.db
      .select({ key: vpnKeys, current: peerCurrent })
      .from(vpnKeys)
      .leftJoin(peerCurrent, eq(peerCurrent.keyId, vpnKeys.id))
      .where(eq(vpnKeys.ownerId, actor.id))
      .orderBy(desc(vpnKeys.createdAt));
    const me = await this.getMe(actor);
    const policy = me.policy as PortalPolicy;
    const activeByProfile = new Map(
      (
        await this.options.db
          .select({
            profile: routeRuleVersions.profile,
            id: routeRuleVersions.id,
          })
          .from(routeRuleVersions)
          .where(eq(routeRuleVersions.status, "active"))
      ).map((row) => [row.profile, row.id]),
    );
    return rows.map(({ key, current }) => ({
      id: key.id,
      ownerId: key.ownerId,
      nodeId: key.nodeId,
      publicKey: policy.showPublicKey ? key.publicKey : undefined,
      protocol: key.protocol,
      state: key.state,
      deviceType: key.deviceType,
      deviceLabel: key.deviceLabel,
      keyNumber: key.keyNumber,
      nameDisplay: {
        server: key.nameShowNode,
        label: key.nameShowLabel,
        number: key.nameShowNumber,
      },
      routeProfile: key.routeProfile,
      rulesOutdated:
        key.routeProfile !== "full_tunnel" &&
        activeByProfile.has(key.routeProfile) &&
        activeByProfile.get(key.routeProfile) !== key.routeRuleVersionId,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: policy.showLastUsed
        ? (current?.latestHandshakeAt?.toISOString() ?? null)
        : undefined,
      traffic:
        policy.showTraffic && current
          ? {
              receivedBytes: current.receivedBytes.toString(),
              sentBytes: current.sentBytes.toString(),
            }
          : undefined,
    }));
  };

  createProvisioningKey = async (
    actor: Actor,
    request: CreateKeyRequest,
  ): Promise<{ id: string; state: KeyState }> => {
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
        const orderedCandidates = orderNodesForUsers(
          candidateNodes,
          globalPolicy?.nodeOrder ?? [],
        );
        let selectedNode: (typeof candidateNodes)[number] | undefined;
        // Track why candidates were rejected, so the error is accurate. All
        // constraints (availability, protocol, per-user quota, capacity) are
        // evaluated INSIDE the loop so the search can fall through to another
        // node that satisfies them — never rejected after picking the first.
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
            nodeId: selectedNode.id,
            protocol: request.protocol,
            routeProfile: request.routeProfile,
            nameDisplay: request.nameDisplay,
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

  findKeyConfig = async (keyId: string): Promise<StoredKeyConfig | null> => {
    const rows = await this.options.db
      .select({
        key: vpnKeys,
        user: users,
        policy: portalPolicy,
        nodeName: nodes.name,
        nodePublicName: nodes.publicName,
      })
      .from(vpnKeys)
      .innerJoin(users, eq(users.id, vpnKeys.ownerId))
      .innerJoin(nodes, eq(nodes.id, vpnKeys.nodeId))
      .leftJoin(portalPolicy, eq(portalPolicy.id, true))
      .where(and(eq(vpnKeys.id, keyId), isNotNull(vpnKeys.configCiphertext)))
      .limit(1);
    const row = rows[0];
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
        : await this.findActiveRule(row.key.routeProfile);
    return {
      id: row.key.id,
      ownerId: row.key.ownerId,
      deviceLabel: row.key.deviceLabel,
      keyNumber: row.key.keyNumber,
      nodeDisplayName: row.nodePublicName ?? row.nodeName,
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
      policy: resolvePortalPolicy(
        toPolicy(row.policy ?? undefined),
        row.user.policyOverride,
      ),
      routeProfile: row.key.routeProfile,
      appliedRuleVersionId: row.key.routeRuleVersionId,
      activeRule,
      customRoutes: row.user.customRoutes ?? null,
    };
  };

  private findActiveRule = async (
    profile: RouteProfile,
  ): Promise<ActiveRule | null> => {
    const [rule] = await this.options.db
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

  getGlobalRoutes = async (): Promise<GlobalRoutes> => {
    const [row] = await this.options.db
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

  markKeyRuleVersion = async (
    keyId: string,
    versionId: string,
  ): Promise<void> => {
    await this.options.db
      .update(vpnKeys)
      .set({ routeRuleVersionId: versionId, updatedAt: new Date() })
      .where(eq(vpnKeys.id, keyId));
  };

  listRouteProfiles = async (): Promise<RouteProfileAvailability[]> => {
    const active = await this.options.db
      .select({
        profile: routeRuleVersions.profile,
        version: routeRuleVersions.version,
      })
      .from(routeRuleVersions)
      .where(eq(routeRuleVersions.status, "active"));
    const byProfile = new Map(active.map((row) => [row.profile, row.version]));
    return (["full_tunnel", "ru_whitelist", "ru_blacklist"] as const).map(
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
      const updated = await tx
        .update(vpnKeys)
        .set({ state: "revoking", updatedAt: new Date() })
        .where(
          and(
            eq(vpnKeys.id, keyId),
            eq(vpnKeys.ownerId, actor.id),
            inArray(vpnKeys.state, ["provisioning", "active", "disabled"]),
          ),
        )
        .returning({ id: vpnKeys.id });
      if (!updated[0]) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
      await tx
        .insert(jobOutbox)
        .values({
          type: "vpn-key.revoke",
          deduplicationKey: `vpn-key.revoke:${keyId}`,
          payload: { keyId },
        })
        .onConflictDoNothing();
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_key.revoke_requested",
        targetType: "vpn_key",
        targetId: keyId,
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
      // needs new rules.
      if (key.routeProfile === "full_tunnel") {
        throw new ApiError(
          400,
          "Rotation applies only to rule-based route profiles",
          "ROTATION_NOT_APPLICABLE",
        );
      }
      if (!["active", "disabled", "failed"].includes(key.state)) {
        throw new ApiError(
          409,
          "Key cannot be rotated in its current state",
          "ROTATION_NOT_ALLOWED",
        );
      }
      await tx
        .update(vpnKeys)
        .set({ state: "provisioning", updatedAt: new Date() })
        .where(eq(vpnKeys.id, keyId));
      await tx.insert(jobOutbox).values({
        type: "vpn-key.rotate",
        deduplicationKey: `vpn-key.rotate:${keyId}:${randomUUID()}`,
        payload: { keyId },
      });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "vpn_key.rotate_requested",
        targetType: "vpn_key",
        targetId: keyId,
      });
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
        if (targetNodeId) {
          // A per-server request may only name a server this user can actually
          // use, checked inside the transaction so it cannot race a node being
          // disabled or removed.
          const [node] = await tx
            .select({ id: nodes.id, enabled: nodes.enabled })
            .from(nodes)
            .where(eq(nodes.id, targetNodeId))
            .limit(1);
          if (!node || !node.enabled) {
            throw new ApiError(400, "Node not found", "NODE_NOT_FOUND");
          }
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
          .returning({ id: quotaRequests.id, status: quotaRequests.status });
        if (!created) throw new Error("Quota request insert returned no row");
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
        return created;
      });
    } catch (error) {
      // Safety net for a concurrent double-submit racing the supersede above.
      if (String(error).includes("quota_requests_one_pending_per_user")) {
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
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(quotaRequests)
        .where(eq(quotaRequests.status, "pending")),
      db
        .select({ key: vpnKeys.state, value: count() })
        .from(vpnKeys)
        .groupBy(vpnKeys.state),
      db
        .select({ key: vpnKeys.protocol, value: count() })
        .from(vpnKeys)
        .groupBy(vpnKeys.protocol),
      db
        .select({ key: vpnKeys.routeProfile, value: count() })
        .from(vpnKeys)
        .groupBy(vpnKeys.routeProfile),
      db.select({ value: count() }).from(users),
      db
        .select({ key: users.status, value: count() })
        .from(users)
        .groupBy(users.status),
      db
        .select({ enabled: nodes.enabled, lastError: nodes.lastError })
        .from(nodes),
      db
        .select({
          online: sql<number>`count(*) filter (where ${peerCurrent.online})`,
          received: sum(peerCurrent.receivedBytes),
          sent: sum(peerCurrent.sentBytes),
        })
        .from(peerCurrent),
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
    };
  };

  adminList = async (_actor: Actor, resource: string): Promise<unknown> => {
    switch (resource) {
      case "users":
        // Every column, so the admin UI sees keyLimitOverride, nodeKeyLimits
        // and policyOverride (which carries allowedNodeIds) in one round trip.
        return this.options.db.select().from(users).orderBy(users.email);
      case "keys": {
        const rows = await this.options.db
          .select({
            id: vpnKeys.id,
            ownerId: vpnKeys.ownerId,
            nodeId: vpnKeys.nodeId,
            publicKey: vpnKeys.publicKey,
            protocol: vpnKeys.protocol,
            state: vpnKeys.state,
            deviceType: vpnKeys.deviceType,
            deviceLabel: vpnKeys.deviceLabel,
            keyNumber: vpnKeys.keyNumber,
            nameShowNode: vpnKeys.nameShowNode,
            nameShowLabel: vpnKeys.nameShowLabel,
            nameShowNumber: vpnKeys.nameShowNumber,
            routeProfile: vpnKeys.routeProfile,
            routeRuleVersionId: vpnKeys.routeRuleVersionId,
            lastUsedAt: vpnKeys.lastUsedAt,
            revokedAt: vpnKeys.revokedAt,
            failureReason: vpnKeys.failureReason,
            createdAt: vpnKeys.createdAt,
            updatedAt: vpnKeys.updatedAt,
            online: peerCurrent.online,
            receivedBytes: peerCurrent.receivedBytes,
            sentBytes: peerCurrent.sentBytes,
          })
          .from(vpnKeys)
          .leftJoin(peerCurrent, eq(peerCurrent.keyId, vpnKeys.id))
          .orderBy(desc(vpnKeys.createdAt));
        return rows.map(
          ({
            receivedBytes,
            sentBytes,
            online,
            nameShowNode,
            nameShowLabel,
            nameShowNumber,
            ...row
          }) => ({
          ...row,
          // Same shape the owner-facing key list uses, so both views can feed
          // `composeKeyDisplayName` directly.
          nameDisplay: {
            server: nameShowNode,
            label: nameShowLabel,
            number: nameShowNumber,
          },
          online: online ?? false,
          traffic:
            receivedBytes !== null && sentBytes !== null
              ? {
                  receivedBytes: receivedBytes.toString(),
                  sentBytes: sentBytes.toString(),
                }
              : null,
        }));
      }
      case "nodes": {
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
            // The node's own view of its last agent update, mirrored by the
            // telemetry poll. The log is what explains a failure without anyone
            // opening an SSH session.
            agentUpdateState: nodes.agentUpdateState,
            agentUpdateImage: nodes.agentUpdateImage,
            agentUpdateMessage: nodes.agentUpdateMessage,
            agentUpdateLog: nodes.agentUpdateLog,
            agentUpdateAt: nodes.agentUpdateAt,
            createdAt: nodes.createdAt,
            updatedAt: nodes.updatedAt,
          })
          .from(nodes)
          .orderBy(nodes.name);
        const peerCounts = new Map(
          (
            await this.options.db
              .select({ nodeId: vpnKeys.nodeId, value: count() })
              .from(vpnKeys)
              .where(inArray(vpnKeys.state, quotaStates))
              .groupBy(vpnKeys.nodeId)
          ).map((row) => [row.nodeId, row.value]),
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
        const [metricsRows, handshakeRows] = await Promise.all([
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
            .groupBy(vpnKeys.nodeId),
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
        const now = Date.now();
        return nodeRows.map((row) => ({
          ...row,
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
          traffic: {
            today: nodeTraffic.get(row.id)?.today ?? emptyPair,
            week: nodeTraffic.get(row.id)?.week ?? emptyPair,
            month: nodeTraffic.get(row.id)?.month ?? emptyPair,
          },
          supportedProtocols: deriveSupportedProtocols(
            row.protocol,
            row.capabilities,
          ),
        }));
      }
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
      case "rules":
        return this.options.db
          .select()
          .from(routeRuleVersions)
          .orderBy(desc(routeRuleVersions.createdAt));
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
              return [
                stripPolicySecrets({
                  ...policyRow,
                  recommendedNodeIds: policyRow.recommendedNodeIds.filter(
                    (id) => known.has(id),
                  ),
                  nodeOrder: policyRow.nodeOrder.filter((id) => known.has(id)),
                }),
              ];
            }
          }
          return [stripPolicySecrets(policyRow)];
        }
        // Fresh install with no row yet: report exactly the contract defaults so
        // the UI cannot show a setting the API would apply differently.
        return [
          {
            id: true,
            ...defaultPortalPolicy,
            allowedNodeIds: defaultPortalPolicy.allowedNodeIds ?? null,
            recommendedNodeIds: [] as string[],
            nodeOrder: [] as string[],
            defaultKeyLimit: 5,
            dailyRetentionDays: 730,
            cfAccessAccountId: null,
            cfAccessAppId: null,
            cfAccessPolicyId: null,
            cfApiTokenSet: false,
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
        const [definitions, results] = await Promise.all([
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
        ]);
        return definitions.map((check) => ({
          ...check,
          results: results.filter((row) => row.checkId === check.id),
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
    await this.writeAudit(
      actor,
      "service_check.reset",
      checkId ?? "all",
      { cleared: deleted.length },
    );
    return { cleared: deleted.length };
  };

  adminAction = async (
    actor: Actor,
    resource: string,
    targetId: string | null,
    action: string,
    payload: unknown,
  ): Promise<unknown> => {
    if (!targetId) throw new ApiError(400, "Target id is required", "BAD_REQUEST");
    let result: unknown;

    if (resource === "keys" && ["disable", "enable", "revoke"].includes(action)) {
      const state =
        action === "disable" ? "disabled" : action === "enable" ? "active" : "revoking";
      return this.options.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: vpnKeys.id, state: vpnKeys.state })
          .from(vpnKeys)
          .where(eq(vpnKeys.id, targetId))
          .for("update");
        if (!current) throw new ApiError(404, "Key not found", "KEY_NOT_FOUND");
        const isNoOp =
          current.state === state ||
          (action === "revoke" && current.state === "revoked");
        if (isNoOp) return current;
        const allowed =
          (action === "disable" && current.state === "active") ||
          (action === "enable" && current.state === "disabled") ||
          (action === "revoke" &&
            ["provisioning", "active", "disabled", "failed"].includes(
              current.state,
            ));
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
            deduplicationKey: `vpn-key.${action}:${targetId}:${randomUUID()}`,
            payload: { keyId: targetId },
          })
          .onConflictDoNothing();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
        });
        return updated;
      });
    } else if (resource === "users" && action === "offboard") {
      return this.options.db.transaction(async (tx) => {
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
            and(eq(vpnKeys.ownerId, targetId), inArray(vpnKeys.state, quotaStates)),
          )
          .returning({ id: vpnKeys.id });
        for (const key of keysToRevoke) {
          await tx
            .insert(jobOutbox)
            .values({
              type: "vpn-key.revoke",
              deduplicationKey: `vpn-key.revoke:${key.id}`,
              payload: { keyId: key.id },
            })
            .onConflictDoNothing();
        }
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: { keysQueuedForRevoke: keysToRevoke.length },
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
            keyLimitMode,
          },
        });
        return {
          id: updated.id,
          keyLimitOverride: updated.keyLimitOverride,
          nodeKeyLimits: updated.nodeKeyLimits ?? null,
          allowedNodeIds,
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
      const customRoutes = dedupeCustomRoutes(customRoutesSchema.parse(payload));
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
            cidrCount:
              customRoutes.ru_whitelist.cidrs.length +
              customRoutes.ru_blacklist.cidrs.length,
            domainCount:
              customRoutes.ru_whitelist.domains.length +
              customRoutes.ru_blacklist.domains.length,
          },
        });
        return updated;
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
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
        });
        return updated;
      });
    } else if (resource === "users" && action === "set-role") {
      const { role } = z
        .object({ role: z.enum(["user", "admin"]) })
        .parse(payload);
      return this.options.db.transaction(async (tx) => {
        // Never allow demoting the last remaining admin (avoids lockout).
        if (role === "user") {
          // Lock the active-admin rows FOR UPDATE so two concurrent set-role
          // calls serialize: the second sees the first's committed demotion
          // instead of both reading "2 admins" and both demoting to zero.
          const admins = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, "admin"), eq(users.status, "active")))
            .for("update");
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
      result = await this.createProvisioningKey(toActor(target), createKeyRequestSchema.parse(payload));
      await this.appendAudit({
        actorUserId: actor.id,
        actorType: "user",
        action: "admin.users.create-key",
        targetType: "user",
        targetId,
        metadata: { keyId: (result as { id: string }).id },
      });
      return result;
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
      const { cfApiToken, recommendedNodeIds, nodeOrder, ...rest } = provided;
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
      return this.options.db.transaction(async (tx) => {
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
        const [updated] = await tx
          .insert(portalPolicy)
          .values({ id: true, ...changes })
          .onConflictDoUpdate({
            target: portalPolicy.id,
            set: { ...changes, updatedAt: new Date() },
          })
          .returning();
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
          },
        });
        return updated ? stripPolicySecrets(updated) : updated;
      });
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
    } else if (resource === "rules" && action === "activate") {
      return this.options.db.transaction(async (tx) => {
        const [targetRule] = await tx
          .select()
          .from(routeRuleVersions)
          .where(eq(routeRuleVersions.id, targetId));
        if (!targetRule) throw new ApiError(404, "Rule version not found", "NOT_FOUND");
        await tx
          .update(routeRuleVersions)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(
            and(
              eq(routeRuleVersions.profile, targetRule.profile),
              eq(routeRuleVersions.status, "active"),
            ),
          );
        const [activated] = await tx
          .update(routeRuleVersions)
          .set({ status: "active", publishedAt: new Date(), updatedAt: new Date() })
          .where(eq(routeRuleVersions.id, targetId))
          .returning();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.activate",
          targetType: "rules",
          targetId,
          metadata: { profile: targetRule.profile, version: targetRule.version },
        });
        return activated;
      });
    } else if (resource === "rules" && action === "refresh") {
      // Control-api never fetches a feed itself: `RULE_FEEDS` and the
      // fetch/validate/quarantine logic belong to the worker. This only
      // enqueues the job the periodic timer already runs.
      return this.options.db.transaction(async (tx) => {
        const requestedAt = new Date();
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
          // while one is pending or processing the click is a no-op and cannot
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
          profile: z.enum(["ru_whitelist", "ru_blacklist"]),
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
        if (input.activate) {
          await tx
            .update(routeRuleVersions)
            .set({ status: "superseded", updatedAt: new Date() })
            .where(
              and(
                eq(routeRuleVersions.profile, input.profile),
                eq(routeRuleVersions.status, "active"),
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
            publishedAt: input.activate ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [routeRuleVersions.profile, routeRuleVersions.version],
            set: {
              sourceUrl: input.sourceUrl,
              status: input.activate ? "active" : "quarantined",
              cidrCount: input.cidrs.length,
              domainCount: input.domains.length,
              payload: { cidrs: input.cidrs, domains: input.domains },
              publishedAt: input.activate ? new Date() : null,
              updatedAt: new Date(),
            },
          })
          .returning();
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "admin.rules.import",
          targetType: "rules",
          targetId: saved?.id,
          metadata: { profile: input.profile, version: input.version },
        });
        return saved;
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

  appendAudit = async (event: AuditInput): Promise<void> => {
    await this.options.db.insert(auditEvents).values(event);
  };
}
