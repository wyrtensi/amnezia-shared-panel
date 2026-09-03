import { z } from "zod";

export const protocolKindSchema = z.enum(["awg2", "awg3"]);
export const keyStateSchema = z.enum([
  "provisioning",
  "active",
  "disabled",
  "revoking",
  "revoked",
  "failed",
]);
export const routeProfileSchema = z.enum([
  "full_tunnel",
  "ru_whitelist",
  "ru_blacklist",
]);
/**
 * What kind of device a key is for. The value names a **platform**, not a form
 * factor: it is the signal platform-specific behaviour hangs off (today only
 * `deviceSupportsRouteProfiles`, which is not offered on iOS). "ios" covers
 * iPhone and iPad — the same platform for every purpose this panel has.
 *
 * "unspecified" is the stored default and is never offered as a choice; see
 * DEVICE_TYPE_ORDER.
 *
 * Mirrored by `deviceTypeEnum` in `packages/db/src/schema.ts` (pinned by a
 * parity test) and by `DEVICE_TYPES` in `apps/cli/src/args.ts` (a deliberate
 * copy — the CLI has no dependencies; pinned by a test on each side).
 */
export const deviceTypeSchema = z.enum([
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
  "unspecified",
]);

/**
 * The device types the create-key UI and the CLI offer, in the order they are
 * shown: the mobile and Apple platforms on top, the desktop ones and the escape
 * hatch at the bottom. This order is the operator's, not an implementation
 * detail, so it lives here rather than in a component — a UI-local copy of this
 * list is what once let the wizard offer a "tablet" the API rejected.
 */
export const DEVICE_TYPE_ORDER = [
  "android",
  "ios",
  "macos",
  "windows",
  "linux",
  "other",
] as const satisfies readonly DeviceType[];

/**
 * Device types the panel used before the platform rework, and what a row
 * holding one becomes.
 *
 * `desktop`, `laptop` and `phone` named a form factor and never told the panel
 * which platform the device ran, so they become "unspecified" rather than
 * "other": "other" would claim the platform is outside the list, which the
 * panel cannot know. `iphone` maps exactly onto the wider `ios`.
 *
 * `tablet` was only ever offered by the create-key wizard — deviceTypeSchema
 * never contained it, so no stored row can hold it — but a stale browser tab
 * can still send it, so it is named here and refused by name.
 */
export const LEGACY_DEVICE_TYPE_REPLACEMENT = {
  iphone: "ios",
  desktop: "unspecified",
  laptop: "unspecified",
  phone: "unspecified",
  tablet: "unspecified",
} as const satisfies Record<string, DeviceType>;

export type LegacyDeviceType = keyof typeof LEGACY_DEVICE_TYPE_REPLACEMENT;

/**
 * The retired values a stored row could actually hold — the pre-rework
 * Postgres enum. The data migration handles exactly these; "tablet" is absent
 * because the column could never contain it.
 */
export const RETIRED_STORED_DEVICE_TYPES = [
  "desktop",
  "laptop",
  "iphone",
  "phone",
] as const satisfies readonly LegacyDeviceType[];

/**
 * What a retired device type becomes, or null when the value was never one.
 * Current values return null too, so a caller cannot map twice.
 */
export const replaceLegacyDeviceType = (value: string): DeviceType | null =>
  Object.hasOwn(LEGACY_DEVICE_TYPE_REPLACEMENT, value)
    ? LEGACY_DEVICE_TYPE_REPLACEMENT[value as LegacyDeviceType]
    : null;
export const roleSchema = z.enum(["user", "admin"]);
export const userStatusSchema = z.enum(["active", "disabled"]);

// Protocols the panel understands, newest/preferred first. Adding a future
// protocol = extend `protocolKindSchema` and this registry; the rest of the
// stack (policy, nodes, wizard) is driven off these and needs no other change.
export const PROTOCOL_KINDS = ["awg3", "awg2"] as const;
export const DEFAULT_ALLOWED_PROTOCOLS: ProtocolKind[] = ["awg3"];
export const PROTOCOL_META: Record<
  ProtocolKind,
  { label: string; short: string; recommended: boolean; legacy: boolean }
> = {
  awg3: {
    label: "AmneziaWG 3.1",
    short: "AWG 3.1",
    recommended: true,
    legacy: false,
  },
  awg2: {
    label: "AmneziaWG 2.0",
    short: "AWG 2.0",
    recommended: false,
    legacy: true,
  },
};

