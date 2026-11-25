import { z } from "zod";
import { publicIpv4Schema } from "./bridges.js";

/**
 * Level B multi-exit routing and per-Entry-IP variant contracts.
 *
 * Browser-safe (pure TypeScript + Zod, zero Node built-ins) so `apps/web`
 * can consume all schemas and helpers directly.
 */

export const NODE_SYNC_EGRESS_JOB_TYPE = "node.sync-egress";
export const NODE_SWITCH_EGRESS_MODE_JOB_TYPE = "node.switch-egress-mode";

export const nodeEgressModeSchema = z.enum(["masquerade", "routed"]);
export type NodeEgressMode = z.infer<typeof nodeEgressModeSchema>;

export const nodeEgressModeStateSchema = z.enum(["idle", "switching", "failed"]);
export type NodeEgressModeState = z.infer<typeof nodeEgressModeStateSchema>;

export const nodeEgressDaemonStateSchema = z.enum([
  "unavailable",
  "masquerade_ready",
  "routed_active",
  "conflict",
  "degraded",
]);
export type NodeEgressDaemonState = z.infer<typeof nodeEgressDaemonStateSchema>;

export const nodeEgressIpHostStateSchema = z.enum([
  "active",
  "pending",
  "missing_ip",
  "gateway_error",
  "daemon_offline",
  "disabled",
]);
export type NodeEgressIpHostState = z.infer<typeof nodeEgressIpHostStateSchema>;

export const detectedHostIpv4Schema = z.object({
  ipv4: z.ipv4(),
  cidr: z.string(),
  interfaceName: z.string(),
  detectedGatewayIpv4: z.ipv4().optional(),
  detectedRuleTable: z.int().optional(),
});
export type DetectedHostIpv4 = z.infer<typeof detectedHostIpv4Schema>;

export const hostExitStatusSchema = z.object({
  ipv4: z.ipv4(),
  hostState: z.enum(["active", "pending", "missing_ip", "gateway_error", "disabled"]),
  detail: z.string().optional(),
  observedSubnetCidr: z.string().optional(),
  detectedGatewayIpv4: z.ipv4().optional(),
  txBytes: z.number(),
  txPackets: z.number(),
});
export type HostExitStatus = z.infer<typeof hostExitStatusSchema>;

export const hostNetworkReportSchema = z.object({
  daemonVersion: z.string(),
  observedMode: nodeEgressModeSchema,
  egressState: z.enum(["masquerade_ready", "routed_active", "conflict", "degraded"]),
  detail: z.string().optional(),
  bridgeName: z.string(),
  bridgePresent: z.boolean(),
  awg3ContainerIpv4: z.string().optional(),
  tunnelSubnetConflict: z.boolean(),
  ipv4Addresses: z.array(detectedHostIpv4Schema),
  exits: z.array(hostExitStatusSchema),
  observedAt: z.string(),
});
export type HostNetworkReport = z.infer<typeof hostNetworkReportSchema>;

export const nodeEgressIpSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  ipv4: z.ipv4(),
  label: z.string().max(80).nullable(),
  interfaceName: z.string().max(32).nullable(),
  gatewayIpv4: z.ipv4().nullable(),
  routingTableId: z.int().min(200).max(219).nullable(),
  dnsPrimary: z.ipv4(),
  dnsSecondary: z.ipv4().nullable(),
  amneziaDnsDnat: z.boolean(),
  enforceDnsDnat: z.boolean(),
  allowAsEntry: z.boolean(),
  enabled: z.boolean(),
  hostState: nodeEgressIpHostStateSchema,
  hostDetail: z.string().nullable(),
  observedSubnetCidr: z.string().nullable(),
  detectedGatewayIpv4: z.ipv4().nullable(),
  txBytes: z.string(),
  txPackets: z.string(),
  hostObservedAt: z.iso.datetime().nullable(),
  subnetWarning: z.string().nullable().optional(),
  assignedEndpointCount: z.int().nonnegative().optional(),
});
export type NodeEgressIp = z.infer<typeof nodeEgressIpSchema>;

export const createNodeEgressIpRequestSchema = z.object({
  ipv4: publicIpv4Schema,
  label: z.string().trim().min(1).max(80).nullish(),
  interfaceName: z.string().trim().min(1).max(32).nullish(),
  gatewayIpv4: z.ipv4().nullish(),
  routingTableId: z.int().min(200).max(219).nullish(),
  dnsPrimary: z.ipv4().default("1.1.1.1"),
  dnsSecondary: z.ipv4().nullish(),
  amneziaDnsDnat: z.boolean().default(true),
  enforceDnsDnat: z.boolean().default(false),
  allowAsEntry: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type CreateNodeEgressIpRequest = z.infer<typeof createNodeEgressIpRequestSchema>;

export const updateNodeEgressIpRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(80).nullish(),
    interfaceName: z.string().trim().min(1).max(32).nullish(),
    gatewayIpv4: z.ipv4().nullish(),
    routingTableId: z.int().min(200).max(219).nullish(),
    dnsPrimary: z.ipv4().optional(),
    dnsSecondary: z.ipv4().nullish(),
    amneziaDnsDnat: z.boolean().optional(),
    enforceDnsDnat: z.boolean().optional(),
    allowAsEntry: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one egress field is required",
  });
export type UpdateNodeEgressIpRequest = z.infer<typeof updateNodeEgressIpRequestSchema>;

