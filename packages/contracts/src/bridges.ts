import { z } from "zod";

/**
 * Optional AWG 3.1 node bridges: registry contracts.
 *
 * A bridge is a public host running `frps` plus `bridge-agent`. Routes tie one
 * VPN node to one bridge UDP port. This file holds the typed shapes shared by
 * the Control API, CLI and web client; persistence lives in `@amnezia/db`.
 */

const IPV4_DOTTED_QUAD = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

// Special-purpose IPv4 ranges that are never a valid public bridge address.
// Each entry is [first address, prefix length].
const NONPUBLIC_IPV4_RANGES: ReadonlyArray<
  readonly [string, number, string]
> = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared address space"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

const ipv4ToInt = (octets: readonly number[]): number =>
  ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;

export type PublicIpv4Classification =
  | { ok: true; address: string }
  | { ok: false; reason: string };

/**
 * Classify a candidate bridge address.
 *
 * Only a strict dotted quad is accepted. Octets with leading zeros (such as
 * `010.1.1.1`) are rejected rather than normalized: some parsers read them as
 * octal, so accepting them would let one string mean two different hosts.
 * Hostnames, URIs, `ip:port`, IPv6 and whitespace-padded input are rejected.
 * The input is not trimmed here; callers that want trimming do it first.
 */
export const classifyPublicIpv4 = (input: string): PublicIpv4Classification => {
  if (!IPV4_DOTTED_QUAD.test(input)) {
    return { ok: false, reason: "Must be a plain dotted-quad IPv4 address" };
  }
  const octets = input.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) {
    return { ok: false, reason: "Octet out of range" };
  }
  const value = ipv4ToInt(octets);
  for (const [base, prefix, label] of NONPUBLIC_IPV4_RANGES) {
    const baseValue = ipv4ToInt(base.split(".").map(Number));
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    if (((value & mask) >>> 0) === ((baseValue & mask) >>> 0)) {
      return { ok: false, reason: `Not a public address (${label})` };
    }
  }
  return { ok: true, address: input };
};

export const publicIpv4Schema = z.string().superRefine((value, ctx) => {
  const result = classifyPublicIpv4(value);
  if (!result.ok) ctx.addIssue({ code: "custom", message: result.reason });
});

export const BRIDGE_DEFAULT_CONTROL_TCP_PORT = 7000;
export const BRIDGE_DEFAULT_UDP_PORT_START = 41000;
export const BRIDGE_DEFAULT_UDP_PORT_END = 41031;

const portSchema = z.int().min(1).max(65_535);
const bridgeNameSchema = z.string().trim().min(1).max(120);

export const createBridgeRequestSchema = z
  .object({
    name: bridgeNameSchema,
    publicIpv4: publicIpv4Schema,
    controlTcpPort: portSchema.default(BRIDGE_DEFAULT_CONTROL_TCP_PORT),
    udpPortStart: portSchema.default(BRIDGE_DEFAULT_UDP_PORT_START),
    udpPortEnd: portSchema.default(BRIDGE_DEFAULT_UDP_PORT_END),
  })
  .refine((value) => value.udpPortStart <= value.udpPortEnd, {
    path: ["udpPortEnd"],
    message: "UDP port range end must not be below its start",
  });

// Only the name is editable here. Enrollment fields (private management
// endpoint and credentials) are added by the bridge-agent enrollment task by
// extending this object; the host address and port pool never change in place,
// because a replacement host is registered as a new bridge.
export const updateBridgeRequestSchema = z
  .object({
    name: bridgeNameSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const BRIDGE_MANAGEMENT_STATUSES = [
  "pending_enrollment",
  "ok",
  "down",
  "stale",
  "identity_mismatch",
  "unsupported",
] as const;
export const bridgeManagementStatusSchema = z.enum(BRIDGE_MANAGEMENT_STATUSES);

export const BRIDGE_ROUTE_STATES = ["draft", "active", "retiring"] as const;
export const bridgeRouteStateSchema = z.enum(BRIDGE_ROUTE_STATES);

export const BRIDGE_VERIFICATION_METHODS = ["probe", "operator"] as const;
export const bridgeVerificationMethodSchema = z.enum(BRIDGE_VERIFICATION_METHODS);

export const BRIDGE_VERIFICATION_RESULTS = ["success", "failure"] as const;
export const bridgeVerificationResultSchema = z.enum(BRIDGE_VERIFICATION_RESULTS);

/** The frps proxy name for a route; derived from the route id, never typed. */
export const bridgeFrpProxyName = (routeId: string): string => `awg-route-${routeId}`;

export const bridgeRouteSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  bridgeId: z.uuid(),
  publicUdpPort: portSchema,
  state: bridgeRouteStateSchema,
  frpProxyName: z.string(),
  observedOnline: z.boolean().nullable(),
  observedRegistrationMarker: z.string().nullable(),
  observedAt: z.iso.datetime().nullable(),
  verificationMethod: bridgeVerificationMethodSchema.nullable(),
  verifiedRegistrationMarker: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  verificationResult: bridgeVerificationResultSchema.nullable(),
  // Bounded short code; never free-form text and never a secret.
  verificationError: z.string().max(80).nullable(),
  activatedAt: z.iso.datetime().nullable(),
  retiringSince: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const bridgeRouteSummarySchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  nodeName: z.string(),
  publicUdpPort: portSchema,
  state: bridgeRouteStateSchema,
});