export const protocolListSchema = z.array(protocolKindSchema);

// --- Per-key client display name -------------------------------------------
// Which parts make up the connection name the AmneziaVPN client shows for a
// key (the vpn:// payload's `description`). Chosen per key at creation time.
export const keyNameDisplaySchema = z.object({
  // Node public name, e.g. "Frankfurt".
  server: z.boolean().default(true),
  // The key's own device label, e.g. "Main laptop".
  label: z.boolean().default(true),
  // Per-owner sequential key number, rendered as "#3".
  number: z.boolean().default(false),
});

export type KeyNameDisplay = z.infer<typeof keyNameDisplaySchema>;

export const defaultKeyNameDisplay: KeyNameDisplay =
  keyNameDisplaySchema.parse({});

// A fresh copy per parse, so a request object can never mutate the shared default.
const newKeyNameDisplay = (): KeyNameDisplay => ({ ...defaultKeyNameDisplay });

/**
 * Build the client-visible connection name from the enabled parts, joined by a
 * single space in a fixed order: server, label, "#N". Empty parts are skipped.
 * When nothing is enabled (or every enabled part is empty) it falls back to the
 * server name, then the label, then "#N", and finally the literal "VPN" so the
 * client never shows a blank connection.
 */
export const composeKeyDisplayName = (input: {
  serverName: string;
  label?: string | null;
  keyNumber?: number | null;
  display: KeyNameDisplay;
}): string => {
  const serverName = input.serverName.trim();
  const label = (input.label ?? "").trim();
  const number =
    typeof input.keyNumber === "number" && Number.isFinite(input.keyNumber)
      ? `#${input.keyNumber}`
      : "";
  const parts: string[] = [];
  if (input.display.server && serverName) parts.push(serverName);
  if (input.display.label && label) parts.push(label);
  if (input.display.number && number) parts.push(number);
  if (parts.length > 0) return parts.join(" ");
  return serverName || label || number || "VPN";
};

export const createKeyRequestSchema = z.object({
  nodeId: z.uuid(),
  protocol: protocolKindSchema.default("awg3"),
  deviceType: deviceTypeSchema.default("unspecified"),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
  routeProfile: routeProfileSchema.default("full_tunnel"),
  nameDisplay: keyNameDisplaySchema.default(newKeyNameDisplay),
});

/**
 * Deleting a node also deletes every key ever issued on it, so the destructive
 * half is opt-in: without `deleteKeys` a node that still has keys is refused.
 */
export const deleteNodeOptionsSchema = z.object({
  deleteKeys: z.boolean().default(false),
});
export type DeleteNodeOptions = z.infer<typeof deleteNodeOptionsSchema>;

export const quotaRequestSchema = z.object({
  requestedLimit: z.int().min(1).max(1_000),
  // Which server the extra keys are for. Null or omitted = every server, which
  // raises the flat per-user override; a node id targets that one server and
  // raises its entry in `users.nodeKeyLimits`.
  nodeId: z.uuid().nullish(),
  // Optional — a reason is helpful but not required. Stored as "" when omitted.
  reason: z.string().trim().max(1_000).optional(),
  // Strict, unlike every other payload here: this is the ONE request a user can
  // raise for themselves, and the key limit mode is an administrator's decision
  // about how everyone's numbers are read. Stripping an unknown key silently
  // would still be safe, but it would answer 200 to a client that believes it
  // changed the mode. Refusing says what happened. The panel's own dialog sends
  // exactly these three fields, so nothing legitimate is broken by it.
}).strict();

const nodeApiBaseUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Node API URL must use http or https");

export const createNodeRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Optional user-facing server name; empty/omitted falls back to `name`.
  publicName: z.string().trim().max(120).optional(),
  apiBaseUrl: nodeApiBaseUrlSchema,
  apiKey: z.string().min(32).max(4_096),
  enabled: z.boolean().default(true),
  protocol: protocolKindSchema.default("awg3"),
  // Which of the node's supported protocols are offered to users. Omitted /
  // null means "all supported". Empty is rejected — a node must offer at least
  // one protocol.
  enabledProtocols: protocolListSchema.min(1).nullish(),
  maxPeers: z.int().min(1).max(500).default(500),
  capabilities: z.record(z.string().min(1).max(80), z.boolean()).default({}),
});

