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

/**
 * Classify every host IPv4 reported by the node-agent against the node's
 * registered Entry endpoints (`publicEndpoints`) and Exit IPs (`egressIps`).
 */
export function classifyNodeHostIps(node: NodeHostIpSource): ClassifiedHostIp[] {
  const entryAddresses = new Set(
    (node.publicEndpoints ?? []).map((ep) => ep.publicAddress),
  );
  const exitByIpv4 = new Map(
    (node.egressIps ?? []).map((ip) => [ip.ipv4, ip.id]),
  );

  return (node.hostNetworkReport?.ipv4Addresses ?? []).map((addr) => {
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
