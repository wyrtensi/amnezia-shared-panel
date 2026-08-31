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
  CreateKeyRequest,
  CreateUserRequest,
  CustomRoutes,
  KeyState,
  PortalPolicy,
  ProtocolKind,
  QuotaRequest,
  RouteProfile,
  UpdateNodeRequest,
} from "@amnezia/contracts";
import {
  createKeyRequestSchema,
  customRoutesSchema,
  DEFAULT_ALLOWED_PROTOCOLS,
  defaultPortalPolicy,
  PROTOCOL_KINDS,
  portalPolicyOverrideSchema,
  portalPolicySchema,
  routeRuleSeeds,
} from "@amnezia/contracts";
import {
  auditEvents,
  decryptSecret,
  deterministicPeerLabel,
  effectiveKeyLimit,
  encryptSecret,
  identities,
  jobOutbox,
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
});

type PortalPolicyRow = typeof portalPolicy.$inferSelect;

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
        allowRouteProfileSelection: row.allowRouteProfileSelection,
        allowCustomRoutes: row.allowCustomRoutes,
        allowConfigRedownload: row.allowConfigRedownload,
        allowQrDownload: row.allowQrDownload,
        allowConfDownload: row.allowConfDownload,
        allowSelfRevoke: row.allowSelfRevoke,
        showPublicKey: row.showPublicKey,
        showLastUsed: row.showLastUsed,
        showTraffic: row.showTraffic,
      }
    : defaultPortalPolicy;