export const updateNodeRequestSchema = createNodeRequestSchema
  .omit({ apiKey: true })
  .partial()
  .extend({
    apiKey: z.string().min(32).max(4_096).optional(),
    // Only ever null: the resolved address is an observation the worker makes,
    // never something an operator types, so this clears it rather than setting
    // it. The panel resolves a node's host once and keeps the answer, which is
    // right because a server's address does not change under it -- but if one
    // ever does while keeping the same DNS name, nothing would notice. Clearing
    // the stored value makes the next telemetry tick look it up again, so the
    // recovery is a command rather than an UPDATE against production.
    publicIp: z.null().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

// --- Node public address ---------------------------------------------------
// Where clients reach a node. `publicHost` is the node-agent's own
// SERVER_PUBLIC_HOST as it reports it (an IP literal or a DNS name, never a
// URL). `publicIp` is what the panel's worker resolved that host to: the host
// itself when it is already an IPv4 literal, otherwise the first A record.
// Both are null until an agent that reports the field has been polled;
// `publicIp` alone is null when the lookup failed or the host has no IPv4
// address. Consumed by the IP-vs-domain audit (backlog T6).

// Two different questions, deliberately two different schemas:
//  - "is this string an IP rather than a DNS name?" — both families count, and
//    T6's audit needs to classify an IPv6 host as an IP, not as a name.
//  - "what may be stored as this node's resolved address?" — IPv4 only, because
//    the client endpoint line cannot carry an IPv6 address (no bracketing in
//    amneziaWg{,2,3}.service.ts), so an IPv6 value would be unusable.
const ipLiteralSchema = z.union([z.ipv4(), z.ipv6()]);

export const nodePublicAddressSchema = z.object({
  publicHost: z.string().trim().min(1).max(253).nullable(),
  publicIp: z.ipv4().nullable(),
  // When publicIp was learned. A node's public address is a property of the
  // server and does not change, so the worker resolves it once and this is a
  // diagnostic — "where the panel got that number, and when" — not a freshness
  // indicator. Null exactly when publicIp is null.
  publicIpResolvedAt: z.iso.datetime().nullable(),
});
export type NodePublicAddress = z.infer<typeof nodePublicAddressSchema>;

/** True when `host` is a bare IPv4/IPv6 literal (no port, no brackets). */
export const isIpLiteral = (host: string): boolean =>
  ipLiteralSchema.safeParse(host).success;

/** True only for a bare IPv4 literal — what may be stored as `publicIp`. */
export const isIpv4Literal = (host: string): boolean =>
  z.ipv4().safeParse(host).success;

export const createUserRequestSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(160).optional(),
  role: roleSchema.default("user"),
});

/**
 * The three audiences the in-panel connection guide is written for. They are
 * not vendors but the groups whose install steps actually differ: a computer
 * (Windows / macOS / Linux) downloads and runs an installer, Android has a
 * store plus an APK, and iPhone / iPad have a differently-named store listing
 * and the route-profile limitation.
 *
 * Lives here rather than in apps/web because the portal policy carries a value
 * per audience — see installGuideVideosSchema.
 */
export const GUIDE_AUDIENCES = ["desktop", "android", "ios"] as const;
export const guideAudienceSchema = z.enum(GUIDE_AUDIENCES);
export type GuideAudience = z.infer<typeof guideAudienceSchema>;

/**
 * An optional walkthrough video per audience, shown at the top of that
 * audience's instruction. Null everywhere by default: the guide works without
 * one, so a panel that has recorded no videos shows a placeholder rather than a
 * broken player.
 *
 * Protocol-constrained for the same reason as the client download links — the
 * value is rendered as a URL, and `z.url()` alone accepts `javascript:`.
 */
export const installGuideVideosSchema = z.object({
  desktop: z.url({ protocol: /^https?$/ }).nullish(),
  android: z.url({ protocol: /^https?$/ }).nullish(),
  ios: z.url({ protocol: /^https?$/ }).nullish(),
});
export type InstallGuideVideos = z.infer<typeof installGuideVideosSchema>;

