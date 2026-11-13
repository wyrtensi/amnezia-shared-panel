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

/**
 * Host commands for the bridge installer (`/opt/amnezia-bridge/install-frps.sh` on the bridge host).
 * Built from the bridge id, control port and UDP range only; no secrets.
 */
export const bridgeSetupCommandsSchema = z.object({
  install: z.string(),
  dryRun: z.string(),
});
export type BridgeSetupCommands = z.infer<typeof bridgeSetupCommandsSchema>;

/**
 * Host commands for the node route installer (`/opt/amnezia-panel-node/scripts/install-frpc.sh` on the node host).
 * Built from the route id, the bridge IPv4, the control port and the public
 * port only; the script detects the local AWG target itself. Its optional
 * `--local-udp-port <udp>` / `--local-ip <ipv4>` overrides are not generated:
 * append them to `install` when detection asks for them. `remove`
 * retires the route's frpc unit and config.
 */
export const routeSetupCommandsSchema = z.object({
  install: z.string(),
  dryRun: z.string(),
  remove: z.string(),
});
export type RouteSetupCommands = z.infer<typeof routeSetupCommandsSchema>;

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
  setupCommands: bridgeSetupCommandsSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const prepareBridgeRouteRequestSchema = z.object({
  bridgeId: z.uuid(),
  publicUdpPort: portSchema.optional(),
});

/** A route as the node's route editor shows it: plus its bridge's public settings. */
export const nodeBridgeRouteSchema = bridgeRouteSchema.extend({
  bridgeName: z.string(),
  bridgePublicIpv4: z.string(),
  bridgeControlTcpPort: portSchema,
  bridgeManagementStatus: bridgeManagementStatusSchema,
  bridgeLastObservedAt: z.iso.datetime().nullable(),
  setupCommands: routeSetupCommandsSchema.optional(),
});

/**
 * `GET /api/admin/nodes/:id/vpn-bridge-routes`: the node's endpoint
 * assignment. `activeRoute` null means Direct.
 */
export const nodeBridgeRoutesSchema = z.object({
  nodeId: z.uuid(),
  vpnEndpointRevision: z.int().min(0),
  activeRoute: nodeBridgeRouteSchema.nullable(),
  drafts: z.array(nodeBridgeRouteSchema),
  retiring: z.array(nodeBridgeRouteSchema),
});

/**
 * `POST /api/admin/nodes/:id/vpn-bridge-routes`. `created` is false when the
 * pairing already held a route and that route was returned instead (HTTP 200
 * rather than 201).
 */
export const prepareBridgeRouteResultSchema = z.object({
  created: z.boolean(),
  route: nodeBridgeRouteSchema,
});

/** `DELETE /api/admin/vpn-bridge-routes/:id?confirmed=true`. */
export const releaseBridgeRouteResultSchema = z.object({
  id: z.uuid(),
  released: z.literal(true),
  nodeId: z.uuid(),
  bridgeId: z.uuid(),
  publicUdpPort: portSchema,
});

/** `DELETE /api/admin/vpn-bridges/:id`. */
export const deleteBridgeResultSchema = z.object({
  id: z.uuid(),
  deleted: z.literal(true),
});

/**
 * The endpoint assignment a node PATCH with `vpnBridgeRouteId` returns, under
 * `vpnEndpoint`. `changed` is false for a no-op (the requested route is
 * already active, or Direct was requested for a node already on Direct).
 */
export const nodeEndpointAssignmentSchema = z.object({
  changed: z.boolean(),
  vpnEndpointRevision: z.int().min(0),
  activeRoute: nodeBridgeRouteSchema.nullable(),
});

/**
 * Dry-run of the endpoint renderer over a node's stored AWG3-issued configs
 * (`GET /api/admin/nodes/:id/vpn-bridge-eligibility`). Counts only: no key
 * ids and no artifact content. A bridge can be activated only while
 * `unsupported` is 0.
 */
