import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bridge } from "@amnezia/contracts";
import type { AdminNode } from "@/components/admin/admin-data";
import type { NodeRouteLabel } from "@/components/admin/use-bridge-infra";
import { messages } from "@/lib/i18n/messages";
import type { AdminReachabilityView, AdminServiceCheck } from "@/lib/types";
import {
  buildFleetTopologyGraph,
  computeHighlightedPath,
  FleetTopologyMap,
} from "./fleet-topology-map";

const baseNode = (over: Partial<AdminNode> = {}): AdminNode => ({
  id: "n-1",
  name: "de-01",
  apiBaseUrl: "http://127.0.0.1:4001",
  enabled: true,
  protocol: "awg3",
  maxPeers: 100,
  peerCount: 14,
  capabilities: {},
  publicHost: null,
  publicIp: "192.0.2.10",
  publicIpResolvedAt: null,
  lastHealthAt: null,
  lastSyncAt: null,
  lastError: null,
  egressMode: "routed",
  egressDaemonState: "routed_active",
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
  ...over,
});

const baseBridge = (over: Partial<Bridge> = {}): Bridge => ({
  id: "b-1",
  name: "Bridge MSK",
  publicIpv4: "203.0.113.5",
  controlTcpPort: 7000,
  udpPortStart: 30000,
  udpPortEnd: 30100,
  capacity: 101,
  heldPorts: 1,
  managementStatus: "ok",
  lastObservedAt: "2026-11-26T10:00:00.000Z",
  management: {
    apiUrl: "http://10.0.0.5:4100",
    enrolled: true,
    enrolledAt: "2026-11-25T00:00:00.000Z",
    agentVersion: "1.0.0",
    agentApiVersion: 1,
    agentCapabilities: null,
    frpsVersion: "0.61.0",
    frpsReachable: true,
    lastErrorCode: null,
    lastPollAttemptAt: "2026-11-26T10:00:00.000Z",
  },
  routes: [
    {
      id: "r-1",
      nodeId: "n-1",
      nodeName: "de-01",
      publicUdpPort: 30001,
      state: "active",
      registration: {
        status: "online",
        marker: "m1",
        observedAt: "2026-11-26T10:00:00.000Z",
      },
      verification: {
        kind: "awg_path",
        status: "ok",
        checkedAt: "2026-11-26T10:00:00.000Z",
      },
    },
  ],
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-26T10:00:00.000Z",
  ...over,
});

