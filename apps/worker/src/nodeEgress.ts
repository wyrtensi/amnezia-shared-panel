import { isIPv4 } from "node:net";
import type {
  HostNetworkReport,
  NodeEgressDaemonState,
  NodeEgressIpHostState,
  NodeEgressMode,
} from "@amnezia/contracts";
import type {
  NodeEgressDesiredEntryMark,
  NodeEgressDesiredExit,
  NodeEgressDesiredPeer,
  NodeEgressDesiredState,
} from "./nodeAgent.js";

export type EgressSyncNodeInput = {
  id: string;
  publicIp: string | null;
  egressBlockSmtp: boolean;
  egressIsolatePrivate: boolean;
  egressDefaultIpId: string | null;
};

export type EgressSyncExitInput = {
  id: string;
  ipv4: string;
  interfaceName: string | null;
  gatewayIpv4: string | null;
  routingTableId: number | null;
  dnsPrimary: string;
  dnsSecondary: string | null;
  amneziaDnsDnat: boolean;
  enforceDnsDnat: boolean;
  enabled: boolean;
};

export type EgressSyncEndpointInput = {
  id: string;
  ordinal: number;
  address: string;
  egressIpId: string | null;
  enabled: boolean;
};

export type EgressSyncKeyInput = {
  keyId: string;
  state: "active" | "disabled" | "provisioning" | "revoking" | "revoked" | "failed";
  protocol: "awg2" | "awg3";
  endpointId: string | null;
  tunnelIpv4: string | null;
};

export type BuildNodeEgressStateInput = {
  node: EgressSyncNodeInput;
  exits: readonly EgressSyncExitInput[];
  endpoints: readonly EgressSyncEndpointInput[];
  keys: readonly EgressSyncKeyInput[];
};

/**
 * Extract the peer's client tunnel IPv4 from its `allowedIps` entries
 * (preferring an explicit `/32` host CIDR, ignoring IPv6 and catch-all CIDRs).
 */
export const extractPeerIpv4 = (allowedIps: readonly string[]): string | null => {
  for (const cidr of allowedIps) {
    if (!cidr.endsWith("/32")) continue;
    const candidate = cidr.slice(0, -3).trim();
    if (isIPv4(candidate)) return candidate;
  }
  return null;
};

/**
 * Build the deterministic desired host egress state sent to `node-agent` `PUT /server/egress`.
 */
export const buildNodeEgressDesiredState = ({
  node,
  exits,
  endpoints,
  keys,
}: BuildNodeEgressStateInput): NodeEgressDesiredState => {
  const exitsById = new Map(exits.map((exit) => [exit.id, exit]));
  const endpointsById = new Map(endpoints.map((ep) => [ep.id, ep]));
  const primaryEndpoint = endpoints.find((ep) => ep.ordinal === 1);
  const defaultExit = node.egressDefaultIpId
    ? (exitsById.get(node.egressDefaultIpId) ?? null)
    : null;

  const desiredExits: NodeEgressDesiredExit[] = exits.map((exit) => ({
    id: exit.id,
    ipv4: exit.ipv4,
    ...(exit.interfaceName ? { interfaceName: exit.interfaceName } : {}),
    ...(exit.gatewayIpv4 ? { gatewayIpv4: exit.gatewayIpv4 } : {}),
    ...(exit.routingTableId !== null ? { routingTableId: exit.routingTableId } : {}),
    dnsPrimary: exit.dnsPrimary,
    ...(exit.dnsSecondary ? { dnsSecondary: exit.dnsSecondary } : {}),
    amneziaDnsDnat: exit.amneziaDnsDnat,
    enforceDnsDnat: exit.enforceDnsDnat,
    enabled: exit.enabled,
  }));
  const desiredExitsByIp = new Map<string, NodeEgressDesiredExit>(
    desiredExits.map((exit) => [exit.ipv4, exit]),
  );
  const synthesizedImplicitExits: NodeEgressDesiredExit[] = [];
  const ensureImplicitExit = (ipv4: string): NodeEgressDesiredExit => {
    const existing = desiredExitsByIp.get(ipv4);
    if (existing) return existing;
    const implicit: NodeEgressDesiredExit = {
      id: `implicit:${ipv4}`,
      ipv4,
      dnsPrimary: "1.1.1.1",
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      enabled: true,
    };
    desiredExitsByIp.set(ipv4, implicit);
    synthesizedImplicitExits.push(implicit);
    return implicit;
  };

  for (const endpoint of endpoints) {
    if (!endpoint.enabled || !isIPv4(endpoint.address)) continue;
    const exit =
      (endpoint.egressIpId ? exitsById.get(endpoint.egressIpId) : undefined) ??
      defaultExit ??
      null;
    if (!exit) {
      ensureImplicitExit(endpoint.address);
    }
  }

  const peersByTunnel = new Map<string, NodeEgressDesiredPeer>();
  for (const key of keys) {
    if (key.protocol !== "awg3") continue;
    if (key.state !== "active" && key.state !== "disabled") continue;
    if (!key.tunnelIpv4 || !isIPv4(key.tunnelIpv4)) continue;

    const endpoint = key.endpointId
      ? endpointsById.get(key.endpointId)
      : primaryEndpoint;
    const exit =
      (endpoint?.egressIpId ? exitsById.get(endpoint.egressIpId) : undefined) ??
      defaultExit ??
      null;

    const endpointEnabled = endpoint ? endpoint.enabled : true;
    if (exit) {
      peersByTunnel.set(key.tunnelIpv4, {
        tunnelIpv4: key.tunnelIpv4,
        exitIp: exit.ipv4,
        dnsPrimary: exit.dnsPrimary,
        amneziaDnsDnat: exit.amneziaDnsDnat,
        enforceDnsDnat: exit.enforceDnsDnat,
        ...(exit.routingTableId !== null ? { routingTableId: exit.routingTableId } : {}),
        enabled: key.state === "active" && endpointEnabled && exit.enabled,
      });
    } else {
      const implicitExitIp =
        (endpoint?.address && isIPv4(endpoint.address) ? endpoint.address : null) ??
        (node.publicIp && isIPv4(node.publicIp) ? node.publicIp : null);
      if (!implicitExitIp) continue;
      const implicitExit = ensureImplicitExit(implicitExitIp);
      peersByTunnel.set(key.tunnelIpv4, {
        tunnelIpv4: key.tunnelIpv4,
        exitIp: implicitExit.ipv4,
        dnsPrimary: implicitExit.dnsPrimary,
        amneziaDnsDnat: implicitExit.amneziaDnsDnat,
        enforceDnsDnat: implicitExit.enforceDnsDnat,
        ...(implicitExit.routingTableId !== undefined
          ? { routingTableId: implicitExit.routingTableId }
          : {}),
        enabled: key.state === "active" && endpointEnabled && implicitExit.enabled,
      });
    }
  }

  const exitsByIp = new Map(exits.map((exit) => [exit.ipv4, exit]));
  const entryMarkByIp = new Map<string, NodeEgressDesiredEntryMark>();
  for (const endpoint of endpoints) {
    if (!endpoint.enabled || !isIPv4(endpoint.address)) continue;
    if (entryMarkByIp.has(endpoint.address)) continue;
    const assignedExit = endpoint.egressIpId ? exitsById.get(endpoint.egressIpId) : undefined;
    const matchingExit =
      assignedExit && assignedExit.ipv4 === endpoint.address
        ? assignedExit
        : exitsByIp.get(endpoint.address);
    const routingTableId =
      matchingExit && matchingExit.enabled && matchingExit.routingTableId !== null
        ? matchingExit.routingTableId
        : undefined;
    entryMarkByIp.set(endpoint.address, {
      entryIpv4: endpoint.address,
      ...(routingTableId !== undefined ? { routingTableId } : {}),
    });
  }

  const allDesiredExits = [
    ...desiredExits,
    ...synthesizedImplicitExits.sort((a, b) => a.ipv4.localeCompare(b.ipv4)),
  ];
  const entryMarks = [...entryMarkByIp.values()].sort((a, b) =>
    a.entryIpv4.localeCompare(b.entryIpv4),
  );

  return {
    schemaVersion: 1,
    blockSmtp: node.egressBlockSmtp,
    isolatePrivate: node.egressIsolatePrivate,
    exits: allDesiredExits,
    peers: [...peersByTunnel.values()].sort((a, b) => a.tunnelIpv4.localeCompare(b.tunnelIpv4)),
    ...(entryMarks.length > 0 ? { entryMarks } : {}),
  };
};

