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
  real,
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
  NodeAgentUpdateState,
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
    // Where clients reach this node: the node-agent's SERVER_PUBLIC_HOST as it
    // reports it in GET /server (IP literal or DNS name). Null until an agent
    // that reports the field has been polled successfully.
    publicHost: text("public_host"),
    // `publicHost` resolved to an IPv4 address by the worker. Null until the
    // first successful resolution; after that it is sticky, because a node's
    // public address is fixed for the server's lifetime and is therefore
    // resolved once rather than on every poll.
    publicIp: text("public_ip"),
    // When publicIp was learned. Null exactly when publicIp is null. It records
    // where the panel got that number and when — a diagnostic, not a staleness
    // clock.
    publicIpResolvedAt: timestamp("public_ip_resolved_at", { withTimezone: true }),
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
    // The last in-panel agent update, mirrored from the node's own spool. It is
    // a cache of what the node reports, not the source of truth: the node
    // survives the panel and answers GET /server/update on its own.
    agentUpdateState: text("agent_update_state")
      .$type<NodeAgentUpdateState>()
      .default("idle")
      .notNull(),
    agentUpdateImage: text("agent_update_image"),
    agentUpdateMessage: text("agent_update_message"),
    // The tail the updater wrote. Kept on the node row so the card can show why
    // an update failed after the job that ran it is long gone.
    agentUpdateLog: text("agent_update_log").default("").notNull(),
    agentUpdateAt: timestamp("agent_update_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("nodes_name_unique").on(table.name),
    check("nodes_max_peers_positive", sql`${table.maxPeers} > 0`),
  ],
);

// The node-agent image the panel currently offers nodes, resolved from the
// registry by the worker. The panel never asks an admin to paste a digest and
// never passes a tag to a node: a tag is mutable, so the thing installed could
// differ from the thing confirmed. Keyed by repository, because that is what a
// node is configured to trust; `resolvedAt` is what lets a reader decide the
// answer is too old to offer.
export const nodeAgentReleases = pgTable("node_agent_releases", {
  repository: text("repository").primaryKey(),
  version: varchar("version", { length: 64 }).notNull(),
  digest: varchar("digest", { length: 80 }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
});

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

export const serviceCheckStatusEnum = pgEnum("service_check_status", [
  "ok",
  "failed",
  "error",
]);

/**
 * The latest host metrics a node's agent reported: one row per node, replaced on
 * every telemetry tick. Every metric is nullable, because an agent that predates
 * a field simply does not report it and the UI shows a dash - a missing metric
 * must never turn into a failed poll or a zero that reads as a measurement.
 */
export const nodeMetricsCurrent = pgTable("node_metrics_current", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => nodes.id, { onDelete: "cascade" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  agentLatencyMs: integer("agent_latency_ms"),
  uptimeSec: bigint("uptime_sec", { mode: "number" }),
  cpuCores: integer("cpu_cores"),
  load1: real("load1"),
  load5: real("load5"),
  load15: real("load15"),
  memTotalBytes: bigint("mem_total_bytes", { mode: "bigint" }),
  memAvailableBytes: bigint("mem_available_bytes", { mode: "bigint" }),
  swapTotalBytes: bigint("swap_total_bytes", { mode: "bigint" }),
  swapUsedBytes: bigint("swap_used_bytes", { mode: "bigint" }),
  diskTotalBytes: bigint("disk_total_bytes", { mode: "bigint" }),
  diskAvailableBytes: bigint("disk_available_bytes", { mode: "bigint" }),
  diskUsedPercent: real("disk_used_percent"),
  // The cgroup task budget. On a small host this is what runs out first, and a
  // container that cannot fork looks healthy and low on memory while it does.
  agentPidsCurrent: integer("agent_pids_current"),
  agentPidsMax: integer("agent_pids_max"),
  awg3Up: boolean("awg3_up"),
  awg3Peers: integer("awg3_peers"),
  awg2Up: boolean("awg2_up"),
  awg2Peers: integer("awg2_peers"),
  publicHost: varchar("public_host", { length: 253 }),
  listenPorts: jsonb("listen_ports").$type<number[]>(),
});

/**
 * A trimmed history of the six metrics worth a graph. Deliberately not every
 * field: this table grows per node per tick forever, and the rest are either
 * constant (cpuCores) or only interesting as their latest value.
 */
export const nodeMetricsSamples = pgTable(
  "node_metrics_samples",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    load1: real("load1"),
    memAvailableBytes: bigint("mem_available_bytes", { mode: "bigint" }),
    swapUsedBytes: bigint("swap_used_bytes", { mode: "bigint" }),
    diskUsedPercent: real("disk_used_percent"),
    agentPidsCurrent: integer("agent_pids_current"),
    awg3Peers: integer("awg3_peers"),
  },
  (table) => [
    index("node_metrics_samples_node_sampled_idx").on(
      table.nodeId,
      table.sampledAt,
    ),
  ],
);