describe("buildFleetTopologyGraph", () => {
  it("builds 5-column topology with bridged & direct nodes, variants, exits, and health colors", () => {
    const bridge = baseBridge();
    const routedNode = baseNode({
      id: "n-1",
      name: "de-01",
      egressMode: "routed",
      egressDaemonState: "routed_active",
      egressDefaultIpId: "ex-1",
      egressIps: [
        {
          id: "ex-1",
          nodeId: "n-1",
          ipv4: "198.51.100.20",
          label: "DE Residential",
          interfaceName: "eth0",
          gatewayIpv4: "198.51.100.1",
          routingTableId: 200,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          allowAsEntry: false,
          enabled: true,
          hostState: "active",
          hostDetail: null,
          observedSubnetCidr: null,
          detectedGatewayIpv4: null,
          txBytes: "0",
          txPackets: "0",
          hostObservedAt: null,
        },
        {
          id: "ex-2",
          nodeId: "n-1",
          ipv4: "198.51.100.21",
          label: "DE Backup",
          interfaceName: "eth0",
          gatewayIpv4: "198.51.100.1",
          routingTableId: 201,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          allowAsEntry: false,
          enabled: true,
          hostState: "missing_ip",
          hostDetail: "missing on eth0",
          observedSubnetCidr: null,
          detectedGatewayIpv4: null,
          txBytes: "0",
          txPackets: "0",
          hostObservedAt: null,
        },
      ],
      publicEndpoints: [
        {
          id: "ep-1",
          ordinal: 1,
          name: "Entry DE",
          entryName: "Entry DE",
          variantOrdinal: 1,
          publicAddress: "198.51.100.10",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          probeConsecutiveFailures: 0,
          incidentOpen: false,
          egressIpId: "ex-1",
          effectiveEgressIp: "198.51.100.20",
        },
        {
          id: "ep-2",
          ordinal: 2,
          name: "Entry DE",
          entryName: "Entry DE",
          variantOrdinal: 2,
          publicAddress: "198.51.100.10",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          probeConsecutiveFailures: 1,
          incidentOpen: false,
          egressIpId: "ex-2",
          effectiveEgressIp: "198.51.100.21",
        },
      ],
    });

    const directDisabledNode = baseNode({
      id: "n-2",
      name: "fi-01",
      enabled: false,
      egressMode: "masquerade",
      egressDaemonState: "masquerade_ready",
      publicIp: "192.0.2.50",
      publicEndpoints: [
        {
          id: "ep-3",
          ordinal: 1,
          name: "FI Direct",
          publicAddress: "192.0.2.50",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: null,
          probeCheckedAt: null,
          probeDetail: null,
        },
      ],
    });

    const routeByNode = new Map<string, NodeRouteLabel>([
      [
        "n-1",
        {
          bridgeId: "b-1",
          bridgeName: "Bridge MSK",
          entry: "203.0.113.5:30001",
          revision: 1,
        },
      ],
    ]);

    const serviceChecks: AdminServiceCheck[] = [
      {
        id: "chk-1",
        name: "YouTube",
        probe: { kind: "http", url: "https://youtube.com" },
        assertions: [],
        intervalSec: 3600,
        enabled: true,
        egressResults: [
          {
            egressIpId: "ex-2",
            egressIpv4: "198.51.100.21",
            egressLabel: "DE Backup",
            nodeId: "n-1",
            nodeName: "de-01",
            status: "failed",
            httpStatus: 403,
            latencyMs: 120,
            detail: "blocked",
            finalUrl: null,
            checkedAt: "2026-11-26T10:00:00.000Z",
            failingSince: "2026-11-26T09:50:00.000Z",
          },
        ],
      },
    ];

    const graph = buildFleetTopologyGraph({
      nodes: [routedNode, directDisabledNode],
      bridges: [bridge],
      routeByNode,
      serviceChecks,
      reachability: null,
      activeKeysCount: 12,
      onlineDevicesCount: 4,
    });

    expect(graph.hasBridges).toBe(true);
    expect(graph.columns).toEqual(["panel", "bridges", "nodes", "entries", "exits"]);
    expect(graph.bridges).toHaveLength(1);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.entries).toHaveLength(3);
    expect(graph.exits).toHaveLength(3);

    // Bridged node edge & direct bypass edge
    const bridgeEdge = graph.edges.find(
      (e) => e.from === "bridge:b-1" && e.to === "node:n-1",
    );
    expect(bridgeEdge?.health).toBe("success");
    expect(bridgeEdge?.dashed).toBe(false);

    const directEdge = graph.edges.find(
      (e) => e.from === "panel:root" && e.to === "node:n-2",
    );
    expect(directEdge?.health).toBe("muted");
    expect(directEdge?.dashed).toBe(true);

    // Pre-alert variant (1 consecutive failure, no incident) -> warning
    const v2Entry = graph.entries.find((e) => e.endpointId === "ep-2");
    expect(v2Entry?.variantTag).toBe("v2");
    expect(v2Entry?.health).toBe("warning");

    // Broken exit with failing egress service check -> destructive
    const exit2 = graph.exits.find((ex) => ex.exitId === "ex-2");
    expect(exit2?.health).toBe("destructive");
    expect(exit2?.failingChecks.map((c) => c.checkName)).toEqual(["YouTube"]);

    const v2ToExit2 = graph.edges.find(
      (e) => e.from === "entry:n-1:ep-2" && e.to === "exit:n-1:ex-2",
    );
    expect(v2ToExit2?.health).toBe("destructive");

    // Highlighting path for ep-2 includes Panel -> Bridge -> n-1 -> ep-2 -> ex-2, excluding ep-1/ex-1/n-2
    const path = computeHighlightedPath(graph, "entry:n-1:ep-2");
    expect([...path.activeNodeIds].sort()).toEqual([
      "bridge:b-1",
      "entry:n-1:ep-2",
      "exit:n-1:ex-2",
      "node:n-1",
      "panel:root",
    ]);
    expect(path.activeNodeIds.has("entry:n-1:ep-1")).toBe(false);
    expect(path.activeNodeIds.has("node:n-2")).toBe(false);

    // Highlighting bridge includes routed node + its variants/exits, excluding direct n-2
    const bridgePath = computeHighlightedPath(graph, "bridge:b-1");
    expect(bridgePath.activeNodeIds.has("panel:root")).toBe(true);
    expect(bridgePath.activeNodeIds.has("node:n-1")).toBe(true);
    expect(bridgePath.activeNodeIds.has("entry:n-1:ep-1")).toBe(true);
    expect(bridgePath.activeNodeIds.has("node:n-2")).toBe(false);

    // Highlighting exit ex-1 walks upstream only through ep-1 -> n-1 -> b-1 -> panel
    const exitPath = computeHighlightedPath(graph, "exit:n-1:ex-1");
    expect([...exitPath.activeNodeIds].sort()).toEqual([
      "bridge:b-1",
      "entry:n-1:ep-1",
      "exit:n-1:ex-1",
      "node:n-1",
      "panel:root",
    ]);
  });

  it("omits bridges column when bridges is empty and maps check.results fallback to exits", () => {
    const node = baseNode({
      id: "n-1",
      name: "nl-01",
      egressMode: "masquerade",
      egressDaemonState: "masquerade_ready",
      publicIp: "198.51.100.99",
      publicEndpoints: [
        {
          id: "ep-1",
          ordinal: 1,
          name: "NL Primary",
          publicAddress: "198.51.100.99",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "failed",
          probeCheckedAt: null,
          probeDetail: null,
          incidentOpen: true,
        },
      ],
    });
    const serviceChecks: AdminServiceCheck[] = [
      {
        id: "chk-2",
        name: "ChatGPT",
        probe: { kind: "http", url: "https://chatgpt.com" },
        assertions: [],
        intervalSec: 3600,
        enabled: true,
        results: [
          {
            nodeId: "n-1",
            nodeName: "nl-01",
            status: "failed",
            httpStatus: 403,
            latencyMs: 90,
            detail: "cf block",
            finalUrl: null,
            checkedAt: "2026-11-26T10:00:00.000Z",
            failingSince: "2026-11-26T09:50:00.000Z",
          },
        ],
      },
    ];

    const graph = buildFleetTopologyGraph({
      nodes: [node],
      bridges: [],
      routeByNode: new Map(),
      serviceChecks,
      reachability: null,
      activeKeysCount: 3,
      onlineDevicesCount: 1,
    });

    expect(graph.hasBridges).toBe(false);
    expect(graph.columns).toEqual(["panel", "nodes", "entries", "exits"]);
    expect(graph.exits).toHaveLength(1);
    expect(graph.exits[0]?.failingChecks.map((c) => c.checkName)).toEqual(["ChatGPT"]);
    expect(graph.exits[0]?.health).toBe("destructive");
    expect(graph.entries[0]?.health).toBe("destructive");
  });

  it("supports One-to-Many topology (1 Entry IP fanning to 3 Exits)", () => {
    const makeExit = (id: string, ipv4: string, label: string) => ({
      id,
      nodeId: "n-1",
      ipv4,
      label,
      interfaceName: "eth0",
      gatewayIpv4: "198.51.100.1",
      routingTableId: 200,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: null,
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      allowAsEntry: false,
      enabled: true,
      hostState: "active" as const,
      hostDetail: null,
      observedSubnetCidr: null,
      detectedGatewayIpv4: null,
      txBytes: "0",
      txPackets: "0",
      hostObservedAt: null,
    });
    const node = baseNode({
      id: "n-1",
      name: "de-01",
      egressMode: "routed",
      egressDaemonState: "routed_active",
      egressDefaultIpId: "ex-1",
      egressIps: [
        makeExit("ex-1", "198.51.100.21", "Clean A"),
        makeExit("ex-2", "198.51.100.22", "Clean B"),
        makeExit("ex-3", "198.51.100.23", "Clean C"),
      ],
      publicEndpoints: [
        {
          id: "ep-1",
          ordinal: 1,
          name: "Shared Entry",
          entryName: "Shared Entry",
          variantOrdinal: 1,
          publicAddress: "198.51.100.10",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-1",
          effectiveEgressIp: "198.51.100.21",
        },
        {
          id: "ep-2",
          ordinal: 2,
          name: "Shared Entry",
          entryName: "Shared Entry",
          variantOrdinal: 2,
          publicAddress: "198.51.100.10",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-2",
          effectiveEgressIp: "198.51.100.22",
        },
        {
          id: "ep-3",
          ordinal: 3,
          name: "Shared Entry",
          entryName: "Shared Entry",
          variantOrdinal: 3,
          publicAddress: "198.51.100.10",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-3",
          effectiveEgressIp: "198.51.100.23",
        },
      ],
    });

    const graph = buildFleetTopologyGraph({
      nodes: [node],
      bridges: [],
      routeByNode: new Map(),
      serviceChecks: [],
      reachability: null,
      activeKeysCount: 5,
      onlineDevicesCount: 2,
    });

    expect(graph.entries).toHaveLength(3);
    expect(graph.entries.map((e) => e.publicAddress)).toEqual([
      "198.51.100.10",
      "198.51.100.10",
      "198.51.100.10",
    ]);
    expect(graph.entries.map((e) => e.variantTag)).toEqual(["v1", "v2", "v3"]);
    expect(graph.exits).toHaveLength(3);
    expect(graph.exits.every((ex) => ex.incomingVariantCount === 1)).toBe(true);
    const entryExitEdges = graph.edges.filter((e) => e.kind === "entry-exit");
    expect(entryExitEdges).toHaveLength(3);
  });

  it("supports Many-to-One topology (2 distinct Entry IPs converging on 1 shared Exit IP)", () => {
    const node = baseNode({
      id: "n-1",
      name: "nl-01",
      egressMode: "routed",
      egressDaemonState: "degraded",
      egressDefaultIpId: "ex-shared",
      egressIps: [
        {
          id: "ex-shared",
          nodeId: "n-1",
          ipv4: "198.51.100.90",
          label: "Shared Exit",
          interfaceName: "eth0",
          gatewayIpv4: "198.51.100.1",
          routingTableId: 200,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          allowAsEntry: false,
          enabled: true,
          hostState: "active",
          hostDetail: null,
          observedSubnetCidr: null,
          detectedGatewayIpv4: null,
          txBytes: "0",
          txPackets: "0",
          hostObservedAt: null,
        },
      ],
      publicEndpoints: [
        {
          id: "ep-a",
          ordinal: 1,
          name: "Entry Alpha",
          publicAddress: "198.51.100.11",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-shared",
          effectiveEgressIp: "198.51.100.90",
        },
        {
          id: "ep-b",
          ordinal: 2,
          name: "Entry Beta",
          publicAddress: "198.51.100.12",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-shared",
          effectiveEgressIp: "198.51.100.90",
        },
      ],
    });

    const graph = buildFleetTopologyGraph({
      nodes: [node],
      bridges: [],
      routeByNode: new Map(),
      serviceChecks: [],
      reachability: null,
      activeKeysCount: 4,
      onlineDevicesCount: 2,
    });

    expect(graph.entries).toHaveLength(2);
    expect(graph.exits).toHaveLength(1);
    expect(graph.exits[0]?.incomingVariantCount).toBe(2);
    const entryExitEdges = graph.edges.filter((e) => e.kind === "entry-exit");
    expect(entryExitEdges).toHaveLength(2);
    expect(entryExitEdges.every((e) => e.to === "exit:n-1:ex-shared")).toBe(true);
  });
});

