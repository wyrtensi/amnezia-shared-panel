import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  CustomRoutes,
  GlobalRoutes,
  InstallGuideVideos,
  NodeKeyLimits,
  PortalPolicyOverride,
  ProtocolKind,
} from "@amnezia/contracts";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);
export const protocolKindEnum = pgEnum("protocol_kind", ["awg2", "awg3"]);
export const keyStateEnum = pgEnum("key_state", [
  "provisioning",
  "active",
  "disabled",
  "revoking",
  "revoked",
  "failed",
]);
export const routeProfileEnum = pgEnum("route_profile", [
  "full_tunnel",
  "ru_whitelist",
  "ru_blacklist",
]);
// Mirrors `deviceTypeSchema` in @amnezia/contracts, value for value and in the
// same order; `schema.test.ts` fails if the two drift. Written out as a literal
// rather than imported because drizzle-kit reads this file directly and must
// not depend on the contracts package being built.
export const deviceTypeEnum = pgEnum("device_type", [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
  "unspecified",
]);
export const quotaRequestStatusEnum = pgEnum("quota_request_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);
export const keyLimitModeEnum = pgEnum("key_limit_mode", ["per_node", "global"]);
export const ruleVersionStatusEnum = pgEnum("rule_version_status", [
  "active",
  "superseded",
  "quarantined",
]);
export const rollupPeriodEnum = pgEnum("rollup_period", ["hour", "day"]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 160 }),
    role: roleEnum("role").default("user").notNull(),
    status: userStatusEnum("status").default("active").notNull(),
    keyLimitOverride: integer("key_limit_override"),
    // Per-node key limits for this user: { nodeId: limit }. Null (or a missing
    // node) falls back to `keyLimitOverride` and then to the global default.
    nodeKeyLimits: jsonb("node_key_limits").$type<NodeKeyLimits>(),
    policyOverride: jsonb("policy_override").$type<PortalPolicyOverride>(),
    // Per-user extra routes layered on a split-tunnel profile's base feed at
    // export time (null = none). Keyed by profile: { ru_whitelist, ru_blacklist }.
    customRoutes: jsonb("custom_routes").$type<CustomRoutes>(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    // Why the account is disabled, e.g. "admin_offboard" or "access_removed"
    // (Cloudflare Access membership revoked). Null while the account is active.
    deactivationReason: varchar("deactivation_reason", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    check("users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    check(
      "users_key_limit_override_positive",
      sql`${table.keyLimitOverride} is null or ${table.keyLimitOverride} >= 0`,
    ),
  ],
);

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 80 }).notNull(),
    subject: varchar("subject", { length: 512 }).notNull(),
    emailAtLogin: varchar("email_at_login", { length: 320 }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("identities_provider_subject_unique").on(
      table.provider,
      table.subject,
    ),
    index("identities_user_idx").on(table.userId),
  ],
);

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    // Name users see for this server (falls back to `name` when empty). The
    // internal `name` stays admin-only.
    publicName: varchar("public_name", { length: 120 }),
    apiBaseUrl: text("api_base_url").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    protocol: protocolKindEnum("protocol").default("awg2").notNull(),
    // Subset of the node's supported protocols offered to users; null = all.
    enabledProtocols: jsonb("enabled_protocols").$type<ProtocolKind[]>(),
    maxPeers: integer("max_peers").default(500).notNull(),
    capabilities: jsonb("capabilities")
      .$type<Record<string, boolean | number>>()
      .default({})
      .notNull(),
    credentialsCiphertext: text("credentials_ciphertext").notNull(),
    credentialsNonce: text("credentials_nonce").notNull(),
    credentialsAuthTag: text("credentials_auth_tag").notNull(),
    credentialsKeyVersion: integer("credentials_key_version").notNull(),
    labelSecretCiphertext: text("label_secret_ciphertext").notNull(),
    labelSecretNonce: text("label_secret_nonce").notNull(),
    labelSecretAuthTag: text("label_secret_auth_tag").notNull(),
    labelSecretKeyVersion: integer("label_secret_key_version").notNull(),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("nodes_name_unique").on(table.name),
    check("nodes_max_peers_positive", sql`${table.maxPeers} > 0`),
  ],
);

export const routeRuleVersions = pgTable(
  "route_rule_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    profile: routeProfileEnum("profile").notNull(),
    version: varchar("version", { length: 96 }).notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceEtag: text("source_etag"),
    sourceChecksum: varchar("source_checksum", { length: 128 }).notNull(),
    status: ruleVersionStatusEnum("status").notNull(),
    cidrCount: integer("cidr_count").default(0).notNull(),
    domainCount: integer("domain_count").default(0).notNull(),
    payload: jsonb("payload")
      .$type<{ cidrs: string[]; domains: string[] }>()
      .notNull(),
    validationReport: jsonb("validation_report").$type<Record<string, unknown>>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("route_rule_versions_profile_version_unique").on(
      table.profile,
      table.version,
    ),
    index("route_rule_versions_status_idx").on(table.profile, table.status),
  ],
);

