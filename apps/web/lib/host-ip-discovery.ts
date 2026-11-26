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
 * Classify every public IPv4 address reported on a node's host interfaces against
 * the node's configured Entry endpoints and physical Exit IPs.
 */
export function classifyHostIpv4s(
  node: ClassifyHostInput,
): ClassifiedHostIpv4[] {
  const discovered = (node.hostNetworkReport?.ipv4Addresses ?? []).filter(
    (addr) => isPublicHostIpv4(addr.ipv4),
  );
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
