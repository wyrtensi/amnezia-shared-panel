import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { deviceTypeSchema } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";
import {
  auditEvents,
  deviceTypeEnum,
  identities,
  jobOutbox,
  nodeEgressIps,
  nodeEgressServiceCheckResults,
  nodeMetricsCurrent,
  nodeMetricsSamples,
  nodes,
  nodeVpnEndpoints,
  nodeServiceCheckResults,
  nodeServiceChecks,
  peerCurrent,
  peerSamples,
  portalPolicy,
  quotaRequests,
  routeRuleVersions,
  trafficRollups,
  users,
  vpnKeys,
} from "./schema.js";

describe("database schema", () => {
  it("exports every central domain table", () => {
    expect(
      [
        users,
        identities,
        nodes,
        vpnKeys,
        quotaRequests,
        peerCurrent,
        peerSamples,
        trafficRollups,
        routeRuleVersions,
        portalPolicy,
        auditEvents,
        jobOutbox,
        nodeMetricsCurrent,
        nodeMetricsSamples,
        nodeServiceChecks,
        nodeServiceCheckResults,
      ].map(getTableName),
    ).toEqual([
      "users",
      "identities",
      "nodes",
      "vpn_keys",
      "quota_requests",
      "peer_current",
      "peer_samples",
      "traffic_rollups",
      "route_rule_versions",
      "portal_policy",
      "audit_events",
      "job_outbox",
      "node_metrics_current",
      "node_metrics_samples",
      "node_service_checks",
      "node_service_check_results",
    ]);
  });

  it("stores the node's reported public host and its resolved IP", () => {
    const columns = getTableColumns(nodes);
    expect(columns.publicHost.name).toBe("public_host");
    expect(columns.publicHost.notNull).toBe(false);
    expect(columns.publicIp.name).toBe("public_ip");
    expect(columns.publicIp.notNull).toBe(false);
    expect(columns.publicIpResolvedAt.name).toBe("public_ip_resolved_at");
    expect(columns.publicIpResolvedAt.notNull).toBe(false);
    expect(columns.ipv6RejectStubEnabled.name).toBe("ipv6_reject_stub_enabled");
    expect(columns.ipv6RejectStubEnabled.notNull).toBe(true);
    expect(columns.ipv6RejectStubEnabled.default).toBe(false);
    expect(columns.ipv6RejectStubPrefix.name).toBe("ipv6_reject_stub_prefix");
    expect(columns.ipv6RejectStubPrefix.default).toBe("fd6b:7c2e:4a91:9f::/64");
    expect(columns.ipv6RejectStubState.name).toBe("ipv6_reject_stub_state");
    expect(columns.ipv6RejectStubState.default).toBe("off");
    expect(columns.ipv6RejectStubReason.notNull).toBe(false);
    expect(columns.ipv6RejectStubObservedAt.notNull).toBe(false);
  });

  it("hides the node address from users until the policy turns it on", () => {
    const columns = getTableColumns(portalPolicy);
    expect(columns.showNodeAddress.name).toBe("show_node_address");
    expect(columns.showNodeAddress.notNull).toBe(true);
    expect(columns.showNodeAddress.default).toBe(false);
  });

  it("keeps user bridge routing off by default and keys inheriting policy", () => {
    const policyCols = getTableColumns(portalPolicy);
    expect(policyCols.useBridge.name).toBe("use_bridge");
    expect(policyCols.useBridge.notNull).toBe(true);
    expect(policyCols.useBridge.default).toBe(false);

    const keyCols = getTableColumns(vpnKeys);
    expect(keyCols.bridgeMode.name).toBe("bridge_mode");
    expect(keyCols.bridgeMode.notNull).toBe(true);
    expect(keyCols.bridgeMode.default).toBe("inherit");
    expect(keyCols.vpnBridgeRouteId.name).toBe("vpn_bridge_route_id");
    expect(keyCols.vpnBridgeRouteId.notNull).toBe(false);
    expect(keyCols.tunnelIpv4.name).toBe("tunnel_ipv4");
    expect(keyCols.tunnelIpv4.notNull).toBe(false);
  });

  it("declares node_egress_ips, endpoint variants, and per-exit check results", () => {
    expect(getTableName(nodeEgressIps)).toBe("node_egress_ips");
    expect(getTableName(nodeEgressServiceCheckResults)).toBe("node_egress_service_check_results");

    const nodeCols = getTableColumns(nodes);
    expect(nodeCols.egressMode.name).toBe("egress_mode");
    expect(nodeCols.egressMode.default).toBe("masquerade");
    expect(nodeCols.egressDaemonState.default).toBe("unavailable");
    expect(nodeCols.egressBlockSmtp.default).toBe(true);
    expect(nodeCols.egressIsolatePrivate.default).toBe(true);

    const epCols = getTableColumns(nodeVpnEndpoints);
    expect(epCols.entryName.name).toBe("entry_name");
    expect(epCols.variantOrdinal.default).toBe(1);
    expect(epCols.egressIpId.name).toBe("egress_ip_id");
    expect(epCols.probeEgressMatch.name).toBe("probe_egress_match");

    const epConfig = getTableConfig(nodeVpnEndpoints);
    const addrEgressUnique = epConfig.uniqueConstraints.find(
      (constraint) => constraint.name === "node_vpn_endpoints_address_egress_unique",
    );
    expect(addrEgressUnique?.nullsNotDistinct).toBe(true);
  });
});

// The DB enum used to be a hand-kept second copy of the contract's list. That
// is how "tablet" ended up offered by the UI but storable nowhere. This test is
// the copy's leash.
describe("device_type enum", () => {
  it("matches the contract exactly, in the same order", () => {
    expect(deviceTypeEnum.enumValues).toEqual(deviceTypeSchema.options);
  });
});