/**
 * How a configured walkthrough video should be shown.
 *
 * Google Drive is the expected host for these: recording a short clip and
 * dropping it in Drive is the whole workflow, and Drive will not serve a file
 * to a plain `<video>` tag — its direct-download URLs stopped being dependable,
 * and only the `/preview` page embeds reliably. So a Drive link becomes an
 * iframe and everything else stays a real video element.
 *
 * Returns null when the value is not a usable http(s) URL, so a mistyped
 * setting shows the "no video yet" placeholder instead of a broken frame.
 */
export type InstallVideoEmbed = { kind: "drive" | "file"; src: string };

/** Drive file ids are opaque but always in this alphabet. */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export const installVideoEmbed = (
  value: string | null | undefined,
): InstallVideoEmbed | null => {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/^www\./, "");
  if (host === "drive.google.com") {
    // Both shapes Drive hands out: /file/d/<id>/view and /open?id=<id>.
    const fromPath = /^\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
    const id = fromPath ?? url.searchParams.get("id") ?? "";
    if (!DRIVE_FILE_ID.test(id)) return null;
    // Rebuilt from the validated id rather than rewritten from the input, so
    // nothing from the original query or fragment survives into the frame.
    return { kind: "drive", src: `https://drive.google.com/file/d/${id}/preview` };
  }
  return { kind: "file", src: url.href };
};

// --- Key limit mode ----------------------------------------------------------
// "per_node": a user may hold up to `limit` keys on EACH server (the original
// behaviour, and the default). "global": `limit` is one total shared by every
// server. The global value lives on portal_policy; a per-user override is an
// ordinary policyOverride field, so `resolvePortalPolicy` applies it. Per-node
// limits (`users.nodeKeyLimits`) are kept but not enforced while the effective
// mode is "global".
export const keyLimitModeSchema = z.enum(["per_node", "global"]);
export type KeyLimitMode = z.infer<typeof keyLimitModeSchema>;

export const portalPolicySchema = z.object({
  allowKeyCreation: z.boolean().default(true),
  allowNodeSelection: z.boolean().default(true),
  // Protocols users are offered when creating a key (org-wide default; a
  // per-user override in policyOverride replaces this list). AWG 3.1 only by
  // default — awg2 stays available to switch back on per node/user/globally.
  allowedProtocols: protocolListSchema.min(1).default(["awg3"]),
  // Nodes users may create keys on; null = all. Per-user override in
  // policyOverride.allowedNodeIds.
  allowedNodeIds: z.array(z.uuid()).nullish(),
  // Whether the key limit is counted per server or as one shared pool.
  keyLimitMode: keyLimitModeSchema.default("per_node"),
  allowRouteProfileSelection: z.boolean().default(true),
  // Let users manage their OWN custom routes (extra CIDRs/domains layered on a
  // split-tunnel profile). Admins can always edit them per user.
  allowCustomRoutes: z.boolean().default(true),
  allowConfigRedownload: z.boolean().default(true),
  allowQrDownload: z.boolean().default(true),
  allowConfDownload: z.boolean().default(true),
  allowSelfRevoke: z.boolean().default(true),
  showPublicKey: z.boolean().default(false),
  showLastUsed: z.boolean().default(true),
  showTraffic: z.boolean().default(true),
  // Whether ordinary users see the address of each node they may use
  // (GET /api/nodes -> publicAddress). Default OFF: a node's address is
  // operational information, so turning it on is a deliberate decision rather
  // than something an upgrade does to an existing deployment. Note this is the
  // opposite default from showNodeStatus, which ships on.
  showNodeAddress: z.boolean().default(false),
  // Walkthrough videos for the connection guide, one per audience. Empty by
  // default; an admin fills them in when the recordings exist.
  installGuideVideos: installGuideVideosSchema.default({}),
});

export const portalPolicyOverrideSchema = portalPolicySchema.partial();
export const defaultPortalPolicy = portalPolicySchema.parse({});

// --- Per-user, per-node key limits -----------------------------------------
// The key limit has always been PER NODE (a user may hold up to `limit` keys on
// each node). This map lets an admin give a single user a different limit on a
// single node. Keys are node ids; a node with no entry falls back to the user's
// flat override and then to the global default.
export const nodeKeyLimitsSchema = z.record(z.uuid(), z.int().min(0).max(1_000));
export type NodeKeyLimits = z.infer<typeof nodeKeyLimitsSchema>;