export const bridgeEligibilitySchema = z.object({
  nodeId: z.uuid(),
  /** Usable stored configs examined (keys issued as AWG3 or AWG2). */
  total: z.int().min(0),
  /** AWG3-issued keys whose artifact is 3.1 and renders to a bridge endpoint. */
  awg31Eligible: z.int().min(0),
  /** AWG3-issued keys whose artifact is the 2.0 fallback; they stay Direct. */
  awg20Direct: z.int().min(0),
  /** Keys issued as AWG2; they always stay Direct. */
  awg2NativeDirect: z.int().min(0),
  /** AWG3-issued keys that are unrecognized, ambiguous or unreadable. */
  unsupported: z.int().min(0),
});
export type BridgeEligibility = z.infer<typeof bridgeEligibilitySchema>;

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
  // Summary fields of the admin nodes list. Optional so a minimal row (and
  // the pre-1b shape) still parses; the Control API always sends them.
  publicName: z.string().nullable().optional(),
  protocol: z.enum(["awg2", "awg3"]).optional(),
  enabledProtocols: z.array(z.enum(["awg2", "awg3"])).nullable().optional(),
  maxPeers: z.int().min(0).optional(),
  peerCount: z.int().min(0).optional(),
  publicHost: z.string().nullable().optional(),
  publicIp: z.string().nullable().optional(),
  agentVersion: z.string().nullable().optional(),
  lastHealthAt: z.iso.datetime().nullable().optional(),
  lastError: z.string().nullable().optional(),
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
  // 404s: an unknown bridge id, or a route id that does not exist (or does not
  // belong to the node named in the path).
  "BRIDGE_NOT_FOUND",
  "BRIDGE_ROUTE_NOT_FOUND",
  // 409: route preparation for a node that does not serve AWG 3.1.
  "BRIDGE_NODE_NOT_AWG31",
  // Test-config preview: 403 for a key on another VPN node, 409 for a key
  // that is not an active AWG 3.1 key.
  "BRIDGE_TEST_KEY_WRONG_NODE",
  "BRIDGE_TEST_KEY_UNSUITABLE",
  // 409: a probe check of the route for an older registration marker is
  // still queued or running; ask again once it has settled.
  "BRIDGE_CHECK_PENDING",
] as const;
export const bridgeErrorCodeSchema = z.enum(BRIDGE_ERROR_CODES);

/**
 * How old the latest bridge-agent observation may be and still count as
 * current (ruling R8). Overridable with `VPN_BRIDGE_OBSERVATION_STALE_MS`.
 */
export const BRIDGE_OBSERVATION_STALE_MS_DEFAULT = 300_000;

/** How long a successful route verification stays valid for activation. */
export const BRIDGE_VERIFICATION_VALIDITY_MS = 30 * 60 * 1_000;

/**
 * `VPN_BRIDGE_JOBS_ENABLED` (ruling R6): whether bridge-related jobs may be
 * queued. Only the exact string "true" enables them, the same convention as
 * `ACCESS_SYNC_ENABLED`, so an unset, empty or mistyped value keeps the safe
 * default (disabled) during migrations and mixed-version deployments.
 */
export const parseBridgeJobsEnabled = (raw: string | undefined): boolean =>
  raw?.trim() === "true";

/**
 * `VPN_BRIDGE_OBSERVATION_STALE_MS`: a positive integer of milliseconds, or
 * the default when unset or empty. Anything else is a configuration error.
 */
export const parseBridgeObservationStaleMs = (raw: string | undefined): number => {
  const value = raw?.trim();
  if (!value) return BRIDGE_OBSERVATION_STALE_MS_DEFAULT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("VPN_BRIDGE_OBSERVATION_STALE_MS must be a positive integer");
  }
  return parsed;
};

// --- Candidate validation: test-config preview and verification ------------

/**
 * The frps registration marker the bridge-agent reports for a route (an
 * opaque string derived from the frps client ID and its last start time). A
 * verification is bound to the marker that was tested; a changed marker
 * means a different registration and needs fresh verification.
 */
export const bridgeRegistrationMarkerSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f),
    "Must not contain control characters",
  );

/**
 * `GET /api/admin/vpn-bridge-routes/:id/test-config?keyId=…` answers with the
 * `.vpn` file as the body and the route's current observed registration
 * marker in this header, percent-encoded (`encodeURIComponent`). The header
 * is absent while no registration has been observed.
 */
export const BRIDGE_REGISTRATION_MARKER_HEADER = "x-bridge-registration-marker";

export const encodeRegistrationMarkerHeader = (marker: string): string =>
  encodeURIComponent(marker);

/** The marker from the header value, or null when absent or undecodable. */
export const decodeRegistrationMarkerHeader = (
  value: string | null | undefined,
): string | null => {
  if (value === null || value === undefined || value === "") return null;
  try {
    const decoded = decodeURIComponent(value);
    return bridgeRegistrationMarkerSchema.safeParse(decoded).success ? decoded : null;
  } catch {
    return null;
  }
};

export const bridgeTestConfigQuerySchema = z.object({ keyId: z.uuid() });

/**
 * `POST /api/admin/vpn-bridge-routes/:id/verify`.
 * - `probe`: queue an external probe check of the draft endpoint (needs
 *   `VPN_BRIDGE_JOBS_ENABLED` and a probe with the bridge-measurement
 *   capability).
 * - `operator`: the administrator attests a real AWG handshake and HTTP
 *   through the tunnel from a client network, for the registration marker
 *   they tested (from the test-config preview).
 */
export const verifyBridgeRouteRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("probe") }).strict(),
  z
    .object({
      method: z.literal("operator"),
      registrationMarker: bridgeRegistrationMarkerSchema,
      confirmHandshakeAndHttp: z.literal(true),
    })
    .strict(),
]);
export type VerifyBridgeRouteRequest = z.infer<typeof verifyBridgeRouteRequestSchema>;

