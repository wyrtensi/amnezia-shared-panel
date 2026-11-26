import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    expect(embeddedHtml).not.toContain('id="node-n-detail-1"');
    expect(embeddedHtml).toMatch(/^<div class="flex flex-col gap-3">/);
    expect(embeddedHtml).toContain("Frankfurt-1");
    expect(embeddedHtml).toContain("https://de1.example.test:4001");
    expect(embeddedHtml).not.toContain("rounded-xl border bg-card");
  });

  it("renders bridge route as anchor by default and as button when onOpenBridge is provided", () => {
    const commonProps = {
      node: makeNode(),
      route: {
        bridgeId: "b-1",
        bridgeName: "Bridge MSK",
        entry: "203.0.113.5:30001",
        revision: 1,
      },
      routeLoadFailed: false,
      keyStats: NO_KEYS,
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

    const pageHtml = renderToStaticMarkup(
      <TooltipProvider>
        <NodeCard {...commonProps} />
      </TooltipProvider>,
    );
    expect(pageHtml).toContain('href="#bridge-b-1"');
    expect(pageHtml).toContain('href="/admin/policy?node=n-detail-1#node-routes"');

    const modalHtml = renderToStaticMarkup(
      <TooltipProvider>
        <NodeCard {...commonProps} embedded onOpenBridge={() => undefined} />
      </TooltipProvider>,
    );
    expect(modalHtml).not.toContain('href="#bridge-b-1"');
    expect(modalHtml).toContain("<button");
    expect(modalHtml).toContain("Bridge MSK");
    expect(modalHtml).toContain('href="/admin/policy?node=n-detail-1#node-routes"');
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

    expect(html).not.toContain('id="node-n-detail-1"');
    expect(html).not.toContain("rounded-xl border bg-card");
    expect(html).toContain("Frankfurt-1");
    expect(html).toContain("12 / 100");
    expect(html).toContain("YouTube");
  });

  it("guards parent Dialog against sub-dialog DismissableLayer/Escape closes and omits duplicate apiBaseUrl in DialogDescription", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./node-detail-dialog.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).toContain(
      "const hasSubDialog = editOpen || deleteOpen || updateAgentOpen || capacityOpen;",
    );
    expect(src).toContain("if (!next && !hasSubDialog) onClose();");
    expect(src).toContain("onInteractOutside={(e) => {");
    expect(src).toContain("onEscapeKeyDown={(e) => {");
    const descBlock = src.slice(
      src.indexOf("<DialogDescription"),
      src.indexOf("</DialogDescription>"),
    );
    expect(descBlock).not.toContain("node.apiBaseUrl");
    expect(descBlock).toContain('t("ov.map.openNode")');
  });
});
