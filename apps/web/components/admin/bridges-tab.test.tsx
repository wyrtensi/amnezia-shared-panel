import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bridge, NodeBridgeRoute } from "@amnezia/contracts";
import { messages, type Lang } from "@/lib/i18n/messages";
import { BridgeCardView } from "./bridges-tab";
import { BridgeRouteFacts } from "./bridge-route-view";

const tFor =
  (lang: Lang) =>
  (key: string, vars?: Record<string, string | number>): string =>
    ((messages[lang] as Record<string, string>)[key] ?? key).replace(
      /\{(\w+)\}/g,
      (match, name: string) => (vars && name in vars ? String(vars[name]) : match),
    );

const NODE = "00000000-0000-4000-8000-0000000000aa";
const bridge: Bridge = {
  id: "00000000-0000-4000-8000-0000000000b1",
  name: "Amsterdam bridge",
  publicIpv4: "198.51.100.10",
  controlTcpPort: 7000,
  udpPortStart: 41000,
  udpPortEnd: 41031,
  capacity: 32,
  heldPorts: 2,
  managementStatus: "pending_enrollment",
  lastObservedAt: null,
  routes: [
    { id: "r1", nodeId: NODE, nodeName: "Node A", publicUdpPort: 41000, state: "active" },
    { id: "r2", nodeId: NODE, nodeName: "Node B", publicUdpPort: 41001, state: "draft" },
  ],
  setupCommands: {
    install: "sudo sh /opt/amnezia-bridge/install-frps.sh --bridge-id x",
    dryRun: "sudo sh /opt/amnezia-bridge/install-frps.sh --bridge-id x --dry-run",
  },
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
};

const render = (value: Bridge, lang: Lang = "en") =>
  renderToStaticMarkup(
    <BridgeCardView
      bridge={value}
      t={tFor(lang)}
      lang={lang}
      onRename={() => undefined}
      onDelete={() => undefined}
    />,
  );

describe("BridgeCardView", () => {
  it("shows address, ports, used vs free, status and each route", () => {
    const html = render(bridge);
    expect(html).toContain("Amsterdam bridge");
    expect(html).toContain("198.51.100.10");
    expect(html).toContain("7000/tcp");
    expect(html).toContain("41000–41031/udp");
    expect(html).toContain("2 of 32 used");
    expect(html).toContain("30 free");
    expect(html).toContain("Pending enrollment");
    expect(html).toContain("Node A");
    expect(html).toContain(":41001");
    expect(html).toContain("Draft");
  });

  it("links every route to its policy editor", () => {
    const html = render(bridge);
    expect(html.match(/href="\/admin\/policy\?node=[^"]+#node-routes"/g)).toHaveLength(2);
  });

  it("offers the install and dry-run commands with copy buttons", () => {
    const html = render(bridge);
    expect(html).toContain("install-frps.sh --bridge-id x --dry-run");
    expect(html).toContain("install-frps.sh --bridge-id x</code>");
    // CommandBlock reads the language from context, which is Russian without
    // a provider (the app's first-paint default).
    expect(html.match(/aria-label="Копировать: /g)).toHaveLength(2);
  });

  it("renders in Russian and without setup commands or routes", () => {
    const html = render({ ...bridge, routes: [], heldPorts: 0, setupCommands: undefined }, "ru");
    expect(html).toContain("Ожидает подключения");
    expect(html).toContain("Маршрутов нет");
    expect(html).not.toContain("install-frps.sh");
  });
});

describe("BridgeRouteFacts", () => {
  const NOW = Date.parse("2026-11-13T12:00:00.000Z");
  const route = (overrides: Partial<NodeBridgeRoute> = {}): NodeBridgeRoute => ({
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: NODE,
    bridgeId: bridge.id,
    publicUdpPort: 41001,
    state: "draft",
    frpProxyName: "awg-route-x",
    observedOnline: true,
    observedRegistrationMarker: "marker-1",
    observedAt: new Date(NOW - 5_000).toISOString(),
    verificationMethod: null,
    verifiedRegistrationMarker: null,
    verifiedAt: null,
    verificationResult: null,
    verificationError: null,
    activatedAt: null,
    retiringSince: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    bridgeName: "Amsterdam bridge",
    bridgePublicIpv4: "198.51.100.10",
    bridgeControlTcpPort: 7000,
    bridgeManagementStatus: "ok",
    bridgeLastObservedAt: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  });
  const view = (value: NodeBridgeRoute) =>
    renderToStaticMarkup(<BridgeRouteFacts route={value} t={tFor("en")} lang="en" now={NOW} />);

  it("shows the public entry, local target, marker and an online registration", () => {
    const html = view(route());
    expect(html).toContain("198.51.100.10:41001/udp");
    expect(html).toContain("127.0.0.1:51890/udp");
    expect(html).toContain("marker-1");
    expect(html).toContain("Online");
    expect(html).toContain("Not verified");
  });

  it("shows a stale observation as Unknown, never as online", () => {
    const old = new Date(NOW - 3_600_000).toISOString();
    const html = view(route({ observedAt: old, bridgeLastObservedAt: old }));
    expect(html).not.toContain(">Online<");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("marker-1");
  });

  it("shows a failed verification with its code and a valid one as verified", () => {
    const failed = view(
      route({
        verificationResult: "failure",
        verificationError: "AWG_HANDSHAKE_FAILED",
        verificationMethod: "probe",
        verifiedAt: new Date(NOW - 1_000).toISOString(),
      }),
    );
    expect(failed).toContain("Failed");
    expect(failed).toContain("AWG_HANDSHAKE_FAILED");
    const ok = view(
      route({
        verificationResult: "success",
        verificationMethod: "operator",
        verifiedRegistrationMarker: "marker-1",
        verifiedAt: new Date(NOW - 1_000).toISOString(),
      }),
    );
    expect(ok).toContain("Verified");
  });

  it("labels retiring and active states", () => {
    expect(view(route({ state: "retiring" }))).toContain("Retiring");
    expect(view(route({ state: "active" }))).toContain("Active");
  });
});
