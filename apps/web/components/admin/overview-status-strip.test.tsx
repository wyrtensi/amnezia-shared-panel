import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminNode } from "@/components/admin/admin-data";
import { messages, type MessageKey } from "@/lib/i18n/messages";
import {
  OverviewAttentionShelf,
  OverviewStatusStrip,
  summarizeFleetHealth,
} from "./overview-status-strip";

const t = (key: MessageKey, vars?: Record<string, string | number>): string => {
  let out: string = messages.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
};

const baseNode = (over: Partial<AdminNode> = {}): AdminNode => ({
  id: "n-1",
  name: "de-01",
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
  ...over,
});

describe("overview status strip & attention shelf", () => {
  it("reports healthy green state with hidden attention shelf when fleet is clean", () => {
    const summary = summarizeFleetHealth({
      overview: {
        pendingQuotaRequests: 0,
        activeKeys: 5,
        enabledNodes: 1,
        nodes: { total: 1, enabled: 1, healthy: 1 },
      },
      nodes: [baseNode({ egressMode: "routed" })],
      reachability: null,
      serviceChecks: [],
      pendingQuotaCount: 0,
    });
    expect(summary.routedNodes).toBe(1);
    expect(summary.attention).toEqual([]);

    const stripHtml = renderToStaticMarkup(
      <OverviewStatusStrip summary={summary} t={t} />,
    );
    expect(stripHtml).toContain(messages.en["ov.pulse.allGood"]);
    expect(stripHtml).toContain("Multi-exit: 1");

    const shelfHtml = renderToStaticMarkup(
      <OverviewAttentionShelf
        items={summary.attention}
        adoptingId={null}
        onAdoptDrift={() => undefined}
        t={t}
      />,
    );
    expect(shelfHtml).toBe("");
  });

  it("collects modeDrift, missing_ip exits, probe incidents, and renders Adopt host mode button", () => {
    const summary = summarizeFleetHealth({
      overview: {
        pendingQuotaRequests: 2,
        activeKeys: 5,
        enabledNodes: 1,
        nodes: { total: 1, enabled: 1, healthy: 1 },
      },
      nodes: [
        baseNode({
          egressMode: "masquerade",
          modeDrift: true,
          hostNetworkReport: {
            daemonVersion: "1.0.0",
            observedMode: "routed",
            egressState: "routed_active",
            bridgeName: "br-awg-egress",
            bridgePresent: true,
            tunnelSubnetConflict: false,
            ipv4Addresses: [],
            exits: [],
            observedAt: "2026-11-25T10:00:00.000Z",
          },
          egressIps: [
            {
              id: "ip-1",
              nodeId: "n-1",
              ipv4: "198.51.100.20",
              label: "DE-2",
              interfaceName: "eth0",
              gatewayIpv4: null,
              routingTableId: 200,
              dnsPrimary: "1.1.1.1",
              dnsSecondary: null,
              amneziaDnsDnat: true,
              enforceDnsDnat: false,
              allowAsEntry: false,
              enabled: true,
              hostState: "missing_ip",
              hostDetail: "not found on eth0",
              observedSubnetCidr: null,
              detectedGatewayIpv4: null,
              txBytes: "0",
              txPackets: "0",
              hostObservedAt: null,
            },
          ],
        }),
      ],
      reachability: null,
      serviceChecks: [],
      pendingQuotaCount: 2,
    });
    expect(summary.egressIssueCount).toBe(1);
    expect(summary.attention.map((a) => a.id)).toEqual([
      "drift:n-1",
      "exit:n-1:ip-1",
      "quota:pending",
    ]);

    const shelfHtml = renderToStaticMarkup(
      <OverviewAttentionShelf
        items={summary.attention}
        adoptingId={null}
        onAdoptDrift={() => undefined}
        t={t}
      />,
    );
    expect(shelfHtml).toContain("Needs attention");
    expect(shelfHtml).toContain("Adopt host mode");
    expect(shelfHtml).toContain("198.51.100.20");
  });
});