export const vpnKeys = pgTable(
  "vpn_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "restrict" }),
    publicKey: text("public_key"),
    nodeLabel: varchar("node_label", { length: 80 }).notNull(),
    protocol: protocolKindEnum("protocol").notNull(),
    state: keyStateEnum("state").default("provisioning").notNull(),
    deviceType: deviceTypeEnum("device_type").default("unspecified").notNull(),
    deviceLabel: varchar("device_label", { length: 80 }),
    // Per-owner sequential key number (1, 2, 3, ...), assigned at creation.
    // Shown to the user and embedded in the client's server name as
    // "<node public name> #<keyNumber>". Nullable only for pre-migration rows.
    keyNumber: integer("key_number"),
    // Which parts make up the connection name shown by the AmneziaVPN client.
    // Defaults to "<node public name> <device label>"; the number is opt-in.
    // Rows created before this feature keep node + number (their old name).
    nameShowNode: boolean("name_show_node").default(true).notNull(),
    nameShowLabel: boolean("name_show_label").default(true).notNull(),
    nameShowNumber: boolean("name_show_number").default(false).notNull(),
    routeProfile: routeProfileEnum("route_profile").notNull(),
    routeRuleVersionId: uuid("route_rule_version_id").references(
      () => routeRuleVersions.id,
      { onDelete: "set null" },
    ),
    configCiphertext: text("config_ciphertext"),
    configNonce: text("config_nonce"),
    configAuthTag: text("config_auth_tag"),
    configKeyVersion: integer("config_key_version"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("vpn_keys_node_label_unique").on(table.nodeId, table.nodeLabel),
    uniqueIndex("vpn_keys_node_public_key_unique").on(
      table.nodeId,
      table.publicKey,
    ),
    index("vpn_keys_owner_state_idx").on(table.ownerId, table.state),
    index("vpn_keys_node_state_idx").on(table.nodeId, table.state),
    check(
      "vpn_keys_config_envelope_complete",
      sql`(${table.configCiphertext} is null and ${table.configNonce} is null and ${table.configAuthTag} is null and ${table.configKeyVersion} is null) or (${table.configCiphertext} is not null and ${table.configNonce} is not null and ${table.configAuthTag} is not null and ${table.configKeyVersion} is not null)`,
    ),
  ],
);

export const quotaRequests = pgTable(
  "quota_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedLimit: integer("requested_limit").notNull(),
    // Which server the request is for. Null = every server (raises the flat
    // per-user override). A node id targets that one server. The node may be
    // removed while a request is still pending, so this is `set null` — the
    // node-removal path cancels such requests instead of letting them silently
    // become every-server asks.
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    status: quotaRequestStatusEnum("status").default("pending").notNull(),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("quota_requests_one_pending_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    index("quota_requests_status_created_idx").on(table.status, table.createdAt),
    check("quota_requests_limit_positive", sql`${table.requestedLimit} > 0`),
  ],
);