/**
 * 202 for `probe`. `status`:
 * - `queued`: a new check was queued (`queued` true);
 * - `pending`: a check of the route for the same marker was already queued,
 *   and that job is returned;
 * - `running`: a check of the route for the same marker already has its run
 *   on the probe (`runId`); `jobId` is the job that started it, null when
 *   that job row is gone.
 * A check for a different (older) marker answers 409 `BRIDGE_CHECK_PENDING`
 * instead. 200 for `operator`: the route with its recorded verification.
 */
export const verifyBridgeRouteResultSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("probe"),
    routeId: z.uuid(),
    jobId: z.uuid().nullable(),
    queued: z.boolean(),
    status: z.enum(["queued", "pending", "running"]),
    runId: z.uuid().nullable(),
    registrationMarker: bridgeRegistrationMarkerSchema,
  }),
  z.object({
    method: z.literal("operator"),
    routeId: z.uuid(),
    route: nodeBridgeRouteSchema,
  }),
]);
export type VerifyBridgeRouteResult = z.infer<typeof verifyBridgeRouteResultSchema>;

/** Outbox job type of a queued probe candidate check. */
export const BRIDGE_ROUTE_CANDIDATE_CHECK_JOB_TYPE = "bridge_route_candidate_check";

/**
 * The job payload: IDs and the registration marker observed when the check
 * was queued, which the result is bound to. Never a config or a key id.
 */
export const bridgeRouteCandidateCheckPayloadSchema = z.object({
  routeId: z.uuid(),
  nodeId: z.uuid(),
  registrationMarker: bridgeRegistrationMarkerSchema,
  requestedAt: z.iso.datetime(),
});
export type BridgeRouteCandidateCheckPayload = z.infer<
  typeof bridgeRouteCandidateCheckPayloadSchema
>;

/**
 * The bounded codes a probe candidate check stores in `verificationError`.
 * Never the probe's free-form detail.
 */
export const BRIDGE_CANDIDATE_CHECK_ERRORS = [
  "BRIDGE_JOBS_DISABLED",
  "BRIDGE_UNSUPPORTED_CAPABILITY",
  "PROBE_UNAVAILABLE",
  "PROBE_BUSY",
  "PROBE_START_FAILED",
  "PROBE_RUN_LOST",
  "PROBE_RUN_TIMEOUT",
  // The run finished, but was settled too long after it started to count.
  "PROBE_RESULT_STALE",
  "PROBE_CONTROL_FAILED",
  "PROBE_TARGET_ERROR",
  "SERVICE_KEY_UNAVAILABLE",
  "SERVICE_KEY_NOT_AWG31",
  "AWG_HANDSHAKE_FAILED",
  "HTTP_THROUGH_TUNNEL_FAILED",
] as const;
export type BridgeCandidateCheckError = (typeof BRIDGE_CANDIDATE_CHECK_ERRORS)[number];

/** The probe capability that makes bridged measurements meaningful. */
export const BRIDGE_MEASUREMENT_CAPABILITY = "bridge-measurement";

/** What the panel knows about the probe's capabilities; null when unknown. */
export type ProbeCapabilityInput = {
  readonly capabilities: readonly string[] | null;
};

/**
 * Whether the configured probe can measure a bridged path (explicit
 * `expectedEgressIp: null`, handshake and HTTP reported apart from ping and
 * SSH). The single capability lookup for candidate checks: Task 4a supplies
 * the probe's typed capability response; until then nothing reports
 * capabilities, so this is false and `verify {method: "probe"}` answers
 * `BRIDGE_UNSUPPORTED_CAPABILITY` (unknown counts as unsupported).
 */
export const probeSupportsBridgeMeasurement = (probe: ProbeCapabilityInput): boolean =>
  probe.capabilities?.includes(BRIDGE_MEASUREMENT_CAPABILITY) === true;

/**
 * The capability input from the stored `reachability_probe.capabilities`
 * column (jsonb, null until the probe's capability response is cached).
 * The one place both the Control API and the worker read it: Task 4a writes
 * the column from the probe's typed capability endpoint and nothing else
 * changes. Anything but an array of strings reads as unknown.
 */
export const probeCapabilityInputOf = (stored: unknown): ProbeCapabilityInput => ({
  capabilities:
    Array.isArray(stored) && stored.every((item) => typeof item === "string")
      ? stored
      : null,
});

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
export type NodeBridgeRoute = z.infer<typeof nodeBridgeRouteSchema>;
export type NodeBridgeRoutes = z.infer<typeof nodeBridgeRoutesSchema>;
export type PrepareBridgeRouteResult = z.infer<typeof prepareBridgeRouteResultSchema>;
export type ReleaseBridgeRouteResult = z.infer<typeof releaseBridgeRouteResultSchema>;
export type DeleteBridgeResult = z.infer<typeof deleteBridgeResultSchema>;
export type NodeEndpointAssignment = z.infer<typeof nodeEndpointAssignmentSchema>;
export type InfrastructureVpnItem = z.infer<typeof infrastructureVpnItemSchema>;
export type InfrastructureBridgeItem = z.infer<typeof infrastructureBridgeItemSchema>;
