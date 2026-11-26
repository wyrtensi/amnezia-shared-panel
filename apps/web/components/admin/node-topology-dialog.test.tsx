import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminNode } from "@/components/admin/admin-data";
import { TooltipProvider } from "@/components/ui/tooltip";
import { messages } from "@/lib/i18n/messages";
import {
  formatSubnetProximityWarning,
  NodeTopologyDialog,
  NodeTopologyDialogBody,
  parseOptionalRoutingTableId,
  summarizeNodeEgress,
} from "./node-topology-dialog";

const tRu = (key: string, vars?: Record<string, string | number>): string => {
  const dict = messages.ru as Record<string, string>;
  const template = dict[key];
  if (template === undefined) return key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
};

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
        ipv4: "198.51.100.55",
        cidr: "198.51.100.55/24",
        interfaceName: "eth1",
        detectedGatewayIpv4: "198.51.100.1",
        detectedRuleTable: 201,
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
    {
      id: "ip-2",
      nodeId: "n-1",
      ipv4: "203.0.113.99",
      label: "NL-Exit-2",
      interfaceName: "eth1",
      gatewayIpv4: null,
      routingTableId: 201,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: null,
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      allowAsEntry: false,
      enabled: true,
      hostState: "missing_ip",
      hostDetail: null,
      observedSubnetCidr: "203.0.113.0/24",
      detectedGatewayIpv4: "203.0.113.1",
      txBytes: "0",
      txPackets: "0",
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
      totalExitCount: 2,
      unhealthyExitCount: 1,
      hasIssue: true,
    });
    expect(
      summarizeNodeEgress(
        makeNode({
          egressIps: makeNode().egressIps?.slice(0, 1),
        }),
      ),
    ).toMatchObject({
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

  it("renders Host IPs onboarding, exit usage/default action, variant flow & inline exit select, and quick-pick chips", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeTopologyDialogBody
          node={makeNode()}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
          onSavePublicEndpoint={() => Promise.resolve()}
        />
      </TooltipProvider>,
    );

    // Host IPs Onboarding renders all discovered IPv4s (entry, exit, unassigned)
    expect(html).toContain(tRu("egress.hostIpsTitle"));
    expect(html).toContain("192.0.2.10/24");
    expect(html).toContain("198.51.100.20/24");
    expect(html).toContain("198.51.100.55/24");
    expect(html).toContain(tRu("egress.hostIpRole.entry"));
    expect(html).toContain(tRu("egress.hostIpRole.exit"));
    expect(html).toContain(tRu("egress.hostIpRole.unassigned"));
    expect(html).toContain(tRu("egress.quickAddExit"));
    expect(html).toContain(tRu("egress.quickAddEntry"));
    expect(html).toContain(tRu("egress.quickAddBoth"));

    // Exit IP rows show usedByVariants / unusedExit and makeDefault for non-default exits
    expect(html).toContain(tRu("egress.usedByVariants", { names: "Amsterdam" }));
    expect(html).toContain(tRu("egress.unusedExit"));
    expect(html).toContain(tRu("egress.defaultExitBadge"));
    expect(html).toContain(tRu("egress.makeDefault"));

    // Variant row shows Entry -> Exit flow, exit health dot, inline exit selector, and quick-pick chips
    expect(html).toContain("bg-success");
    expect(html).toContain(tRu("egress.inlineExitLabel"));
    expect(html).toContain(tRu("egress.pickHostIp"));
  });

  it("hides quick-add buttons when a host IP is already both entry and exit", () => {
    const base = makeNode();
    const baseEndpoint = base.publicEndpoints?.[0];
    if (!baseEndpoint) {
      throw new Error("Expected fixture endpoint");
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeTopologyDialogBody
          node={makeNode({
            hostNetworkReport: {
              daemonVersion: "1.0.0",
              observedMode: "routed",
              egressState: "routed_active",
              bridgeName: "br-awg-egress",
              bridgePresent: true,
              tunnelSubnetConflict: false,
              ipv4Addresses: [
                {
                  ipv4: "198.51.100.20",
                  cidr: "198.51.100.20/24",
                  interfaceName: "eth0",
                },
              ],
              exits: [],
              observedAt: "2026-11-25T10:00:00.000Z",
            },
            publicEndpoints: [
              {
                ...baseEndpoint,
                publicAddress: "198.51.100.20",
              },
            ],
          })}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
          onSavePublicEndpoint={() => Promise.resolve()}
        />
      </TooltipProvider>,
    );

    expect(html).toContain(tRu("egress.hostIpRole.both"));
    expect(html).not.toContain(tRu("egress.quickAddExit"));
    expect(html).not.toContain(tRu("egress.quickAddEntry"));
    expect(html).not.toContain(tRu("egress.quickAddBoth"));
  });

  it("marks targeted exit IP with data-focused and highlight ring when initialFocus targets an exit", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeTopologyDialogBody
          node={makeNode()}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
          onSavePublicEndpoint={() => Promise.resolve()}
          initialFocus={{ kind: "exit", id: "ip-2" }}
        />
      </TooltipProvider>,
    );

    expect(html).toContain('data-topology-section="exits"');
    expect(html).toContain('data-topology-section="variants"');
    expect(html).toContain('data-topology-focus="exit:ip-2" data-focused="true"');
    expect(html).toContain("ring-2 ring-primary/70 border-primary/70 bg-primary/[0.06]");
    expect(html).not.toContain('data-topology-focus="exit:ip-1" data-focused="true"');
    expect(html).not.toContain('data-topology-focus="variant:ep-1" data-focused="true"');
  });

  it("marks targeted variant with data-focused and highlight ring when initialFocus targets a variant", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeTopologyDialogBody
          node={makeNode()}
          request={() => Promise.resolve({} as never)}
          reload={() => Promise.resolve()}
          onSavePublicEndpoint={() => Promise.resolve()}
          initialFocus={{ kind: "variant", id: "ep-1" }}
        />
      </TooltipProvider>,
    );

    expect(html).toContain('data-topology-focus="variant:ep-1" data-focused="true"');
    expect(html).toContain("ring-2 ring-primary/70 border-primary/70 bg-primary/[0.06]");
    expect(html).not.toContain('data-topology-focus="exit:ip-1" data-focused="true"');
    expect(html).not.toContain('data-topology-focus="exit:ip-2" data-focused="true"');
  });

  it("saves firewall policy via PATCH node without mode switching, omits entryName on quick-add, reloads in finally, and scans focus safely in rAF", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./node-topology-dialog.tsx", import.meta.url)),
      "utf8",
    );
    // H7: Save Policy calls PATCH /api/admin/nodes/:id instead of setNodeEgressMode
    expect(src).toMatch(
      /runAction\("filters"[\s\S]{0,400}method:\s*"PATCH"[\s\S]{0,200}egressBlockSmtp:\s*blockSmtp[\s\S]{0,100}egressIsolatePrivate:\s*isolatePrivate/,
    );
    // M7: quick-entry and quick-both omit entryName and quick-both uses try/finally reload
    const quickEntryBlock = src.slice(
      src.indexOf("quick-entry:"),
      src.indexOf("quick-both:"),
    );
    expect(quickEntryBlock).not.toContain("entryName");
    const quickBothBlock = src.slice(
      src.indexOf("quick-both:"),
      src.indexOf("Section 3: Physical Exit IPs"),
    );
    expect(quickBothBlock).not.toContain("entryName");
    expect(quickBothBlock).toMatch(/try\s*\{[\s\S]*finally\s*\{\s*await reload\(\);/);
    // UI-3: safe rAF focus lookup + cleanup
    expect(src).toContain("requestAnimationFrame(");
    expect(src).toContain("cancelAnimationFrame(raf)");
    expect(src).toContain("candidate.dataset.topologyFocus === targetKey");
  });

  it("validates optional routing table IDs strictly (blank -> null, 200..219 -> number, invalid -> error)", () => {
    expect(parseOptionalRoutingTableId("")).toEqual({ ok: true, value: null });
    expect(parseOptionalRoutingTableId("   ")).toEqual({ ok: true, value: null });
    expect(parseOptionalRoutingTableId("200")).toEqual({ ok: true, value: 200 });
    expect(parseOptionalRoutingTableId(" 219 ")).toEqual({ ok: true, value: 219 });
    expect(parseOptionalRoutingTableId("199")).toEqual({ ok: false });
    expect(parseOptionalRoutingTableId("220")).toEqual({ ok: false });
    expect(parseOptionalRoutingTableId("20a")).toEqual({ ok: false });
    expect(parseOptionalRoutingTableId("205.5")).toEqual({ ok: false });
    expect(parseOptionalRoutingTableId("-1")).toEqual({ ok: false });
  });

  it("shows mode-switch guard reason and daemon version mismatch warning", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <NodeTopologyDialogBody
          node={makeNode({
            egressMode: "masquerade",
            agentVersion: "1.2.0",
            egressDaemonVersion: "1.1.0",
            egressDaemonState: "unavailable",
          })}
          request={() => Promise.resolve(undefined as never)}
          reload={() => Promise.resolve()}
          onSavePublicEndpoint={() => Promise.resolve()}
        />
      </TooltipProvider>,
    );

    expect(html).toContain(tRu("egress.switchBlockedUnavailable"));
    expect(html).toContain(tRu("nodes.egressDaemonVersionMismatch"));
    expect(html).toContain(tRu("egress.filtersRoutedOnlyHint"));
    expect(html).toContain(tRu("egress.modeSummaryMasquerade"));
    expect(html).toContain(tRu("egress.routingTableHint"));
    const src = readFileSync(
      fileURLToPath(new URL("./node-topology-dialog.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("egress.modeExplainHint");
    expect(src).toContain("egress.isolatePrivateHint");
    expect(src).toContain("egress.sectionExitsHint");
    expect(src).toContain("egress.sectionVariantsHint");
    expect(src).toContain("egress.amneziaDnsDnatHint");
    expect(src).toContain("egress.allowAsEntryHint");
    expect(src).not.toContain("nodes.statusEnabled");
  });

  it("localizes subnet proximity warnings into Russian and preserves unknown messages", () => {
    expect(
      formatSubnetProximityWarning(
        "Exit IP shares subnet 203.0.113.0/24 with Entry IP 203.0.113.11",
        tRu,
      ),
    ).toBe(
      tRu("egress.subnetWarningShared", {
        cidr: "203.0.113.0/24",
        entry: "203.0.113.11",
      }),
    );
    expect(
      formatSubnetProximityWarning(
        "Exit IP is in the same /24 subnet as Entry IP 198.51.100.10",
        tRu,
      ),
    ).toBe(tRu("egress.subnetWarningSame24", { entry: "198.51.100.10" }));
    expect(formatSubnetProximityWarning("Custom warning", tRu)).toBe("Custom warning");
  });
});