/**
 * Payload of the admin `users/set-limit` action. It owns everything a single
 * user's quota is made of: the flat override, which nodes they may use, and
 * the per-node limits.
 *
 * - `keyLimitOverride` is required; `null` clears the override so the global
 *   default applies.
 * - `allowedNodeIds` is optional. Omitted leaves node availability untouched;
 *   `null` clears the per-user override so the global list applies again; `[]`
 *   means "no node at all" (deliberately distinct from `null`).
 * - `nodeKeyLimits` is optional. Omitted leaves the per-node limits untouched;
 *   `null` (or an empty map) clears them.
 * - `keyLimitMode` is optional. Omitted leaves the per-user mode untouched;
 *   `null` clears the override so the global mode applies again.
 */
export const setUserLimitRequestSchema = z.object({
  keyLimitOverride: z.int().min(0).max(1_000).nullable(),
  allowedNodeIds: z.array(z.uuid()).nullish(),
  nodeKeyLimits: nodeKeyLimitsSchema.nullish(),
  keyLimitMode: keyLimitModeSchema.nullish(),
});
export type SetUserLimitRequest = z.infer<typeof setUserLimitRequestSchema>;

export type ProtocolKind = z.infer<typeof protocolKindSchema>;
export type KeyState = z.infer<typeof keyStateSchema>;
export type RouteProfile = z.infer<typeof routeProfileSchema>;
export type DeviceType = z.infer<typeof deviceTypeSchema>;
export type Role = z.infer<typeof roleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;
export type CreateKeyRequest = z.infer<typeof createKeyRequestSchema>;
export type QuotaRequest = z.infer<typeof quotaRequestSchema>;
export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;
export type UpdateNodeRequest = z.infer<typeof updateNodeRequestSchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type PortalPolicy = z.infer<typeof portalPolicySchema>;
export type PortalPolicyOverride = z.infer<typeof portalPolicyOverrideSchema>;

export type RulePayload = { cidrs: string[]; domains: string[] };

// --- Per-user custom routes ------------------------------------------------
// Advanced users layer their OWN CIDRs/domains on top of a split-tunnel
// profile's base feed at export time (union + dedup). Only the split-tunnel
// profiles accept extras — full_tunnel already routes everything through VPN.
// Base feed contents are never surfaced; users only ever see their own entries.
export const CUSTOM_ROUTE_PROFILES = ["ru_whitelist", "ru_blacklist"] as const;
export type CustomRouteProfile = (typeof CUSTOM_ROUTE_PROFILES)[number];

export const MAX_CUSTOM_CIDRS = 200;
export const MAX_CUSTOM_DOMAINS = 200;

// Punycode-aware bare hostname (mirrors the worker feed validator): no scheme,
// no wildcards, no leading dot. `.рф` etc. must be pre-encoded as `xn--`.
const customDomainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

// Accept an IPv4/IPv6 CIDR, or a bare IP normalized to a host route.
const customCidrSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.union([
    z.cidrv4(),
    z.cidrv6(),
    z.ipv4().transform((ip) => `${ip}/32`),
    z.ipv6().transform((ip) => `${ip}/128`),
  ]),
);

const customDomainSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.string().regex(customDomainPattern, "Invalid domain"),
);

export const customRouteListSchema = z.object({
  cidrs: z.array(customCidrSchema).max(MAX_CUSTOM_CIDRS).default([]),
  domains: z.array(customDomainSchema).max(MAX_CUSTOM_DOMAINS).default([]),
});

export const customRoutesSchema = z.object({
  ru_whitelist: customRouteListSchema.default({ cidrs: [], domains: [] }),
  ru_blacklist: customRouteListSchema.default({ cidrs: [], domains: [] }),
});

export const updateCustomRoutesRequestSchema = customRoutesSchema;

export type CustomRouteList = z.infer<typeof customRouteListSchema>;
export type CustomRoutes = z.infer<typeof customRoutesSchema>;

// --- Global route overrides (admin-wide) -----------------------------------
// Admins layer their own additions and exclusions on top of a split-tunnel
// profile's base feed for EVERY user. Exclusions are applied before additions;
// a user's own custom routes are applied last and therefore re-add anything the
// admin excluded (a deliberate per-user opt-back-in).
export const MAX_GLOBAL_CIDRS = 2_000;
export const MAX_GLOBAL_DOMAINS = 2_000;

export const globalRouteListSchema = z.object({
  cidrs: z.array(customCidrSchema).max(MAX_GLOBAL_CIDRS).default([]),
  domains: z.array(customDomainSchema).max(MAX_GLOBAL_DOMAINS).default([]),
});