export type EgressMirrorEvaluation = {
  modeDrift: boolean;
  daemonVersion: string;
  daemonState: NodeEgressDaemonState;
  daemonDetail: string | null;
  exitsByIpv4: Map<
    string,
    {
      hostState: NodeEgressIpHostState;
      hostDetail: string | null;
      observedSubnetCidr: string | null;
      detectedGatewayIpv4: string | null;
      txBytes: bigint;
      txPackets: bigint;
    }
  >;
};

export const evaluateEgressMirror = (
  dbMode: NodeEgressMode,
  report: HostNetworkReport,
): EgressMirrorEvaluation => {
  const modeDrift = report.observedMode !== dbMode;
  const daemonState: NodeEgressDaemonState = modeDrift ? "conflict" : report.egressState;
  const daemonDetail = modeDrift
    ? `Mode drift: host runs ${report.observedMode}, panel DB expects ${dbMode}`.slice(0, 300)
    : (report.detail?.slice(0, 300) ?? null);

  const exitsByIpv4 = new Map<
    string,
    {
      hostState: NodeEgressIpHostState;
      hostDetail: string | null;
      observedSubnetCidr: string | null;
      detectedGatewayIpv4: string | null;
      txBytes: bigint;
      txPackets: bigint;
    }
  >();
  for (const exit of report.exits) {
    exitsByIpv4.set(exit.ipv4, {
      hostState: exit.hostState,
      hostDetail: exit.detail?.slice(0, 300) ?? null,
      observedSubnetCidr: exit.observedSubnetCidr?.slice(0, 32) ?? null,
      detectedGatewayIpv4: exit.detectedGatewayIpv4 ?? null,
      txBytes: BigInt(Math.max(0, Math.trunc(exit.txBytes))),
      txPackets: BigInt(Math.max(0, Math.trunc(exit.txPackets))),
    });
  }

  return {
    modeDrift,
    daemonVersion: report.daemonVersion.slice(0, 64),
    daemonState,
    daemonDetail,
    exitsByIpv4,
  };
};

export const formatEgressModeDriftAlert = (
  nodeName: string,
  observedMode: NodeEgressMode,
  dbMode: NodeEgressMode,
): string =>
  `⚠️ ${nodeName}: расхождение режима egress (mode_drift) — на хосте активно ${observedMode}, в БД панели указано ${dbMode}. Проверьте ноду или выполните Adopt в панели / CLI.`;