describe("FleetTopologyMap SSR markup", () => {
  it("renders expanded topology with bridges, nodes, variants, pre-alert, and exits", () => {
    const bridge = baseBridge({
      id: "b-1",
      name: "Bridge Frankfurt",
      controlTcpPort: 7443,
    });
    const node = baseNode({
      id: "n-1",
      name: "de-01",
      peerCount: 8,
      maxPeers: 50,
      egressMode: "routed",
      egressDaemonState: "routed_active",
      egressDefaultIpId: "ex-1",
      egressIps: [
        {
          id: "ex-1",
          nodeId: "n-1",
          ipv4: "198.51.100.30",
          label: "Hetzner Exit",
          interfaceName: "eth0",
          gatewayIpv4: null,
          routingTableId: 200,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          allowAsEntry: false,
          enabled: true,
          hostState: "active",
          hostDetail: null,
          observedSubnetCidr: null,
          detectedGatewayIpv4: null,
          txBytes: "0",
          txPackets: "0",
          hostObservedAt: null,
        },
      ],
      publicEndpoints: [
        {
          id: "ep-1",
          ordinal: 1,
          name: "Edge DE",
          entryName: "Edge DE",
          variantOrdinal: 1,
          publicAddress: "198.51.100.10",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          probeConsecutiveFailures: 1,
          incidentOpen: false,
          egressIpId: "ex-1",
          effectiveEgressIp: "198.51.100.30",
        },
      ],
    });
    const routeByNode = new Map<string, NodeRouteLabel>([
      [
        "n-1",
        {
          bridgeId: "b-1",
          bridgeName: "Bridge Frankfurt",
          entry: "203.0.113.5:30001",
          revision: 1,
        },
      ],
    ]);

    const reachability: AdminReachabilityView = {
      probe: null,
      nodes: [],
      bridges: [
        {
          bridgeId: "b-1",
          bridgeName: "Bridge Frankfurt",
          publicIpv4: "203.0.113.5",
          panelDnsHostname: null,
          reachabilityEnabled: true,
          managementStatus: "ok",
          frpsReachable: true,
          mgmtIncidentOpen: false,
          mgmtFailingSince: null,
          mgmtDetail: null,
          probeStatus: "ok",
          probeLevels: null,
          probeCheckedAt: null,
          probeFailingSince: null,
          probeConsecutiveFailures: 0,
          probeIncidentOpen: false,
          probeDetail: null,
          activeRoutes: [],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <FleetTopologyMap
        nodes={[node]}
        bridges={[bridge]}
        routeByNode={routeByNode}
        serviceChecks={[]}
        reachability={reachability}
        activeKeysCount={10}
        onlineDevicesCount={4}
      />,
    );

    expect(html).toContain('data-testid="fleet-topology-map"');
    expect(html).toContain('data-testid="fleet-topology-svg"');
    expect(html).toContain(messages.ru["ov.map.collapse"]);
    expect(html).toContain("Bridge Frankfurt");
    expect(html).toContain("frps ok · :7443");
    expect(html).toContain("de-01");
    expect(html).toContain("8/50");
    expect(html).toContain("Edge DE");
    expect(html).toContain("198.51.100.30");
    expect(html).toContain("Hetzner Exit");
    expect(html).toContain(messages.ru["ov.map.daemonShort.routed_active"]);
    expect(html).toContain(messages.ru["ov.map.clickHint"]);
    expect(html).toContain(messages.ru["reachability.preAlert"].replace("{count}", "1"));
    expect(html).toContain("<path");
  });

  it("renders short daemon state pill and Many-to-One ×2 convergence badge", () => {
    const node = baseNode({
      id: "n-1",
      name: "nl-01",
      egressMode: "routed",
      egressDaemonState: "degraded",
      egressDefaultIpId: "ex-shared",
      egressIps: [
        {
          id: "ex-shared",
          nodeId: "n-1",
          ipv4: "198.51.100.90",
          label: "Shared Exit",
          interfaceName: "eth0",
          gatewayIpv4: "198.51.100.1",
          routingTableId: 200,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          allowAsEntry: false,
          enabled: true,
          hostState: "active",
          hostDetail: null,
          observedSubnetCidr: null,
          detectedGatewayIpv4: null,
          txBytes: "0",
          txPackets: "0",
          hostObservedAt: null,
        },
      ],
      publicEndpoints: [
        {
          id: "ep-a",
          ordinal: 1,
          name: "Entry Alpha",
          publicAddress: "198.51.100.11",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-shared",
          effectiveEgressIp: "198.51.100.90",
        },
        {
          id: "ep-b",
          ordinal: 2,
          name: "Entry Beta",
          publicAddress: "198.51.100.12",
          enabled: true,
          reachabilityEnabled: true,
          probeStatus: "ok",
          probeCheckedAt: null,
          probeDetail: null,
          egressIpId: "ex-shared",
          effectiveEgressIp: "198.51.100.90",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <FleetTopologyMap
        nodes={[node]}
        bridges={[]}
        routeByNode={new Map()}
        serviceChecks={[]}
        activeKeysCount={4}
        onlineDevicesCount={2}
      />,
    );

    expect(html).toContain(messages.ru["ov.map.daemonShort.degraded"]);
    expect(html).toContain("×2");
    expect(html).toContain(
      messages.ru["ov.map.sharedExitTitle"].replace("{count}", "2"),
    );
  });

  it("renders collapsed state when defaultExpanded is false", () => {
    const html = renderToStaticMarkup(
      <FleetTopologyMap
        nodes={[baseNode()]}
        bridges={[]}
        routeByNode={new Map()}
        serviceChecks={[]}
        activeKeysCount={2}
        onlineDevicesCount={1}
        defaultExpanded={false}
      />,
    );

    expect(html).toContain('data-testid="fleet-topology-map"');
    expect(html).toContain(messages.ru["ov.map.expand"]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="fleet-topology-svg"');
    expect(html).not.toContain("de-01");
  });

  it("renders empty state when neither nodes nor bridges exist", () => {
    const html = renderToStaticMarkup(
      <FleetTopologyMap
        nodes={[]}
        bridges={[]}
        routeByNode={new Map()}
        serviceChecks={[]}
        activeKeysCount={0}
        onlineDevicesCount={0}
      />,
    );

    expect(html).toContain('data-testid="fleet-topology-map"');
    expect(html).toContain(messages.ru["ov.map.empty"]);
    expect(html).not.toContain('data-testid="fleet-topology-svg"');
  });
});