// Factories, not shared literals: every parse gets its own arrays so a stored
// payload can never alias another one.
const newGlobalRouteList = (): GlobalRouteList => ({ cidrs: [], domains: [] });

export const globalRouteProfileSchema = z.object({
  add: globalRouteListSchema.default(newGlobalRouteList),
  exclude: globalRouteListSchema.default(newGlobalRouteList),
});

const newGlobalRouteProfile = (): GlobalRouteProfile => ({
  add: newGlobalRouteList(),
  exclude: newGlobalRouteList(),
});

export const globalRoutesSchema = z.object({
  ru_whitelist: globalRouteProfileSchema.default(newGlobalRouteProfile),
  ru_blacklist: globalRouteProfileSchema.default(newGlobalRouteProfile),
});

export const updateGlobalRoutesRequestSchema = globalRoutesSchema;

export type GlobalRouteList = z.infer<typeof globalRouteListSchema>;
export type GlobalRouteProfile = z.infer<typeof globalRouteProfileSchema>;
export type GlobalRoutes = z.infer<typeof globalRoutesSchema>;

export const emptyGlobalRoutes: GlobalRoutes = globalRoutesSchema.parse({});

// --- Manual route-feed refresh ---------------------------------------------
// The worker fetches the configured feeds on a timer; an operator can also ask
// for a check right now. Control-api only enqueues the job (the feeds and the
// fetch logic live in the worker), so both sides agree on this job type and on
// the single outbox deduplication key that keeps one run in flight at a time.
export const RULES_REFRESH_JOB_TYPE = "rules.refresh";
export const RULES_REFRESH_DEDUPLICATION_KEY = "rules.refresh";

export const rulesRefreshStatusSchema = z.object({
  // "idle" = never requested. The rest mirror the outbox row: a completed run
  // means "checked" — an unchanged feed is a successful no-op, not a failure.
  status: z.enum(["idle", "pending", "processing", "completed", "failed"]),
  /** When the run was last requested (ISO-8601), null while idle. */
  queuedAt: z.iso.datetime().nullable(),
  /** When the last run finished (ISO-8601), null if it never has. */
  completedAt: z.iso.datetime().nullable(),
  /** Message of the last failed or retried attempt, null otherwise. */
  lastError: z.string().nullable(),
});

export type RulesRefreshStatus = z.infer<typeof rulesRefreshStatusSchema>;

export const idleRulesRefreshStatus: RulesRefreshStatus = {
  status: "idle",
  queuedAt: null,
  completedAt: null,
  lastError: null,
};

// --- AmneziaVPN client releases --------------------------------------------
// The panel tells users where to get the client. A panel user may sit on a
// network with no route to GitHub, so control-api resolves the current release
// server-side and the web app only renders the answer. These shapes are that
// answer; the resolution itself lives in apps/control-api/src/clientReleases.ts.

/**
 * Oldest official AmneziaVPN client that can use an AmneziaWG 3.1 key
 * (AGENTS.md "Protocol"). This is a protocol floor, not "the newest release" —
 * the two are different questions, so it is deliberately not part of the
 * resolved release payload. Single source for the create-key wizard hint and
 * the install guide alike.
 */
export const MIN_AWG3_CLIENT_VERSION = "5.0.1.5";

/**
 * Platforms the install guide offers, in the order the buttons render.
 *
 * Grouped by the instructions they share, not by vendor: Windows, macOS and
 * Linux are one desktop group (same app, same steps, a downloaded installer),
 * Android is its own (a store plus an APK), and iOS is its own (a store listing
 * under a different name, and no working route profiles). The guide renders
 * those three groups; this array is the flat list behind them.
 */
export const CLIENT_PLATFORMS = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
] as const;

export const clientPlatformSchema = z.enum(CLIENT_PLATFORMS);
export type ClientPlatform = z.infer<typeof clientPlatformSchema>;

/**
 * One place a user can be sent to get the client.
 *
 * - `store`      — Google Play / the App Store. No file name or size.
 * - `installer`  — a single release asset; `fileName` and `sizeBytes` are set
 *                  so the UI can show what is about to be downloaded.
 * - `releasePage` — the release listing, used when the expected asset was not
 *                  found and by the offline fallback. The user picks the file.
 */
