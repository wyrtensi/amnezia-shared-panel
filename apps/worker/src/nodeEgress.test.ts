import { describe, expect, it } from "vitest";
import type { HostNetworkReport } from "@amnezia/contracts";
import {
  buildNodeEgressDesiredState,
  evaluateEgressMirror,
  extractPeerIpv4,
  formatEgressModeDriftAlert,
} from "./nodeEgress.js";

describe("nodeEgress pure helpers", () => {
  it("extractPeerIpv4 returns only strict IPv4 /32 entries", () => {
    expect(extractPeerIpv4(["fd6b::2/128", "10.90.0.4/32"])).toBe("10.90.0.4");
    expect(extractPeerIpv4(["0.0.0.0/0", "::/0"])).toBeNull();
    expect(extractPeerIpv4(["10.90.0.0/24"])).toBeNull();
    expect(extractPeerIpv4([])).toBeNull();
  });

  it("buildNodeEgressDesiredState maps endpoints, default exit fallback, implicit self-exit, and omits null fields", () => {
    const state = buildNodeEgressDesiredState({
      node: {
        id: "node-1",
        publicIp: "198.51.100.10",
        egressBlockSmtp: true,
        egressIsolatePrivate: false,
        egressDefaultIpId: "exit-1",
      },
      exits: [
        {
          id: "exit-1",
          ipv4: "198.51.100.20",
          interfaceName: "eth0",
          gatewayIpv4: null,
          routingTableId: 200,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          enabled: true,
        },
        {
          id: "exit-entry",
          ipv4: "198.51.100.10",
          interfaceName: null,
          gatewayIpv4: null,
          routingTableId: 201,
          dnsPrimary: "9.9.9.9",
          dnsSecondary: "149.112.112.112",
          amneziaDnsDnat: true,
          enforceDnsDnat: true,
          enabled: true,
        },
      ],
      endpoints: [
        { id: "ep-1", ordinal: 1, address: "198.51.100.10", egressIpId: "exit-entry", enabled: true },
        { id: "ep-2", ordinal: 2, address: "198.51.100.10", egressIpId: "exit-1", enabled: true },
        { id: "ep-off", ordinal: 3, address: "198.51.100.11", egressIpId: null, enabled: false },
      ],
      keys: [
        { keyId: "k1", state: "active", protocol: "awg3", endpointId: "ep-1", tunnelIpv4: "10.90.0.2" },
        { keyId: "k2", state: "active", protocol: "awg3", endpointId: "ep-2", tunnelIpv4: "10.90.0.3" },
        { keyId: "k3", state: "disabled", protocol: "awg3", endpointId: null, tunnelIpv4: "10.90.0.4" },
        { keyId: "k4", state: "active", protocol: "awg3", endpointId: "ep-off", tunnelIpv4: "10.90.0.5" },
        { keyId: "k-awg2", state: "active", protocol: "awg2", endpointId: null, tunnelIpv4: "10.8.1.2" },
        { keyId: "k-revoked", state: "revoked", protocol: "awg3", endpointId: "ep-1", tunnelIpv4: "10.90.0.6" },
      ],
    });

    expect(state.blockSmtp).toBe(true);
    expect(state.isolatePrivate).toBe(false);
    expect(state.exits[0]).not.toHaveProperty("gatewayIpv4");
    expect(state.exits[0]).not.toHaveProperty("dnsSecondary");
    expect(state.peers).toEqual([
      {
        tunnelIpv4: "10.90.0.2",
        exitIp: "198.51.100.10",
        dnsPrimary: "9.9.9.9",
        amneziaDnsDnat: true,
        enforceDnsDnat: true,
        routingTableId: 201,
        enabled: true,
      },
      {
        tunnelIpv4: "10.90.0.3",
        exitIp: "198.51.100.20",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        routingTableId: 200,
        enabled: true,
      },
      {
        tunnelIpv4: "10.90.0.4",
        exitIp: "198.51.100.10",
        dnsPrimary: "9.9.9.9",
        amneziaDnsDnat: true,
        enforceDnsDnat: true,
        routingTableId: 201,
        enabled: false,
      },
      {
        tunnelIpv4: "10.90.0.5",
        exitIp: "198.51.100.20",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        routingTableId: 200,
        enabled: false,
      },
    ]);
    expect(state.entryMarks).toEqual([{ entryIpv4: "198.51.100.10", routingTableId: 201 }]);
  });

  it("synthesizes implicit self-exit DesiredExit entries when no explicit exits exist", () => {
    const state = buildNodeEgressDesiredState({
      node: {
        id: "node-2",
        publicIp: "198.51.100.99",
        egressBlockSmtp: true,
        egressIsolatePrivate: true,
        egressDefaultIpId: null,
      },
      exits: [],
      endpoints: [
        { id: "ep-a", ordinal: 1, address: "198.51.100.99", egressIpId: null, enabled: true },
        { id: "ep-b", ordinal: 2, address: "198.51.100.88", egressIpId: null, enabled: true },
      ],
      keys: [
        { keyId: "k1", state: "active", protocol: "awg3", endpointId: null, tunnelIpv4: "10.90.0.2" },
        { keyId: "k2", state: "active", protocol: "awg3", endpointId: "ep-b", tunnelIpv4: "10.90.0.3" },
      ],
    });
    expect(state.exits).toEqual([
      {
        id: "implicit:198.51.100.88",
        ipv4: "198.51.100.88",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        enabled: true,
      },
      {
        id: "implicit:198.51.100.99",
        ipv4: "198.51.100.99",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        enabled: true,
      },
    ]);
    expect(state.peers).toEqual([
      {
        tunnelIpv4: "10.90.0.2",
        exitIp: "198.51.100.99",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        enabled: true,
      },
      {
        tunnelIpv4: "10.90.0.3",
        exitIp: "198.51.100.88",
        dnsPrimary: "1.1.1.1",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
        enabled: true,
      },
    ]);
    expect(state.entryMarks).toEqual([
      { entryIpv4: "198.51.100.88" },
      { entryIpv4: "198.51.100.99" },
    ]);
  });

  it("emits entryMarks for asymmetric secondary Entry IPs without routingTableId and keeps exit tableId when shared", () => {
    const state = buildNodeEgressDesiredState({
      node: {
        id: "node-3",
        publicIp: "198.51.100.10",
        egressBlockSmtp: true,
        egressIsolatePrivate: true,
        egressDefaultIpId: "exit-1",
      },
      exits: [
        {
          id: "exit-1",
          ipv4: "198.51.100.20",
          interfaceName: "eth0",
          gatewayIpv4: null,
          routingTableId: 200,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          enabled: true,
        },
        {
          id: "exit-2",
          ipv4: "198.51.100.30",
          interfaceName: "eth1",
          gatewayIpv4: "198.51.100.1",
          routingTableId: 201,
          dnsPrimary: "1.1.1.1",
          dnsSecondary: null,
          amneziaDnsDnat: true,
          enforceDnsDnat: false,
          enabled: true,
        },
      ],
      endpoints: [
        { id: "ep-main", ordinal: 1, address: "198.51.100.10", egressIpId: "exit-1", enabled: true },
        { id: "ep-asym", ordinal: 2, address: "198.51.100.40", egressIpId: "exit-1", enabled: true },
        { id: "ep-shared", ordinal: 3, address: "198.51.100.30", egressIpId: "exit-2", enabled: true },
        { id: "ep-off", ordinal: 4, address: "198.51.100.50", egressIpId: "exit-1", enabled: false },
      ],
      keys: [],
    });

    expect(state.entryMarks).toEqual([
      { entryIpv4: "198.51.100.10" },
      { entryIpv4: "198.51.100.30", routingTableId: 201 },
      { entryIpv4: "198.51.100.40" },
    ]);
  });

  it("evaluateEgressMirror detects mode_drift, forces conflict state, and formats alert", () => {
    const report: HostNetworkReport = {
      daemonVersion: "1.0.0",
      observedMode: "routed",
      egressState: "routed_active",
      bridgeName: "br-awg-egress",
      bridgePresent: true,
      tunnelSubnetConflict: false,
      ipv4Addresses: [],
      exits: [
        {
          ipv4: "198.51.100.20",
          hostState: "active",
          txBytes: 1234,
          txPackets: 56,
        },
      ],
      observedAt: "2026-11-25T10:00:00.000Z",
    };

    const evaluated = evaluateEgressMirror("masquerade", report);
    expect(evaluated.modeDrift).toBe(true);
    expect(evaluated.daemonState).toBe("conflict");
    expect(evaluated.daemonDetail).toContain("host runs routed");
    expect(evaluated.exitsByIpv4.get("198.51.100.20")?.txBytes).toBe(1234n);

    const matched = evaluateEgressMirror("routed", report);
    expect(matched.modeDrift).toBe(false);
    expect(matched.daemonState).toBe("routed_active");

    expect(formatEgressModeDriftAlert("de-01", "routed", "masquerade")).toContain("de-01");
  });
});
