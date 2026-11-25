import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminNode } from "@/components/admin/admin-data";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NodeTopologyDialog, summarizeNodeEgress } from "./node-topology-dialog";

const makeNode = (over: Partial<AdminNode> = {}): AdminNode => ({
  id: "n-1",
  name: "Amsterdam-1",
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
  egressMode: "routed",
  egressModeState: "idle",
  egressDaemonState: "routed_active",
  egressDaemonVersion: "1.0.0",
  egressBlockSmtp: true,
  egressIsolatePrivate: true,
  egressDefaultIpId: "ip-1",
  modeDrift: false,
  hostNetworkReport: {
    daemonVersion: "1.0.0",
    observedMode: "routed",
    egressState: "routed_active",
    bridgeName: "br-awg-egress",
    bridgePresent: true,
    tunnelSubnetConflict: false,
    ipv4Addresses: [
      {
        ipv4: "198.51.100.55",
        cidr: "198.51.100.55/24",
        interfaceName: "eth0",
        detectedGatewayIpv4: "198.51.100.1",
      },
    ],
    exits: [],
    observedAt: "2026-11-25T10:00:00.000Z",
  },
  egressIps: [
    {
      id: "ip-1",
      nodeId: "n-1",
      ipv4: "198.51.100.20",
      label: "NL-Exit-1",
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
      txBytes: "2048",
      txPackets: "10",
      hostObservedAt: "2026-11-25T10:00:00.000Z",
    },
  ],
  publicEndpoints: [
    {
      id: "ep-1",
      ordinal: 1,
      name: "Amsterdam",
      entryName: "Amsterdam",
      customName: null,
      variantOrdinal: 1,
      egressIpId: "ip-1",
      effectiveEgressIp: "198.51.100.20",
      publicAddress: "192.0.2.10",
      enabled: true,
      reachabilityEnabled: true,
      probeStatus: "ok",
      probeLevels: null,
      probeCheckedAt: null,
      probeFailingSince: null,
      probeConsecutiveFailures: 0,
      incidentOpen: false,
      probeDetail: null,
      reachability: { state: "ok", since: null },
    },
  ],
  ...over,
});

describe("summarizeNodeEgress & NodeTopologyDialog", () => {
  it("computes healthy and degraded egress summaries accurately", () => {
    expect(summarizeNodeEgress(makeNode())).toMatchObject({
      mode: "routed",
      activeExitCount: 1,
      totalExitCount: 1,
      hasIssue: false,
    });
    expect(
      summarizeNodeEgress(makeNode({ modeDrift: true })),
    ).toMatchObject({ modeDrift: true, hasIssue: true });
  });

  it("renders closed markup as empty when node is null", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeTopologyDialog
          node={null}
          onClose={() => undefined}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
          onSavePublicEndpoint={() => Promise.resolve()}
        />
      </TooltipProvider>,
    );
    expect(html).toBe("");
  });
});
