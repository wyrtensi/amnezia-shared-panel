import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bridge, KeyBridgeInfo } from "@amnezia/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { KeyBridgeBadge } from "@/components/key-bridge-badge";
import { bridgeOptionsForNode } from "./key-bridge-select";

const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";
const now = "2026-11-19T00:00:00.000Z";

const makeBridge = (
  id: string,
  name: string,
  publicIpv4: string,
  routes: Bridge["routes"],
): Bridge => ({
  id,
  name,
  publicIpv4,
  controlTcpPort: 7000,
  udpPortStart: 41000,
  udpPortEnd: 41031,
  capacity: 32,
  heldPorts: routes.length,
  managementStatus: "ok",
  lastObservedAt: now,
  routes,
  createdAt: now,
  updatedAt: now,
});

describe("bridgeOptionsForNode", () => {
  it("filters to the target node and sorts active before draft and retiring", () => {
    const bridges: Bridge[] = [
      makeBridge("b-1", "Bridge Draft", "198.51.100.10", [
        {
          id: "r-draft",
          nodeId: NODE_A,
          nodeName: "Node A",
          publicUdpPort: 41001,
          state: "draft",
          transport: "frp_tcp",
          registration: { status: "online", marker: "m1", observedAt: now },
          verification: { kind: "candidate", status: "none", method: null, verifiedAt: null, error: null },
        },
        {
          id: "r-other",
          nodeId: NODE_B,
          nodeName: "Node B",
          publicUdpPort: 41002,
          state: "active",
          transport: "frp_tcp",
          registration: { status: "online", marker: "m2", observedAt: now },
          verification: { kind: "awg_path", status: "ok", checkedAt: now },
        },
      ]),
      makeBridge("b-2", "Bridge Active", "203.0.113.20", [
        {
          id: "r-active",
          nodeId: NODE_A,
          nodeName: "Node A",
          publicUdpPort: 41000,
          state: "active",
          transport: "frp_tcp",
          registration: { status: "online", marker: "m3", observedAt: now },
          verification: { kind: "awg_path", status: "ok", checkedAt: now },
        },
      ]),
    ];

    const options = bridgeOptionsForNode(bridges, NODE_A);
    expect(options.map((item) => item.routeId)).toEqual(["r-active", "r-draft"]);
    expect(options[0]).toMatchObject({
      bridgeName: "Bridge Active",
      publicIpv4: "203.0.113.20",
      publicUdpPort: 41000,
      state: "active",
    });
  });
});

describe("KeyBridgeBadge", () => {
  const render = (bridge?: KeyBridgeInfo) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <KeyBridgeBadge bridge={bridge} />
      </TooltipProvider>,
    );

  it("renders nothing when bridge info is absent or normal inherit Direct", () => {
    expect(render(undefined)).toBe("");
    expect(render({ mode: "inherit", routeId: null, effective: null })).toBe("");
  });

  it("renders the bridge name badge when a key routes through a bridge", () => {
    const html = render({
      mode: "route",
      routeId: "33333333-3333-4333-8333-333333333333",
      effective: {
        routeId: "33333333-3333-4333-8333-333333333333",
        bridgeId: "44444444-4444-4444-8444-444444444444",
        bridgeName: "edge-ru",
        publicIpv4: "198.51.100.10",
        publicUdpPort: 41000,
        source: "key",
      },
    });
    expect(html).toContain("edge-ru");
  });

  it("renders the Direct pinned badge when bridgeMode is direct", () => {
    const html = render({ mode: "direct", routeId: null, effective: null });
    expect(html).toContain("Напрямую");
  });
});
