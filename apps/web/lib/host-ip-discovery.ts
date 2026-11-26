import type { AdminNodeEndpoint, DetectedHostIpv4 } from "@amnezia/contracts";
import type { AdminNode } from "@/components/admin/admin-data";

export type HostIpRole = "both" | "entry" | "exit" | "unassigned";

export type ClassifiedHostIpv4 = DetectedHostIpv4 & {
  usedAsEntry: boolean;
  usedAsExit: boolean;
  role: HostIpRole;
  existingExitId: string | null;
};

type ClassifyHostInput = Pick<
  AdminNode,
  "hostNetworkReport" | "publicEndpoints" | "egressIps"
>;

/**
 * Classify every IPv4 address reported on a node's host interfaces against
 * the node's configured Entry endpoints and physical Exit IPs.
 */
export function classifyHostIpv4s(
  node: ClassifyHostInput,
): ClassifiedHostIpv4[] {
  const discovered = node.hostNetworkReport?.ipv4Addresses ?? [];
  if (discovered.length === 0) return [];

  const entrySet = new Set(
    (node.publicEndpoints ?? []).map((ep) => ep.publicAddress),
  );
  const exitByIpv4 = new Map(
    (node.egressIps ?? []).map((exit) => [exit.ipv4, exit.id]),
  );

  return discovered.map((addr) => {
    const usedAsEntry = entrySet.has(addr.ipv4);
    const existingExitId = exitByIpv4.get(addr.ipv4) ?? null;
    const usedAsExit = existingExitId !== null;
    const role: HostIpRole =
      usedAsEntry && usedAsExit
        ? "both"
        : usedAsEntry
          ? "entry"
          : usedAsExit
            ? "exit"
            : "unassigned";

    return {
      ...addr,
      usedAsEntry,
      usedAsExit,
      role,
      existingExitId,
    };
  });
}

type VariantsUsingExitInput = Pick<
  AdminNode,
  "publicEndpoints" | "egressDefaultIpId"
>;

/**
 * Return all endpoint variants on a node that currently route through `exitId`
 * (either explicitly via `ep.egressIpId` or implicitly via `egressDefaultIpId`).
 */
export function variantsUsingExit(
  node: VariantsUsingExitInput,
  exitId: string,
): AdminNodeEndpoint[] {
  if (!exitId) return [];
  const defaultExitId = node.egressDefaultIpId ?? null;
  return (node.publicEndpoints ?? []).filter(
    (ep) => (ep.egressIpId ?? defaultExitId) === exitId,
  );
}