export const clientAssetSchema = z.object({
  // Protocol-constrained on purpose: bare z.url() accepts `javascript:` (it is
  // a valid URL), and every one of these values is rendered as an href in the
  // install guide. The resolver only ever produces https, so this costs
  // nothing and closes the one shape that would matter if it ever did.
  url: z.url({ protocol: /^https?$/ }),
  kind: z.enum(["store", "installer", "releasePage"]),
  fileName: z.string().min(1).max(200).nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
});
export type ClientAsset = z.infer<typeof clientAssetSchema>;

export const clientPlatformDownloadSchema = z.object({
  platform: clientPlatformSchema,
  /** Where the platform's main button goes. */
  primary: clientAssetSchema,
  /**
   * The platform's second way in, when one button cannot serve everyone.
   * Android's is an escape hatch — the APK, for users Google Play does not
   * reach. iOS's is a different app: AmneziaVPN, which is hidden from the
   * Russian App Store, behind the DefaultVPN listing that is not.
   */
  alternate: clientAssetSchema.nullable(),
});
export type ClientPlatformDownload = z.infer<typeof clientPlatformDownloadSchema>;

export const clientReleaseSchema = z.object({
  /** Resolved release tag, e.g. "5.0.1.5". Null in the offline fallback. */
  version: z.string().min(1).max(40).nullable(),
  /** The release page. In the fallback, GitHub's permanent latest redirect. */
  releaseUrl: z.url({ protocol: /^https?$/ }),
  /** When the release was published (ISO-8601), null when unknown. */
  publishedAt: z.iso.datetime().nullable(),
  /** True when GitHub could not be reached and the pinned links are served. */
  fallback: z.boolean(),
  /** When this snapshot was produced (ISO-8601). */
  resolvedAt: z.iso.datetime(),
  /** Exactly one entry per platform, so the UI can map it straight to buttons. */
  downloads: z
    .array(clientPlatformDownloadSchema)
    .length(CLIENT_PLATFORMS.length),
});
export type ClientRelease = z.infer<typeof clientReleaseSchema>;

// --- Route profiles per device type ----------------------------------------

/**
 * Device types on which the official client is known NOT to apply a route
 * profile. Operator-verified on an iPhone, 2026-09-02 and 2026-09-03: a key
 * with `ru_whitelist` or `ru_blacklist` connects, but every destination goes
 * direct and the app gives no warning. Confirmed for BOTH import paths — the
 * pasted vpn:// key and an imported .conf.
 *
 * This is a STOP-GAP that makes the limitation visible, not a statement that
 * iOS will never support route profiles. The cause is not established (see the
 * T2-a backlog item); when it is fixed, empty this list and the create-key
 * wizard offers the profiles again with no other change.
 *
 * The client observed was Default VPN -- the listing the Russian App Store
 * offers, because AmneziaVPN itself is hidden from it by Roskomnadzor
 * requirement. AmneziaVPN on iOS is a different app and was never observed
 * failing, so the wizard lets a user say they run it and lifts the block for
 * that key. "ios" stays on this list because Default VPN is what most iOS users
 * end up with, and the default has to be the common case.
 *
 * Only "ios" is listed, and it covers iPhone AND iPad — they are one value, so
 * iPad is covered by construction rather than by a guess. The other platforms
 * are deliberately absent: disabling a working feature on hardware where the
 * limitation was never observed would be the same class of mistake in the
 * other direction.
 */
export const ROUTE_PROFILE_UNSUPPORTED_DEVICES = ["ios"] as const;

/**
 * Whether a key created for this device type can usefully carry a route
 * profile. Drives the create-key wizard's greyed-out profile cards, the key
 * card's warning and the CLI's `user-create-key` warning.
 *
 * Takes a plain `string`, not `DeviceType`: `KeyView.deviceType` arrives from
 * the API as a string, and a browser tab left open across a deploy can still
 * send a retired value. An unrecognised value is treated as supported —
 * nothing is disabled without an observation.
 *
 * This is advice about where a key is being CREATED, not about where it will
 * be used: nothing in the export path branches on the device type, and nothing
 * should. See the plan's D9.
 */
export function deviceSupportsRouteProfiles(deviceType: string): boolean {
  return !(ROUTE_PROFILE_UNSUPPORTED_DEVICES as readonly string[]).includes(
    deviceType,
  );
}