// Remove the encrypted Cloudflare token fields from a policy row before it
// leaves the API, exposing only whether a token is currently set.
const stripPolicySecrets = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...row };
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
};

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
    return {
      // Per-node key limit (each node allows this many keys per user).
      keyLimit: effectiveKeyLimit(
        globalPolicy?.defaultKeyLimit ?? 5,
        user.keyLimitOverride,
      ),
      keyCount: keyCountRow[0]?.value ?? 0,
      perNode: perNodeRows.map((row) => ({
        nodeId: row.nodeId,
        used: row.value,
      })),
      policy: resolvePortalPolicy(toPolicy(globalPolicy), user.policyOverride),
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
    const [rows, policyRow, userRow] = await Promise.all([
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
        })
        .from(nodes)
        .where(eq(nodes.enabled, true)),
      this.options.db.select().from(portalPolicy).limit(1),
      this.options.db
        .select({ policyOverride: users.policyOverride })
        .from(users)
        .where(eq(users.id, actor.id))
        .limit(1),
    ]);
    const policy = resolvePortalPolicy(
      toPolicy(policyRow[0]),
      userRow[0]?.policyOverride,
    );
    // A null/absent allowedNodeIds means "all nodes"; a list restricts to it.
    const allowedNodeIds = policy.allowedNodeIds ?? null;
    return rows
      .filter((row) => allowedNodeIds === null || allowedNodeIds.includes(row.id))
      .map(({ capabilities, enabledProtocols, publicName, ...row }) => {
        const supportedProtocols = deriveSupportedProtocols(
          row.protocol,
          capabilities,
        );
        return {
          ...row,
          // Users see the public name; the internal admin name never leaves here.
          name: publicName ?? row.name,
          supportedProtocols,
          selectableProtocols: computeSelectableProtocols(
            supportedProtocols,
            enabledProtocols,
            policy.allowedProtocols,
          ),
        };
      });
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

  deleteNode = async (actor: Actor, nodeId: string): Promise<unknown> =>
    this.options.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: nodes.id, name: nodes.name })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (!existing) throw new ApiError(404, "Node not found", "NODE_NOT_FOUND");

      // vpn_keys.node_id is ON DELETE RESTRICT: a node that ever held a key
      // (revoked keys included) cannot be removed. Disable it instead.
      const [keyCount] = await tx
        .select({ value: count() })
        .from(vpnKeys)
        .where(eq(vpnKeys.nodeId, nodeId));
      if ((keyCount?.value ?? 0) > 0) {
        throw new ApiError(
          409,
          "Node still has keys (revoked keys count too) — disable it instead of deleting.",
          "NODE_HAS_KEYS",
        );
      }

      await tx.delete(nodes).where(eq(nodes.id, nodeId));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        actorType: "user",
        action: "node.deleted",
        targetType: "node",
        targetId: nodeId,
        metadata: { name: existing.name },
      });
      return { id: nodeId, deleted: true };
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
        // The key limit is PER NODE: a user may hold up to `limit` keys on each
        // node, not `limit` total.
        const limit = effectiveKeyLimit(
          globalPolicy?.defaultKeyLimit ?? 5,
          user.keyLimitOverride,
        );

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
        let selectedNode: (typeof candidateNodes)[number] | undefined;
        // Track why candidates were rejected, so the error is accurate. All
        // constraints (availability, protocol, per-user quota, capacity) are
        // evaluated INSIDE the loop so the search can fall through to another
        // node that satisfies them — never rejected after picking the first.
        let userQuotaBlocked = false;
        let nodeCapacityBlocked = false;
        let protocolBlocked = false;
        let availabilityBlocked = false;
        for (const candidate of candidateNodes) {
          // Node availability (global default or per-user override).
          if (
            policy.allowedNodeIds != null &&
            !policy.allowedNodeIds.includes(candidate.id)
          ) {
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
          if (userKeysOnNode >= limit) {
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

  listQuotaRequests = async (actor: Actor): Promise<unknown[]> =>
    this.options.db
      .select()
      .from(quotaRequests)
      .where(eq(quotaRequests.userId, actor.id))
      .orderBy(desc(quotaRequests.createdAt));

  createQuotaRequest = async (
    actor: Actor,
    request: QuotaRequest,
  ): Promise<{ id: string; status: string }> => {
    try {
      return await this.options.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(quotaRequests)
          .values({ userId: actor.id, ...request })
          .returning({ id: quotaRequests.id, status: quotaRequests.status });
        if (!created) throw new Error("Quota request insert returned no row");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: "quota_request.created",
          targetType: "quota_request",
          targetId: created.id,
          metadata: { requestedLimit: request.requestedLimit },
        });
        return created;
      });
    } catch (error) {
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
    const totalKeys = byState.reduce((acc, row) => acc + row.value, 0);
    const traffic =
      BigInt(peerAgg[0]?.received ?? 0) + BigInt(peerAgg[0]?.sent ?? 0);

    return {
      // Preserved for the existing metric cards
      pendingQuotaRequests: pending[0]?.value ?? 0,
      activeKeys: stateCounts.active ?? 0,
      enabledNodes: nodeRows.filter((node) => node.enabled).length,
      // Richer aggregates
      totalKeys,
      totalUsers: userCount[0]?.value ?? 0,
      onlineDevices: Number(peerAgg[0]?.online ?? 0),
      totalTrafficBytes: traffic.toString(),
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
        return rows.map(({ receivedBytes, sentBytes, online, ...row }) => ({
          ...row,
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
            capabilities: nodes.capabilities,
            lastHealthAt: nodes.lastHealthAt,
            lastSyncAt: nodes.lastSyncAt,
            lastError: nodes.lastError,
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
        return nodeRows.map((row) => ({
          ...row,
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
      case "quota-requests":
        return this.options.db
          .select()
          .from(quotaRequests)
          .orderBy(desc(quotaRequests.createdAt));
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
        if (rows[0]) return [stripPolicySecrets(rows[0])];
        return [
          {
            id: true,
            allowKeyCreation: defaultPortalPolicy.allowKeyCreation,
            allowNodeSelection: defaultPortalPolicy.allowNodeSelection,
            allowedProtocols: defaultPortalPolicy.allowedProtocols,
            allowedNodeIds: null,
            allowRouteProfileSelection:
              defaultPortalPolicy.allowRouteProfileSelection,
            allowConfigRedownload: defaultPortalPolicy.allowConfigRedownload,
            allowQrDownload: defaultPortalPolicy.allowQrDownload,
            allowConfDownload: defaultPortalPolicy.allowConfDownload,
            allowSelfRevoke: defaultPortalPolicy.allowSelfRevoke,
            showPublicKey: defaultPortalPolicy.showPublicKey,
            showLastUsed: defaultPortalPolicy.showLastUsed,
            showTraffic: defaultPortalPolicy.showTraffic,
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
      default:
        throw new ApiError(404, "Admin resource not found", "NOT_FOUND");
    }
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
      const parsed = z
        .object({ keyLimitOverride: z.int().min(0).max(1_000).nullable() })
        .parse(payload);
      return this.options.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({ ...parsed, updatedAt: new Date() })
          .where(eq(users.id, targetId))
          .returning({ id: users.id, keyLimitOverride: users.keyLimitOverride });
        if (!updated) throw new ApiError(404, "User not found", "USER_NOT_FOUND");
        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          actorType: "user",
          action: `admin.${resource}.${action}`,
          targetType: resource,
          targetId,
          metadata: { keyLimitOverride: parsed.keyLimitOverride },
        });
        return updated;
      });
    } else if (resource === "users" && action === "set-policy") {
      const policyOverride = portalPolicyOverrideSchema.parse(payload);
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
          const [admins] = await tx
            .select({ value: count() })
            .from(users)
            .where(and(eq(users.role, "admin"), eq(users.status, "active")));
          const [target] = await tx
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, targetId))
            .limit(1);
          if (
            target?.role === "admin" &&
            (admins?.value ?? 0) <= 1
          ) {
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
        if (action === "approve") {
          await tx
            .update(users)
            .set({ keyLimitOverride: request.requestedLimit, updatedAt: new Date() })
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
          metadata: { requestedLimit: request.requestedLimit, status: updated?.status },
        });
        return updated;
      });
    } else if (resource === "portal-policy" && action === "update") {
      const parsed = adminPolicyUpdateSchema.parse(payload);
      const { cfApiToken, ...rest } = parsed;
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
      return this.options.db.transaction(async (tx) => {
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
          metadata: { fields: Object.keys(parsed) },
        });
        return updated ? stripPolicySecrets(updated) : updated;
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
    } else if (resource === "rules" && (action === "seed" || action === "import")) {
      const raw = z
        .object({
          profile: z
            .enum(["ru_whitelist", "ru_blacklist"])
            .default("ru_whitelist"),
          version: z.string().min(1).max(96).optional(),
          sourceUrl: z.string().min(1).optional(),
          cidrs: z.array(z.string()).optional(),
          domains: z.array(z.string()).optional(),
          activate: z.boolean().default(true),
        })
        .parse(payload ?? {});
      // Fall back to the bundled starter set when the operator seeds a profile
      // without supplying an explicit rule list.
      const seed = routeRuleSeeds[raw.profile];
      const input = {
        profile: raw.profile,
        version: raw.version ?? `bundled-${raw.profile}`,
        sourceUrl: raw.sourceUrl ?? "bundled://seed",
        cidrs: raw.cidrs ?? seed.cidrs,
        domains: raw.domains ?? seed.domains,
        activate: raw.activate,
      };
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
          action: `admin.rules.${action}`,
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

  appendAudit = async (event: AuditInput): Promise<void> => {
    await this.options.db.insert(auditEvents).values(event);
  };
}
