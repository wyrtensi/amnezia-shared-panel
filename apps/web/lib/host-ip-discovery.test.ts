import { describe, expect, it } from "vitest";
import type { AdminNode } from "@/components/admin/admin-data";
import { classifyHostIpv4s, variantsUsingExit } from "./host-ip-discovery";

const makeNode = (over: Partial<AdminNode> = {}): AdminNode => ({
  id: "node-1",
  name: "NL-1",
  apiBaseUrl: "http://127.0.0.1:4001",
  enabled: true,
  protocol: "awg3",
  maxPeers: 100,
  capabilities: {},
  publicHost: null,
  publicIp: "192.0.2.10",
  publicIpResolvedAt: null,
  lastHealthAt: null,
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
  egressDefaultIpId: "exit-1",
  hostNetworkReport: {
    daemonVersion: "1.0.0",
    observedMode: "routed",
    egressState: "routed_active",
    bridgeName: "br-awg-egress",
    bridgePresent: true,
    tunnelSubnetConflict: false,
    ipv4Addresses: [
      {
        ipv4: "192.0.2.10",
        cidr: "192.0.2.10/24",
        interfaceName: "eth0",
        detectedGatewayIpv4: "192.0.2.1",
      },
      {
        ipv4: "198.51.100.20",
        cidr: "198.51.100.20/24",
        interfaceName: "eth0",
        detectedGatewayIpv4: "198.51.100.1",
        detectedRuleTable: 200,
      },
      {
        ipv4: "203.0.113.30",
        cidr: "203.0.113.30/24",
        interfaceName: "eth1",
        detectedGatewayIpv4: "203.0.113.1",
        detectedRuleTable: 201,
      },
      {
        ipv4: "203.0.113.40",
        cidr: "203.0.113.40/24",
        interfaceName: "eth1",
      },
    ],
    exits: [],
    observedAt: "2026-11-25T10:00:00.000Z",
  },
  egressIps: [
    {
      id: "exit-1",
      nodeId: "node-1",
      ipv4: "198.51.100.20",
      label: "Clean",
      interfaceName: "eth0",
      gatewayIpv4: null,
      routingTableId: 200,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: "1.0.0.1",
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      allowAsEntry: false,
      enabled: true,
      hostState: "active",
      hostDetail: null,
      observedSubnetCidr: "198.51.100.0/24",
      detectedGatewayIpv4: "198.51.100.1",
      txBytes: "0",
      txPackets: "0",
      hostObservedAt: null,
    },
    {
      id: "exit-2",
      nodeId: "node-1",
      ipv4: "203.0.113.30",
      label: "Dual",
      interfaceName: "eth1",
      gatewayIpv4: null,
      routingTableId: 201,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: null,
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      allowAsEntry: true,
      enabled: true,
      hostState: "active",
      hostDetail: null,
      observedSubnetCidr: "203.0.113.0/24",
      detectedGatewayIpv4: "203.0.113.1",
      txBytes: "0",
      txPackets: "0",
      hostObservedAt: null,
    },
  ],
  publicEndpoints: [
    {
      id: "ep-1",
      ordinal: 1,
      name: "NL v1",
      entryName: "NL",
      customName: null,
      variantOrdinal: 1,
      egressIpId: null,
      effectiveEgressIp: "198.51.100.20",
      publicAddress: "192.0.2.10",
      enabled: true,
      probeStatus: "ok",
      probeDetail: null,
      probeCheckedAt: null,
      reachability: { state: "ok", since: null },
    },
    {
      id: "ep-2",
      ordinal: 2,
      name: "NL Dual",
      entryName: "NL",
      customName: "NL Dual",
      variantOrdinal: 2,
      egressIpId: "exit-2",
      effectiveEgressIp: "203.0.113.30",
      publicAddress: "203.0.113.30",
      enabled: true,
      probeStatus: "ok",
      probeDetail: null,
      probeCheckedAt: null,
      reachability: { state: "ok", since: null },
    },
  ],
  ...over,
});

describe("classifyHostIpv4s", () => {
  it("classifies host IPv4s into entry, exit, both, and unassigned roles", () => {
    const classified = classifyHostIpv4s(makeNode());
    expect(classified).toEqual([
      {
        ipv4: "192.0.2.10",
        cidr: "192.0.2.10/24",
        interfaceName: "eth0",
        detectedGatewayIpv4: "192.0.2.1",
        usedAsEntry: true,
        usedAsExit: false,
        role: "entry",
        existingExitId: null,
      },
      {
        ipv4: "198.51.100.20",
        cidr: "198.51.100.20/24",
        interfaceName: "eth0",
        detectedGatewayIpv4: "198.51.100.1",
        detectedRuleTable: 200,
        usedAsEntry: false,
        usedAsExit: true,
        role: "exit",
        existingExitId: "exit-1",
      },
      {
        ipv4: "203.0.113.30",
        cidr: "203.0.113.30/24",
        interfaceName: "eth1",
        detectedGatewayIpv4: "203.0.113.1",
        detectedRuleTable: 201,
        usedAsEntry: true,
        usedAsExit: true,
        role: "both",
        existingExitId: "exit-2",
      },
      {
        ipv4: "203.0.113.40",
        cidr: "203.0.113.40/24",
        interfaceName: "eth1",
        usedAsEntry: false,
        usedAsExit: false,
        role: "unassigned",
        existingExitId: null,
      },
    ]);
  });

  it("returns an empty array when hostNetworkReport is absent", () => {
    expect(classifyHostIpv4s(makeNode({ hostNetworkReport: null }))).toEqual([]);
  });
});

describe("variantsUsingExit", () => {
  it("matches both explicitly assigned variants and variants falling back to default exit", () => {
    const node = makeNode();
    expect(variantsUsingExit(node, "exit-1").map((v) => v.id)).toEqual(["ep-1"]);
    expect(variantsUsingExit(node, "exit-2").map((v) => v.id)).toEqual(["ep-2"]);
    expect(variantsUsingExit(node, "exit-missing")).toEqual([]);
    expect(variantsUsingExit(node, "")).toEqual([]);
  });

  it("excludes fallback variants when egressDefaultIpId is null", () => {
    const node = makeNode({ egressDefaultIpId: null });
    expect(variantsUsingExit(node, "exit-1")).toEqual([]);
    expect(variantsUsingExit(node, "exit-2").map((v) => v.id)).toEqual(["ep-2"]);
  });
});
