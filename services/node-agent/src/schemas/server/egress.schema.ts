import { SwaggerContract } from "@/contracts/swagger";
import { AppFastifySchema } from "@/types/shared";

export const IPV4_PATTERN =
  "^(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)$";

export const desiredExitSchema = {
  type: "object",
  required: ["id", "ipv4", "dnsPrimary", "amneziaDnsDnat", "enforceDnsDnat", "enabled"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    ipv4: { type: "string", pattern: IPV4_PATTERN },
    interfaceName: { type: "string" },
    gatewayIpv4: { type: "string" },
    routingTableId: { type: "integer", minimum: 200, maximum: 219 },
    dnsPrimary: { type: "string", pattern: IPV4_PATTERN },
    dnsSecondary: { type: "string" },
    amneziaDnsDnat: { type: "boolean" },
    enforceDnsDnat: { type: "boolean" },
    enabled: { type: "boolean" },
  },
} as const;

export const desiredPeerSchema = {
  type: "object",
  required: ["tunnelIpv4", "exitIp", "amneziaDnsDnat", "enforceDnsDnat", "enabled"],
  additionalProperties: false,
  properties: {
    tunnelIpv4: { type: "string", pattern: IPV4_PATTERN },
    exitIp: { type: "string", pattern: IPV4_PATTERN },
    dnsPrimary: { type: "string" },
    amneziaDnsDnat: { type: "boolean" },
    enforceDnsDnat: { type: "boolean" },
    routingTableId: { type: "integer", minimum: 200, maximum: 219 },
    enabled: { type: "boolean" },
  },
} as const;

export const desiredEntryMarkSchema = {
  type: "object",
  required: ["entryIpv4"],
  additionalProperties: false,
  properties: {
    entryIpv4: { type: "string", pattern: IPV4_PATTERN },
    routingTableId: { type: "integer", minimum: 200, maximum: 219 },
  },
} as const;

export const desiredStateSchema = {
  type: "object",
  required: ["schemaVersion", "blockSmtp", "isolatePrivate", "exits", "peers"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", minimum: 1 },
    blockSmtp: { type: "boolean" },
    isolatePrivate: { type: "boolean" },
    exits: {
      type: "array",
      items: desiredExitSchema,
    },
    peers: {
      type: "array",
      items: desiredPeerSchema,
    },
    entryMarks: {
      type: "array",
      items: desiredEntryMarkSchema,
    },
  },
} as const;

export const hostNetworkReportSchema = {
  type: "object",
  required: [
    "daemonVersion",
    "observedMode",
    "egressState",
    "bridgeName",
    "bridgePresent",
    "tunnelSubnetConflict",
    "ipv4Addresses",
    "exits",
    "observedAt",
  ],
  properties: {
    daemonVersion: { type: "string" },
    observedMode: { type: "string", enum: ["masquerade", "routed"] },
    egressState: {
      type: "string",
      enum: ["masquerade_ready", "routed_active", "conflict", "degraded"],
    },
    detail: { type: "string" },
    bridgeName: { type: "string" },
    bridgePresent: { type: "boolean" },
    awg3ContainerIpv4: { type: "string" },
    tunnelSubnetConflict: { type: "boolean" },
    ipv4Addresses: {
      type: "array",
      items: {
        type: "object",
        required: ["ipv4", "cidr", "interfaceName"],
        properties: {
          ipv4: { type: "string" },
          cidr: { type: "string" },
          interfaceName: { type: "string" },
          detectedGatewayIpv4: { type: "string" },
          detectedRuleTable: { type: "integer" },
        },
      },
    },
    exits: {
      type: "array",
      items: {
        type: "object",
        required: ["ipv4", "hostState", "txBytes", "txPackets"],
        properties: {
          ipv4: { type: "string" },
          hostState: {
            type: "string",
            enum: ["active", "pending", "missing_ip", "gateway_error", "disabled"],
          },
          detail: { type: "string" },
          observedSubnetCidr: { type: "string" },
          detectedGatewayIpv4: { type: "string" },
          txBytes: { type: "number" },
          txPackets: { type: "number" },
        },
      },
    },
    observedAt: { type: "string" },
  },
} as const;

export const putServerEgressSchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Apply host egress desired state to amnezia-egressd",
  description:
    "Persists exit, peer, and entry-mark mappings in amnezia-egressd and " +
    "applies kernel rules when running in routed mode. Never switches egress mode.",
  body: desiredStateSchema,
  response: {
    200: {
      type: "object",
      required: ["ok", "report"],
      properties: {
        ok: { type: "boolean" },
        warnings: { type: "array", items: { type: "string" } },
        report: hostNetworkReportSchema,
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    503: SwaggerContract.ServerErrorResponseFactory(503),
  },
} as const satisfies AppFastifySchema;

export type PutServerEgressType = typeof putServerEgressSchema;

export const postServerEgressVerifySchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Verify source-bound HTTP egress IP and DNS resolution for an Exit IP",
  body: {
    type: "object",
    required: ["egressIpv4", "probeUrl"],
    additionalProperties: false,
    properties: {
      egressIpv4: { type: "string", pattern: IPV4_PATTERN },
      probeUrl: { type: "string", minLength: 1 },
      dnsServer: { type: "string" },
      dnsDomain: { type: "string" },
      timeoutMs: { type: "integer", minimum: 500, maximum: 30000 },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["ok", "egressIpv4", "ipMatch", "httpLatencyMs", "dnsOk", "dnsLatencyMs"],
      properties: {
        ok: { type: "boolean" },
        egressIpv4: { type: "string" },
        observedIp: { type: "string" },
        ipMatch: { type: "boolean" },
        httpLatencyMs: { type: "number" },
        httpError: { type: "string" },
        dnsOk: { type: "boolean" },
        dnsServer: { type: "string" },
        dnsLatencyMs: { type: "number" },
        dnsError: { type: "string" },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    503: SwaggerContract.ServerErrorResponseFactory(503),
  },
} as const satisfies AppFastifySchema;

export type PostServerEgressVerifyType = typeof postServerEgressVerifySchema;

export const postServerEgressModeSchema = {
  tags: [SwaggerContract.Tags.SERVER],
  summary: "Atomically switch AWG3 egress mode between masquerade and routed",
  body: {
    type: "object",
    required: ["mode"],
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["masquerade", "routed"] },
    },
  },
  response: {
    200: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        report: hostNetworkReportSchema,
        error: { type: "string" },
      },
    },
    400: SwaggerContract.ClientErrorResponseFactory(400),
    401: SwaggerContract.ClientErrorResponseFactory(401),
    403: SwaggerContract.ClientErrorResponseFactory(403),
    409: SwaggerContract.ClientErrorResponseFactory(409),
    503: SwaggerContract.ServerErrorResponseFactory(503),
  },
} as const satisfies AppFastifySchema;

export type PostServerEgressModeType = typeof postServerEgressModeSchema;
