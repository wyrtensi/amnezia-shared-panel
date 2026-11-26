import type {
  AdminNodeEndpoint,
  HostNetworkReport,
  NodeEgressIp,
} from "@amnezia/contracts";

export type HostIpRole = "both" | "entry" | "exit" | "unassigned";

export type ClassifiedHostIp = {
  ipv4: string;
  cidr: string;
  interfaceName: string;
  detectedGatewayIpv4: string | null;
  detectedRuleTable: number | null;
  registeredAsEntry: boolean;
  registeredAsExit: boolean;
  existingExitId: string | null;
  role: HostIpRole;
};

export type NodeHostIpSource = {
  hostNetworkReport?: Pick<HostNetworkReport, "ipv4Addresses"> | null;
  publicEndpoints?: ReadonlyArray<Pick<AdminNodeEndpoint, "publicAddress">> | null;
  egressIps?: ReadonlyArray<Pick<NodeEgressIp, "id" | "ipv4">> | null;
};

const isPublicHostIpv4 = (ip: string): boolean => {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (o.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
};

/**
 * Classify every public host IPv4 reported by the node-agent against the node's
 * registered Entry endpoints (`publicEndpoints`) and Exit IPs (`egressIps`).
 */
export function classifyNodeHostIps(node: NodeHostIpSource): ClassifiedHostIp[] {
  const entryAddresses = new Set(
    (node.publicEndpoints ?? []).map((ep) => ep.publicAddress),
  );
  const exitByIpv4 = new Map(
    (node.egressIps ?? []).map((ip) => [ip.ipv4, ip.id]),
  );

  return (node.hostNetworkReport?.ipv4Addresses ?? [])
    .filter((addr) => isPublicHostIpv4(addr.ipv4))
    .map((addr) => {
    const registeredAsEntry = entryAddresses.has(addr.ipv4);
    const existingExitId = exitByIpv4.get(addr.ipv4) ?? null;
    const registeredAsExit = existingExitId !== null;
    const role: HostIpRole =
      registeredAsEntry && registeredAsExit
        ? "both"
        : registeredAsEntry
          ? "entry"
          : registeredAsExit
            ? "exit"
            : "unassigned";

    return {
      ipv4: addr.ipv4,
      cidr: addr.cidr,
      interfaceName: addr.interfaceName,
      detectedGatewayIpv4: addr.detectedGatewayIpv4 ?? null,
      detectedRuleTable: addr.detectedRuleTable ?? null,
      registeredAsEntry,
      registeredAsExit,
      existingExitId,
      role,
    };
  });
}