export const swapNodeEgressIpRequestSchema = z.object({
  ipv4: publicIpv4Schema,
  interfaceName: z.string().trim().min(1).max(32).nullish(),
  gatewayIpv4: z.ipv4().nullish(),
  label: z.string().trim().min(1).max(80).nullish(),
});
export type SwapNodeEgressIpRequest = z.infer<typeof swapNodeEgressIpRequestSchema>;

export const updateNodeEgressModeRequestSchema = z.object({
  mode: nodeEgressModeSchema,
  blockSmtp: z.boolean().optional(),
  isolatePrivate: z.boolean().optional(),
});
export type UpdateNodeEgressModeRequest = z.infer<typeof updateNodeEgressModeRequestSchema>;

export const verifyNodeEgressIpRequestSchema = z
  .object({
    probeUrl: z.url({ protocol: /^https?$/ }).optional(),
    dnsDomain: z.string().trim().min(1).max(253).optional(),
    timeoutMs: z.int().min(500).max(30_000).optional(),
  })
  .default({});
export type VerifyNodeEgressIpRequest = z.infer<typeof verifyNodeEgressIpRequestSchema>;

export const verifyNodeEgressIpResultSchema = z.object({
  ok: z.boolean(),
  egressIpv4: z.string(),
  observedIp: z.string().optional(),
  ipMatch: z.boolean(),
  httpLatencyMs: z.number(),
  httpError: z.string().optional(),
  dnsOk: z.boolean(),
  dnsServer: z.string().optional(),
  dnsLatencyMs: z.number(),
  dnsError: z.string().optional(),
});
export type VerifyNodeEgressIpResult = z.infer<typeof verifyNodeEgressIpResultSchema>;

export const adminReassignKeyEndpointRequestSchema = z.object({
  endpointId: z.uuid(),
});
export type AdminReassignKeyEndpointRequest = z.infer<
  typeof adminReassignKeyEndpointRequestSchema
>;

export const keyEgressInfoSchema = z.object({
  effectiveExitIp: z.string().nullable(),
  exitLabel: z.string().nullable(),
  dnsPrimary: z.string(),
  dnsSecondary: z.string().nullable(),
  mode: nodeEgressModeSchema,
});
export type KeyEgressInfo = z.infer<typeof keyEgressInfoSchema>;

/**
 * Deterministic display name for an endpoint variant grouped by `(nodeId, address)`.
 *
 * - An explicit `customName` always wins.
 * - A solo variant (`siblingCount <= 1`) uses `entryName` without a `v1` suffix.
 * - Multiple variants on the same Entry IP append `" v<variantOrdinal>"`.
 */
export const computeEndpointDisplayName = (input: {
  entryName: string;
  customName?: string | null;
  variantOrdinal: number;
  siblingCount: number;
}): string => {
  const custom = (input.customName ?? "").trim();
  if (custom) {
    return custom.slice(0, 120).toWellFormed();
  }
  const base = input.entryName.trim() || "Server";
  if (input.siblingCount <= 1) {
    return base.slice(0, 120).toWellFormed();
  }
  const suffix = ` v${Math.max(1, input.variantOrdinal)}`;
  return `${base.slice(0, 120 - suffix.length).toWellFormed()}${suffix}`;
};

const STRICT_IPV4_RE = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

const parseIpv4ToUint32 = (raw: string): number | null => {
  if (!STRICT_IPV4_RE.test(raw)) return null;
  const parts = raw.split(".").map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return null;
  return (
    ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  );
};

const parseIpv4Cidr = (
  raw: string,
): { network: number; mask: number; prefix: number; normalized: string } | null => {
  const slash = raw.indexOf("/");
  if (slash === -1) return null;
  const ipStr = raw.slice(0, slash);
  const prefixStr = raw.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 32) return null;
  const ip = parseIpv4ToUint32(ipStr);
  if (ip === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const normalized = `${(network >>> 24) & 255}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${prefix}`;
  return { network, mask, prefix, normalized };
};

/**
 * Warn (non-blocking) when an Exit IP shares the same L2 broadcast subnet
 * (real CIDR overlap when observed, or `/24` proximity fallback) with an active
 * Entry IP on the same node, unless `allowAsEntry` is explicitly enabled.
 */
export const detectExitSubnetProximityWarning = (input: {
  exitIpv4: string;
  observedSubnetCidr?: string | null;
  entryAddresses: readonly string[];
  allowAsEntry?: boolean;
}): string | null => {
  if (input.allowAsEntry) return null;
  const exitInt = parseIpv4ToUint32(input.exitIpv4);
  if (exitInt === null) return null;

  const parsedCidr = input.observedSubnetCidr
    ? parseIpv4Cidr(input.observedSubnetCidr)
    : null;
  const mask24 = (0xffffffff << 8) >>> 0;
  const exit24 = (exitInt & mask24) >>> 0;

  for (const entry of input.entryAddresses) {
    if (entry === input.exitIpv4) continue;
    const entryInt = parseIpv4ToUint32(entry);
    if (entryInt === null) continue;

    if (parsedCidr && parsedCidr.prefix > 0 && parsedCidr.prefix < 32) {
      if (((entryInt & parsedCidr.mask) >>> 0) === parsedCidr.network) {
        return `Exit IP shares subnet ${parsedCidr.normalized} with Entry IP ${entry}`;
      }
    }

    if (((entryInt & mask24) >>> 0) === exit24) {
      return `Exit IP is in the same /24 subnet as Entry IP ${entry}`;
    }
  }
  return null;
};
