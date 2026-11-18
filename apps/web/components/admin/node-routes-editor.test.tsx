import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultKeyNameDisplay, type NodeBridgeRoute } from "@amnezia/contracts";
import { messages } from "@/lib/i18n/messages";
import type { KeyView } from "@/lib/types";
import { CandidateRoute } from "./node-routes-editor";

const observedAt = "2026-11-18T12:00:00.000Z";
const route: NodeBridgeRoute = {
  id: "00000000-0000-4000-8000-000000000001",
  nodeId: "00000000-0000-4000-8000-000000000002",
  bridgeId: "00000000-0000-4000-8000-000000000003",
  publicUdpPort: 41001,
  state: "draft",
  frpProxyName: "awg-test",
  observedOnline: true,
  observedRegistrationMarker: "test-marker",
  observedAt,
  verificationMethod: null,
  verifiedRegistrationMarker: null,
  verifiedAt: null,
  verificationResult: null,
  verificationError: null,
  activatedAt: null,
  retiringSince: null,
  createdAt: observedAt,
  bridgeName: "Test bridge",
  bridgePublicIpv4: "198.51.100.10",
  bridgeControlTcpPort: 7000,
  bridgeManagementStatus: "ok",
  bridgeLastObservedAt: observedAt,
  registration: { status: "online", marker: "test-marker", observedAt },
  verification: { kind: "candidate", status: "none", method: null, verifiedAt: null, error: null },
  setupCommands: { dryRun: "setup --dry-run", install: "setup", remove: "remove" },
};

const copy = messages.ru;
function render(overrides: Partial<NodeBridgeRoute> = {}, testKeys: KeyView[] = []) {
  return renderToStaticMarkup(
    <CandidateRoute
      route={{ ...route, ...overrides }}
      bridge={null}
      testKeys={testKeys}
      busy={null}
      loading={false}
      request={vi.fn()}
      onRun={vi.fn()}
      onActivate={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
}

describe("CandidateRoute", () => {
  it.each([
    { status: "offline", marker: null, observedAt },
    { status: "unknown", marker: null, observedAt },
    { status: "online", marker: null, observedAt },
  ] as const)("leads with setup when $status has no current registration marker", (registration) => {
    const html = render({ registration });
    expect(html).toContain(route.setupCommands?.dryRun);
    expect(html.indexOf(copy["bridge.nodeSetup"])).toBeLessThan(html.indexOf("<details"));
    expect(html).not.toContain(copy["bridge.verifyProbe"]);
    expect(html).not.toContain(copy["bridge.operatorSubmit"]);
    expect(html).not.toContain(copy["bridge.activate"]);
    expect(html).toContain(copy["bridge.cancelDraft"]);
  });

  it("offers the probe and manual check online and waits for valid evidence before activation", () => {
    const html = render();
    expect(html).toContain(copy["bridge.verifyProbe"]);
    expect(html).toContain(copy["bridge.testConfigNoKey"]);
    expect(html).toContain(copy["bridge.operatorSubmit"]);
    expect(html).toMatch(new RegExp('<button[^>]*disabled=""[^>]*>' + copy["bridge.activate"] + "</button>"));

    const verified = render({
      verification: { kind: "candidate", status: "valid", method: "operator", verifiedAt: observedAt, error: null },
    });
    const activation = verified.match(new RegExp("<button[^>]*>" + copy["bridge.activate"] + "</button>"));
    expect(activation?.[0]).toBeDefined();
    expect(activation?.[0]).not.toContain(' disabled=""');
  });

  it("offers the test download through a labeled selector and explains peer reuse", () => {
    const html = render({}, [{
      id: "00000000-0000-4000-8000-000000000004",
      nodeId: route.nodeId,
      nodeName: "Test node",
      state: "active",
      protocol: "awg3",
      deviceType: "desktop",
      nameDisplay: defaultKeyNameDisplay,
      routeProfile: "full_tunnel",
      createdAt: observedAt,
    }]);
    expect(html).toContain('role="combobox"');
    expect(html).toContain(`aria-label="${copy["bridge.testKey"]}"`);
    expect(html).toContain(copy["bridge.testDownload"]);
    expect(html).toContain(copy["bridge.testKeyIsolationHint"]);
  });

  it("keeps release available for a retiring route without a registration", () => {
    const html = render({
      state: "retiring",
      registration: { status: "offline", marker: null, observedAt },
    });
    expect(html).toContain(copy["bridge.releaseRetiring"]);
  });
});
