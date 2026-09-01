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
export const deviceTypeSchema = z.enum([
  "desktop",
  "laptop",
  "iphone",
  "android",
  "phone",
  "other",
  "unspecified",
]);
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

export const quotaRequestSchema = z.object({
  requestedLimit: z.int().min(1).max(1_000),
  // Optional — a reason is helpful but not required. Stored as "" when omitted.
  reason: z.string().trim().max(1_000).optional(),
});

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
  .extend({ apiKey: z.string().min(32).max(4_096).optional() })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const createUserRequestSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(160).optional(),
  role: roleSchema.default("user"),
});

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
 */
export const setUserLimitRequestSchema = z.object({
  keyLimitOverride: z.int().min(0).max(1_000).nullable(),
  allowedNodeIds: z.array(z.uuid()).nullish(),
  nodeKeyLimits: nodeKeyLimitsSchema.nullish(),
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
