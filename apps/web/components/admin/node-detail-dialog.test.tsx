import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminKey, AdminNode } from "@/components/admin/admin-data";
import {
  NO_KEYS,
  NodeCard,
  computeNodeKeyStats,
} from "@/components/admin/node-card-suite";
import {
  NodeDetailDialog,
  NodeDetailDialogBody,
} from "@/components/admin/node-detail-dialog";
import type { BridgeInfra } from "@/components/admin/use-bridge-infra";
import type { useReachability } from "@/components/admin/use-reachability";
import type { useServiceChecks } from "@/components/admin/use-service-checks";
import { TooltipProvider } from "@/components/ui/tooltip";

const makeNode = (over: Partial<AdminNode> = {}): AdminNode => ({
  id: "n-detail-1",
  name: "Frankfurt-1",
  publicName: "Frankfurt Primary",
  apiBaseUrl: "https://de1.example.test:4001",
  enabled: true,
  protocol: "awg3",
  supportedProtocols: ["awg3"],
  enabledProtocols: ["awg3"],
  maxPeers: 100,
  peerCount: 12,
  capabilities: { peerLifecycle: true, telemetry: true },
  publicHost: "de1.example.test",
  publicIp: "198.51.100.10",
  publicIpResolvedAt: "2026-11-25T10:00:00.000Z",
  lastHealthAt: "2026-11-25T10:00:00.000Z",
  lastSyncAt: "2026-11-25T10:00:00.000Z",
  lastError: null,
  agentVersion: "1.4.2",
  egressMode: "routed",
  egressModeState: "idle",
  egressDaemonState: "routed_active",
  egressIps: [],
  publicEndpoints: [],
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
  ...over,
});

const makeKey = (over: Partial<AdminKey> = {}): AdminKey => ({
  id: "k-1",
  ownerId: "u-1",
  nodeId: "n-detail-1",
  protocol: "awg3",
  state: "active",
  deviceType: "macos",
  deviceLabel: "MacBook",
  routeProfile: "ru_blacklist",
  routeRuleVersionId: null,
  lastUsedAt: null,
  failureReason: null,
  createdAt: "2026-11-25T00:00:00.000Z",
  configUpdatedAt: null,
  ...over,
});

const emptyInfra: BridgeInfra = {
  bridges: [],
  routeByNode: new Map(),
  loading: false,
  failed: false,
  reload: () => Promise.resolve(),
};

const emptyChecks: ReturnType<typeof useServiceChecks> = {
  checks: [
    {
      id: "chk-1",
      name: "YouTube",
      url: "https://youtube.com",
      expectedStatus: 200,
      results: [],
    } as never,
  ],
  byNode: new Map([
    [
      "n-detail-1",
      [{ id: "chk-1", name: "YouTube", status: "ok", detail: null }],
    ],
  ]),
  loading: false,
  failed: false,
  reload: () => Promise.resolve(),
};

const emptyReachability: ReturnType<typeof useReachability> = {
  view: null,
  byNode: new Map(),
  loading: false,
  failed: false,
  reload: () => Promise.resolve(),
};

describe("computeNodeKeyStats", () => {
  it("counts total, active, and unique owner keys per node", () => {
    const stats = computeNodeKeyStats([
      makeKey({ id: "k-1", ownerId: "u-1", nodeId: "n-1", state: "active" }),
      makeKey({ id: "k-2", ownerId: "u-1", nodeId: "n-1", state: "revoked" }),
      makeKey({ id: "k-3", ownerId: "u-2", nodeId: "n-1", state: "active" }),
      makeKey({ id: "k-4", ownerId: "u-3", nodeId: "n-2", state: "disabled" }),
    ]);

    expect(stats.get("n-1")).toEqual({ total: 3, active: 2, owners: 2 });
    expect(stats.get("n-2")).toEqual({ total: 1, active: 0, owners: 1 });
    expect(stats.get("missing") ?? NO_KEYS).toEqual(NO_KEYS);
  });
});

describe("NodeCard embedded & NodeDetailDialog", () => {
  it("renders Card wrapper by default and omits outer Card when embedded", () => {
    const node = makeNode();
    const commonProps = {
      node,
      route: null,
      routeLoadFailed: false,
      keyStats: { total: 2, active: 2, owners: 1 },
      checkResults: [],
      checksConfigured: false,
      onSetChecks: () => undefined,
      onToggleIpv6Stub: () => undefined,
      onSavePublicEndpoint: () => Promise.resolve(),
      onSaveGenerator: () => Promise.resolve(),
      onSaveDeviceRules: () => Promise.resolve(),
      onToggle: () => undefined,
      onReconcile: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onUpdateAgent: () => undefined,
      onSetCapacity: () => undefined,
      onOpenTopology: () => undefined,
    };

    const standaloneHtml = renderToStaticMarkup(
      <TooltipProvider>
        <NodeCard {...commonProps} />
      </TooltipProvider>,
    );
    expect(standaloneHtml).toContain('id="node-n-detail-1"');
    expect(standaloneHtml).toContain("rounded-xl border bg-card");

    const embeddedHtml = renderToStaticMarkup(
      <TooltipProvider>
        <NodeCard {...commonProps} embedded />
      </TooltipProvider>,
    );
    expect(embeddedHtml).toContain('id="node-n-detail-1"');
    expect(embeddedHtml).toContain("Frankfurt-1");
    expect(embeddedHtml).toContain("https://de1.example.test:4001");
    expect(embeddedHtml).not.toContain("rounded-xl border bg-card");
  });

  it("renders closed NodeDetailDialog as empty when node is null and does not throw when open", () => {
    const closedHtml = renderToStaticMarkup(
      <TooltipProvider>
        <NodeDetailDialog
          node={null}
          onClose={() => undefined}
          keys={[]}
          infra={emptyInfra}
          serviceChecks={emptyChecks}
          reachability={emptyReachability}
          action={() => Promise.resolve(true)}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
        />
      </TooltipProvider>,
    );
    expect(closedHtml).toBe("");

    expect(() =>
      renderToStaticMarkup(
        <TooltipProvider>
          <NodeDetailDialog
            node={makeNode()}
            onClose={() => undefined}
            keys={[makeKey()]}
            infra={emptyInfra}
            serviceChecks={emptyChecks}
            reachability={emptyReachability}
            action={() => Promise.resolve(true)}
            request={() => Promise.resolve({} as never)}
            reload={() => Promise.resolve()}
            onOpenTopology={() => undefined}
          />
        </TooltipProvider>,
      ),
    ).not.toThrow();
  });

  it("renders NodeDetailDialogBody embedded node card with service checks and capacity", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeDetailDialogBody
          node={makeNode()}
          keyStats={{ total: 1, active: 1, owners: 1 }}
          infra={emptyInfra}
          serviceChecks={emptyChecks}
          reachability={emptyReachability}
          action={() => Promise.resolve(true)}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
          onEdit={() => undefined}
          onDelete={() => undefined}
          onUpdateAgent={() => undefined}
          onSetCapacity={() => undefined}
          onOpenTopology={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(html).toContain('id="node-n-detail-1"');
    expect(html).not.toContain("rounded-xl border bg-card");
    expect(html).toContain("Frankfurt-1");
    expect(html).toContain("12 / 100");
    expect(html).toContain("YouTube");
  });
});
