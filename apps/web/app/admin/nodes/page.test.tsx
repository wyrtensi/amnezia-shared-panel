import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminNode } from "@/components/admin/admin-data";
import { TooltipProvider } from "@/components/ui/tooltip";
import AdminNodesPage from "./page";

const fixture = vi.hoisted(() => ({
  query: "",
  loadingRoutes: false,
  failedRoutes: false,
  nodes: [] as AdminNode[],
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(fixture.query),
}));

vi.mock("@/components/admin/admin-data", () => ({
  useAdminData: () => ({ nodes: fixture.nodes, keys: [], loading: false }),
}));

vi.mock("@/components/admin/use-bridge-infra", () => ({
  useBridgeInfra: () => ({
    bridges: [],
    routeByNode: new Map(),
    loading: fixture.loadingRoutes,
    failed: fixture.failedRoutes,
  }),
}));

vi.mock("@/components/admin/use-service-checks", () => ({
  useServiceChecks: () => ({ checks: [], byNode: new Map() }),
}));
vi.mock("@/components/admin/use-reachability", () => ({ useReachability: () => ({}) }));
vi.mock("@/components/admin/service-checks-card", () => ({
  ServiceChecksCard: () => <div>Service checks</div>,
}));
vi.mock("@/components/admin/reachability-card", () => ({
  ReachabilityCard: () => <div>Reachability</div>,
}));

const render = () =>
  renderToStaticMarkup(<TooltipProvider><AdminNodesPage /></TooltipProvider>);

afterEach(() => {
  fixture.query = "";
  fixture.loadingRoutes = false;
  fixture.failedRoutes = false;
  fixture.nodes = [];
});

describe("Nodes and bridges page", () => {
  it.each(["", "tab=bridges"])("shows both sections with query %j", (query) => {
    fixture.query = query;

    const html = render();

    expect(html).toContain('href="#vpn-nodes"');
    expect(html).toContain('href="#bridges"');
    expect(html).toContain('id="vpn-nodes"');
    expect(html).toContain('id="bridges"');
    expect(html).toContain("Service checks");
    expect(html).toContain("Reachability");
  });

  it.each([
    { loadingRoutes: true, failedRoutes: false },
    { loadingRoutes: false, failedRoutes: true },
  ])("does not label an unconfirmed route as direct (%j)", (state) => {
    Object.assign(fixture, state);
    fixture.nodes = [{
      id: "test-node",
      name: "Test node",
      apiBaseUrl: "https://node.example.test",
      enabled: true,
      protocol: "awg3",
      maxPeers: 25,
      capabilities: {},
      publicHost: null,
      publicIp: null,
      publicIpResolvedAt: null,
      lastHealthAt: null,
      lastSyncAt: null,
      lastError: null,
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    }];

    expect(render()).not.toContain("Напрямую");
  });

  it("renders per-node IPv6 Reject (ULA) toggle and status for AWG 3.1 nodes, and hides it on AWG 2.0-only nodes", () => {
    fixture.nodes = [
      {
        id: "node-awg3",
        name: "AWG3 Node",
        apiBaseUrl: "https://awg3.example.test",
        enabled: true,
        protocol: "awg3",
        supportedProtocols: ["awg3"],
        maxPeers: 50,
        capabilities: { awg3: true },
        publicHost: null,
        publicIp: null,
        publicIpResolvedAt: null,
        lastHealthAt: null,
        lastSyncAt: null,
        lastError: null,
        ipv6RejectStub: {
          enabled: false,
          prefix: "fd6b:7c2e:4a91:9f::/64",
          state: "unsupported",
          reason: "ipv6_forwarding_disabled",
          observedAt: "2026-11-19T06:00:00.000Z",
        },
        createdAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
      {
        id: "node-awg2",
        name: "AWG2 Only",
        apiBaseUrl: "https://awg2.example.test",
        enabled: true,
        protocol: "awg2",
        supportedProtocols: ["awg2"],
        maxPeers: 50,
        capabilities: { awg2: true },
        publicHost: null,
        publicIp: null,
        publicIpResolvedAt: null,
        lastHealthAt: null,
        lastSyncAt: null,
        lastError: null,
        createdAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
    ];

    const html = render();
    expect(html).toContain("IPv6 Reject (ULA)");
    expect(html).toContain("fd6b:7c2e:4a91:9f::/64");
    expect(html).toContain("IPv6 forwarding sysctls");
    // Only the AWG 3.1 node renders the toggle switch (AWG 2.0-only card omits it).
    expect(html.match(/aria-label="[^"]*IPv6 Reject \(ULA\)[^"]*"/g)).toHaveLength(1);
    const awg2Slice = html.slice(html.indexOf("AWG2 Only"));
    expect(awg2Slice).not.toContain("IPv6 Reject (ULA)");
  });
});