export const bridgeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  publicIpv4: z.string(),
  controlTcpPort: portSchema,
  udpPortStart: portSchema,
  udpPortEnd: portSchema,
  // Size of the UDP pool and how many of its ports draft, active and retiring
  // routes hold.
  capacity: z.int().min(1),
  heldPorts: z.int().min(0),
  managementStatus: bridgeManagementStatusSchema,
  lastObservedAt: z.iso.datetime().nullable(),
  routes: z.array(bridgeRouteSummarySchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const prepareBridgeRouteRequestSchema = z.object({
  bridgeId: z.uuid(),
  publicUdpPort: portSchema.optional(),
});

/**
 * Shared admin view of managed infrastructure
 * (`GET /api/admin/infrastructure`). The `kind` discriminator keeps VPN-node
 * consumers scoped to VPN nodes while bridges live in the same list.
 */
export const infrastructureVpnItemSchema = z.object({
  kind: z.literal("vpn"),
  id: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  // The active bridge route, or null when the node is reached directly.
  activeRoute: bridgeRouteSchema.nullable(),
  vpnEndpointRevision: z.int().min(0),
});

export const infrastructureBridgeItemSchema = bridgeSchema.extend({
  kind: z.literal("bridge"),
});

export const infrastructureItemSchema = z.discriminatedUnion("kind", [
  infrastructureVpnItemSchema,
  infrastructureBridgeItemSchema,
]);

export const BRIDGE_ERROR_CODES = [
  "BRIDGE_POOL_EXHAUSTED",
  "BRIDGE_PORT_TAKEN",
  "BRIDGE_PORT_OUT_OF_RANGE",
  "BRIDGE_ROUTE_ACTIVE",
  "BRIDGE_ROUTE_UNVERIFIED",
  "BRIDGE_OBSERVATION_STALE",
  "BRIDGE_REVISION_CONFLICT",
  "BRIDGE_ROUTE_PAIR_CONFLICT",
  "BRIDGE_HAS_ROUTES",
  "NODE_HAS_BRIDGE_ROUTES",
  "BRIDGE_IPV4_CONFLICT",
  "BRIDGE_UNSUPPORTED_CAPABILITY",
  "BRIDGE_JOBS_DISABLED",
  "BRIDGE_CONFIG_UNSUPPORTED",
] as const;
export const bridgeErrorCodeSchema = z.enum(BRIDGE_ERROR_CODES);

export type CreateBridgeRequest = z.infer<typeof createBridgeRequestSchema>;
export type UpdateBridgeRequest = z.infer<typeof updateBridgeRequestSchema>;
export type BridgeManagementStatus = z.infer<typeof bridgeManagementStatusSchema>;
export type BridgeRouteState = z.infer<typeof bridgeRouteStateSchema>;
export type BridgeVerificationMethod = z.infer<typeof bridgeVerificationMethodSchema>;
export type BridgeVerificationResult = z.infer<typeof bridgeVerificationResultSchema>;
export type BridgeRoute = z.infer<typeof bridgeRouteSchema>;
export type BridgeRouteSummary = z.infer<typeof bridgeRouteSummarySchema>;
export type Bridge = z.infer<typeof bridgeSchema>;
export type PrepareBridgeRouteRequest = z.infer<typeof prepareBridgeRouteRequestSchema>;
export type InfrastructureItem = z.infer<typeof infrastructureItemSchema>;
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;
