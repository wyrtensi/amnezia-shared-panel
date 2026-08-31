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

export const createKeyRequestSchema = z.object({
  nodeId: z.uuid(),
  protocol: protocolKindSchema.default("awg3"),
  deviceType: deviceTypeSchema.default("unspecified"),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
  routeProfile: routeProfileSchema.default("full_tunnel"),
});

export const quotaRequestSchema = z.object({
  requestedLimit: z.int().min(1).max(1_000),
  reason: z.string().trim().min(10).max(1_000),
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
  // split-tunnel profile). Off by default; admins can always edit them per user.
  allowCustomRoutes: z.boolean().default(false),
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

/**
 * Curated starter rule sets used when an operator seeds a routing profile with
 * one click. Production deployments replace these via the worker rule feeds.
 * Both profiles route the listed destinations through the VPN; the naming
 * reflects intent (foreign services vs. RKN-blocked resources).
 */
// Small, correct fallback seeds used only until the live RoscomVPN/Re:filter
// feeds load (configure RULE_FEEDS in the worker). Real routing uses tens of
// thousands of entries fetched at runtime — see infra/dev/ROUTE-PROFILES-POC.md.
export const routeRuleSeeds: Record<
  Exclude<RouteProfile, "full_tunnel">,
  RulePayload
> = {
  // "Everything except RU": a representative set of popular foreign services RU
  // users route through the VPN. Replaced at runtime by the RoscomVPN whitelist.
  ru_whitelist: {
    cidrs: [
      "31.13.24.0/21", // Meta / Instagram / Facebook
      "157.240.0.0/16", // Meta
      "104.244.42.0/24", // Twitter / X
      "91.108.4.0/22", // Telegram
      "149.154.160.0/20", // Telegram
      "185.70.40.0/22", // Proton
    ],
    domains: [
      "instagram.com",
      "facebook.com",
      "x.com",
      "linkedin.com",
      "discord.com",
      "notion.so",
      "openai.com",
      "claude.ai",
    ],
  },
  // "Only blocked": RKN-blocked resources through the VPN. Replaced at runtime
  // by the Re:filter blocklists.
  ru_blacklist: {
    cidrs: [
      "104.244.42.0/24", // Twitter / X
      "91.108.4.0/22", // Telegram
      "149.154.160.0/20", // Telegram
      "31.13.24.0/21", // Meta
    ],
    domains: [
      "rutracker.org",
      "rutor.org",
      "nnmclub.to",
      "flibusta.is",
      "kinozal.tv",
      "instagram.com",
      "facebook.com",
      "x.com",
      "pornhub.com",
      "linkedin.com",
    ],
  },
};