export const peerCurrent = pgTable("peer_current", {
  keyId: uuid("key_id")
    .primaryKey()
    .references(() => vpnKeys.id, { onDelete: "cascade" }),
  online: boolean("online").default(false).notNull(),
  endpoint: text("endpoint"),
  latestHandshakeAt: timestamp("latest_handshake_at", { withTimezone: true }),
  receivedBytes: bigint("received_bytes", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  sentBytes: bigint("sent_bytes", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const peerSamples = pgTable(
  "peer_samples",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => vpnKeys.id, { onDelete: "cascade" }),
    online: boolean("online").notNull(),
    endpoint: text("endpoint"),
    latestHandshakeAt: timestamp("latest_handshake_at", { withTimezone: true }),
    receivedBytes: bigint("received_bytes", { mode: "bigint" }).notNull(),
    sentBytes: bigint("sent_bytes", { mode: "bigint" }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("peer_samples_key_sampled_idx").on(table.keyId, table.sampledAt)],
);

export const trafficRollups = pgTable(
  "traffic_rollups",
  {
    keyId: uuid("key_id")
      .notNull()
      .references(() => vpnKeys.id, { onDelete: "cascade" }),
    period: rollupPeriodEnum("period").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    receivedBytes: bigint("received_bytes", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    sentBytes: bigint("sent_bytes", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.period, table.bucketStart] }),
    index("traffic_rollups_period_bucket_idx").on(table.period, table.bucketStart),
  ],
);

export const portalPolicy = pgTable(
  "portal_policy",
  {
    id: boolean("id").primaryKey().default(true),
    defaultKeyLimit: integer("default_key_limit").default(5).notNull(),
    // How `defaultKeyLimit` / `users.keyLimitOverride` are read: per server
    // (the original behaviour) or as one total shared by every server. A user
    // may override it in `policyOverride.keyLimitMode`. See the contract
    // `keyLimitModeSchema` for the semantics.
    keyLimitMode: keyLimitModeEnum("key_limit_mode").default("per_node").notNull(),
    allowKeyCreation: boolean("allow_key_creation").default(true).notNull(),
    allowNodeSelection: boolean("allow_node_selection").default(true).notNull(),
    allowedProtocols: jsonb("allowed_protocols")
      .$type<ProtocolKind[]>()
      .default(["awg3"])
      .notNull(),
    // Nodes offered to users; null = all nodes. A per-user override lives in
    // policyOverride.allowedNodeIds.
    allowedNodeIds: jsonb("allowed_node_ids").$type<string[]>(),
    allowRouteProfileSelection: boolean("allow_route_profile_selection")
      .default(true)
      .notNull(),
    // Gate for user self-service custom-route editing; admins bypass it.
    allowCustomRoutes: boolean("allow_custom_routes").default(true).notNull(),
    allowConfigRedownload: boolean("allow_config_redownload")
      .default(true)
      .notNull(),
    allowQrDownload: boolean("allow_qr_download").default(true).notNull(),
    allowConfDownload: boolean("allow_conf_download").default(true).notNull(),
    allowSelfRevoke: boolean("allow_self_revoke").default(true).notNull(),
    showPublicKey: boolean("show_public_key").default(false).notNull(),
    showLastUsed: boolean("show_last_used").default(true).notNull(),
    showTraffic: boolean("show_traffic").default(true).notNull(),
    // Walkthrough videos for the in-panel connection guide, one URL per
    // audience ({ desktop, android, ios }). Nullable and null by default: the
    // guide renders a placeholder until an admin attaches recordings, so a
    // panel that has none is not broken, just not illustrated.
    installGuideVideos: jsonb("install_guide_videos").$type<InstallGuideVideos>(),
    dailyRetentionDays: integer("daily_retention_days"),
    // Cloudflare Access two-way sync config. The API token is stored encrypted
    // and never returned to the client (write-only, replaceable).
    cfAccessAccountId: varchar("cf_access_account_id", { length: 64 }),
    cfAccessAppId: varchar("cf_access_app_id", { length: 64 }),
    cfAccessPolicyId: varchar("cf_access_policy_id", { length: 64 }),
    cfApiTokenCiphertext: text("cf_api_token_ciphertext"),
    cfApiTokenNonce: text("cf_api_token_nonce"),
    cfApiTokenAuthTag: text("cf_api_token_auth_tag"),
    cfApiTokenKeyVersion: integer("cf_api_token_key_version"),
    // Baseline for the two-way Access sync: the email set last reconciled with
    // the Cloudflare policy. The 3-way merge compares the current panel set and
    // the current CF set against this to tell a panel-side add (protect it) from
    // a CF-side removal (disable the panel user). Null until the first sync.
    cfAccessSyncedEmails: jsonb("cf_access_synced_emails").$type<string[]>(),
    ...timestamps,
  },
  (table) => [
    check("portal_policy_singleton", sql`${table.id} = true`),
    check("portal_policy_default_limit_positive", sql`${table.defaultKeyLimit} >= 0`),
  ],
);

/**
 * Admin-wide additions/exclusions layered on the split-tunnel route feeds at
 * export time. Singleton, mirroring `portal_policy`: exactly one row with
 * `id = true`.
 */
export const globalRouteOverrides = pgTable(
  "global_route_overrides",
  {
    id: boolean("id").primaryKey().default(true),
    payload: jsonb("payload")
      .$type<GlobalRoutes>()
      .default({
        ru_whitelist: {
          add: { cidrs: [], domains: [] },
          exclude: { cidrs: [], domains: [] },
        },
        ru_blacklist: {
          add: { cidrs: [], domains: [] },
          exclude: { cidrs: [], domains: [] },
        },
      })
      .notNull(),
    ...timestamps,
  },
  (table) => [check("global_route_overrides_singleton", sql`${table.id} = true`)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 80 }).notNull(),
    targetId: text("target_id"),
    requestId: uuid("request_id"),
    ipAddress: varchar("ip_address", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_created_idx").on(table.createdAt),
    index("audit_events_target_idx").on(table.targetType, table.targetId),
  ],
);

export const jobOutbox = pgTable(
  "job_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 100 }).notNull(),
    deduplicationKey: varchar("deduplication_key", { length: 200 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("job_outbox_deduplication_unique").on(table.deduplicationKey),
    index("job_outbox_poll_idx").on(table.status, table.availableAt),
  ],
);