/** Admin-defined HTTP probes every enabled node runs from its own egress. */
export const nodeServiceChecks = pgTable(
  "node_service_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 80 }).notNull(),
    url: text("url").notNull(),
    expectedStatuses: jsonb("expected_statuses")
      .$type<number[]>()
      .default([200])
      .notNull(),
    bodyMustContain: varchar("body_must_contain", { length: 200 }),
    bodyMustNotContain: varchar("body_must_not_contain", { length: 200 }),
    finalUrlMustNotContain: varchar("final_url_must_not_contain", {
      length: 200,
    }),
    // 12 hours. A blocked region is a state that lasts days, not minutes, so a
    // fast period would only add traffic from every node at once. An admin can
    // lower it per check while calibrating; the range check is the guard rail.
    intervalSec: integer("interval_sec").default(43_200).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    // A "run now" marker, not a schedule. Normal scheduling is per (node,
    // check) and derives from the result's checkedAt; the admin action sets
    // this to now(), and every node whose last result predates it runs once.
    nextDueAt: timestamp("next_due_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("node_service_checks_name_unique").on(table.name),
    check(
      "node_service_checks_interval_range",
      sql`${table.intervalSec} >= 60 AND ${table.intervalSec} <= 86400`,
    ),
  ],
);

export const nodeServiceCheckResults = pgTable(
  "node_service_check_results",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    checkId: uuid("check_id")
      .notNull()
      .references(() => nodeServiceChecks.id, { onDelete: "cascade" }),
    status: serviceCheckStatusEnum("status").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    detail: varchar("detail", { length: 300 }),
    // Where the node actually landed. Admin-only, and the reason a newly seeded
    // check's first run is a calibration reading rather than a verdict: a
    // service that answers a redirect instead of an error tells you nothing
    // until you can see the redirect target.
    finalUrl: varchar("final_url", { length: 500 }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    failingSince: timestamp("failing_since", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.nodeId, table.checkId] })],
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
    // Nodes badged as recommended for users. A HIGHLIGHT ONLY: it never
    // changes the order. Global-only (no per-user override); validated against
    // existing nodes on write, required to be a prefix of node_order, and
    // scrubbed on node delete.
    recommendedNodeIds: jsonb("recommended_node_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    // The admin's hand-made server order: the array index is the position, and
    // it is the only thing that decides where a node appears. Nodes missing
    // from it sort after every node that is in it (by name, then by id).
    // Global-only, same validation and scrubbing as above.
    nodeOrder: jsonb("node_order").$type<string[]>().default([]).notNull(),
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
    // Whether users see the per-node service-check chips. Ships ON: telling a
    // user that a service is unavailable from this node is what stops a ticket
    // about a node that is behaving exactly as designed.
    showNodeStatus: boolean("show_node_status").default(true).notNull(),
    // Whether users see each node's public address on their dashboard. Default
    // OFF, unlike the other display flags around it: an existing deployment
    // must not start showing the fleet's addresses because it was upgraded.
    showNodeAddress: boolean("show_node_address").default(false).notNull(),
    // Walkthrough videos for the in-panel connection guide, one URL per
    // audience ({ desktop, android, ios }). Nullable and null by default: the
    // guide renders a placeholder until an admin attaches recordings, so a
    // panel that has none is not broken, just not illustrated.
    // NOT NULL with an empty-object default: the contract models this as an
    // object with a `.default({})`, so a null here is a value the API's own
    // read hands out and its own write refuses - which wedged the whole admin
    // policy form on every panel that never set a video.
    installGuideVideos: jsonb("install_guide_videos")
      .$type<InstallGuideVideos>()
      .default({})
      .notNull(),
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
