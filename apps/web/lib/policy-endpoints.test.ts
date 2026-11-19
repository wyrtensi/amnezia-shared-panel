import { describe, expect, it } from "vitest";
import type { AdminNode } from "@/components/admin/admin-data";
import {
  deriveAllowedNodeIds,
  deriveNodeOrderFromTargets,
  expandPolicyTargets,
  initialAllowedTargetIds,
  initialEndpointOrder,
  initialRecommendedEndpointIds,
} from "./policy-endpoints";

const makeNode = (
  id: string,
  name: string,
  endpoints?: AdminNode["publicEndpoints"],
): AdminNode => ({
  id,
  name,
  apiBaseUrl: `http://${name}:4001`,
  enabled: true,
  protocol: "awg3",
  maxPeers: 250,
  capabilities: {},
  publicHost: `${name}.example.test`,
  publicIp: null,
  publicIpResolvedAt: null,
  lastHealthAt: null,
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  publicEndpoints: endpoints,
});

const ep = (
  id: string,
  ordinal: number,
  name: string,
  publicAddress: string,
  enabled = true,
): NonNullable<AdminNode["publicEndpoints"]>[number] => ({
  id,
  ordinal,
  name,
  publicAddress,
  enabled,
  reachabilityEnabled: true,
  probeStatus: null,
  probeLevels: null,
  probeCheckedAt: null,
  probeFailingSince: null,
  probeConsecutiveFailures: 0,
  incidentOpen: false,
  probeDetail: null,
  reachability: { state: "unknown", since: null },
});

describe("policy-endpoints", () => {
  const nodes: AdminNode[] = [
    makeNode("node-a", "Node A", [
      ep("ep-a1", 1, "Alpha Primary", "192.0.2.10"),
      ep("ep-a2", 2, "Alpha Backup", "192.0.2.11"),
    ]),
    makeNode("node-b", "Node B", []),
  ];

  it("expands multi-IP nodes into per-endpoint targets and keeps single fallback for endpointless nodes", () => {
    const targets = expandPolicyTargets(nodes);
    expect(targets.map((t) => ({ id: t.id, nodeId: t.nodeId, name: t.name, address: t.address, isEndpoint: t.isEndpoint }))).toEqual([
      { id: "ep-a1", nodeId: "node-a", name: "Alpha Primary", address: "192.0.2.10", isEndpoint: true },
      { id: "ep-a2", nodeId: "node-a", name: "Alpha Backup", address: "192.0.2.11", isEndpoint: true },
      { id: "node-b", nodeId: "node-b", name: "Node B", address: "Node B.example.test", isEndpoint: false },
    ]);
  });

  it("upgrades legacy allowedNodeIds into per-IP target ids and derives allowedNodeIds back", () => {
    const targets = expandPolicyTargets(nodes);
    expect(initialAllowedTargetIds(targets, null, null)).toBeNull();
    expect(initialAllowedTargetIds(targets, null, ["node-a"])).toEqual(["ep-a1", "ep-a2"]);
    expect(initialAllowedTargetIds(targets, ["ep-a2"], ["node-a"])).toEqual(["ep-a2"]);
    expect(deriveAllowedNodeIds(targets, null)).toBeNull();
    expect(deriveAllowedNodeIds(targets, ["ep-a2"])).toEqual(["node-a"]);
    expect(deriveAllowedNodeIds(targets, ["ep-a2", "node-b"])).toEqual(["node-a", "node-b"]);
    expect(deriveAllowedNodeIds(targets, [])).toEqual([]);
  });

  it("expands legacy nodeOrder/recommendedNodeIds and always preserves the prefix invariant when deriving back", () => {
    const targets = expandPolicyTargets(nodes);
    expect(initialEndpointOrder(targets, [], ["node-b", "node-a"])).toEqual([
      "node-b",
      "ep-a1",
      "ep-a2",
    ]);
    expect(
      initialRecommendedEndpointIds(targets, [], [], ["node-b"]),
    ).toEqual(["node-b"]);

    // Interleaved per-IP order: Alpha Backup (rec), Node B (not rec), Alpha Primary (not rec)
    const derived = deriveNodeOrderFromTargets(
      targets,
      ["ep-a2", "node-b", "ep-a1"],
      ["ep-a2"],
    );
    expect(derived).toEqual({
      nodeOrder: ["node-a", "node-b"],
      recommendedNodeIds: ["node-a"],
    });

    // Both Alpha Backup and Node B recommended, Alpha Primary not recommended
    const derived2 = deriveNodeOrderFromTargets(
      targets,
      ["ep-a2", "node-b", "ep-a1"],
      ["ep-a2", "node-b"],
    );
    expect(derived2).toEqual({
      nodeOrder: ["node-a", "node-b"],
      recommendedNodeIds: ["node-a", "node-b"],
    });
  });
});
