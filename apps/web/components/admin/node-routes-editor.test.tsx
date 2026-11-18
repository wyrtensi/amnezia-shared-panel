import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultKeyNameDisplay, type NodeBridgeRoute } from "@amnezia/contracts";
import { messages } from "@/lib/i18n/messages";
import type { KeyView } from "@/lib/types";
import { CandidateRoute, operatorRegistration, saveRouteAssignment } from "./node-routes-editor";

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
  setupCommands: { dryRun: "setup --dry-run", install: "setup", checkTls: "setup --check-tls", remove: "remove" },
};

const copy = messages.ru;
const confirmLabel = "Соединение через этот маршрут проверено";
const activateLabel = "Подтвердить и активировать";
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
    expect(html).toContain(route.setupCommands?.checkTls);
    expect(html).toContain(`/etc/amnezia-node/frp/${route.bridgeId}/`);
    expect(html.indexOf(copy["bridge.nodeSetup"])).toBeLessThan(html.indexOf("<details"));
    expect(html).not.toContain(copy["bridge.verifyProbe"]);
    expect(html).not.toContain(confirmLabel);
    expect(html).not.toContain(activateLabel);
    expect(html).not.toContain(copy["bridge.activate"]);
    expect(html).toContain(copy["bridge.cancelDraft"]);
  });

  it("offers explicit confirmation before activation and keeps test tools collapsed", () => {
    const html = render();
    const details = html.match(/<details[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(html).toContain(confirmLabel);
    expect(html).toMatch(new RegExp('<button[^>]*disabled=""[^>]*>' + activateLabel + "</button>"));
    expect(html.indexOf(confirmLabel)).toBeLessThan(html.indexOf("<details"));
    expect(details).toBeDefined();
    expect(details?.split(">")[0]).not.toContain(" open");
    expect(details).toContain(copy["bridge.verifyProbe"]);
    expect(details).toContain(copy["bridge.testConfigNoKey"]);
    expect(details).toContain(copy["bridge.marker"]);
  });

  it("activates already verified routes without a second confirmation", () => {
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

describe("saveRouteAssignment", () => {
  const verifyPath = `/api/admin/vpn-bridge-routes/${route.id}/verify`;
  const nodePath = `/api/admin/nodes/${route.nodeId}`;

  it("awaits operator evidence before activating with the previously loaded revision", async () => {
    const verification = Promise.withResolvers<void>();
    const request = vi.fn()
      .mockReturnValueOnce(verification.promise)
      .mockResolvedValueOnce({ vpnEndpoint: { changed: true } });

    const assignment = saveRouteAssignment(request, route.nodeId, route.id, 17, "test-marker");
    expect(request).toHaveBeenCalledExactlyOnceWith(verifyPath, {
      method: "POST",
      body: JSON.stringify({
        method: "operator",
        registrationMarker: "test-marker",
        confirmHandshakeAndHttp: true,
      }),
    });

    verification.resolve();
    await assignment;
    expect(request).toHaveBeenNthCalledWith(2, nodePath, {
      method: "PATCH",
      body: JSON.stringify({ vpnBridgeRouteId: route.id, expectedVpnEndpointRevision: 17 }),
    });
  });

  it("keeps the assignment when the API rejects verification", async () => {
    const error = new Error("Registration changed");
    const request = vi.fn().mockRejectedValueOnce(error);
    await expect(saveRouteAssignment(request, route.nodeId, route.id, 17, "old-marker")).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith(nodePath, expect.anything());
  });

  it("activates an already verified route without recording operator evidence", async () => {
    const request = vi.fn().mockResolvedValueOnce({ vpnEndpoint: { changed: true } });
    await saveRouteAssignment(request, route.nodeId, route.id, 17);
    expect(request).toHaveBeenCalledExactlyOnceWith(nodePath, {
      method: "PATCH",
      body: JSON.stringify({ vpnBridgeRouteId: route.id, expectedVpnEndpointRevision: 17 }),
    });
  });
});

describe("operatorRegistration", () => {
  it("uses the current registration if the operator has no downloaded test", () => {
    expect(operatorRegistration(route.registration, undefined, null)).toMatchObject({
      marker: "test-marker",
      markerMatches: true,
    });
  });

  it.each(["old-marker", null])("keeps an outdated download (%s) separate from fresh evidence", (downloadedMarker) => {
    expect(operatorRegistration(route.registration, downloadedMarker, null)).toMatchObject({
      marker: downloadedMarker ?? "",
      markerMatches: false,
      testNeedsRefresh: true,
    });
    expect(operatorRegistration(route.registration, downloadedMarker, "test-marker")).toMatchObject({
      marker: "test-marker",
      markerMatches: true,
    });
  });
});
