import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bridge, NodeBridgeRoute } from "@amnezia/contracts";
import { messages, type Lang } from "@/lib/i18n/messages";
import { formatDateTime } from "@/lib/format";
import { BridgeCardView } from "./bridges-tab";
import { OverviewBridgesBlock } from "./overview-bridges";
import { BridgeRouteFacts } from "./bridge-route-view";
import { agentUpdateTone } from "@/lib/bridge-ui";

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
  managementStatus: "stale",
  lastObservedAt: "2026-11-13T09:00:00.000Z",
  routes: [
    {
      id: "r1",
      nodeId: NODE,
      nodeName: "Node A",
      publicUdpPort: 41000,
      state: "active",
      // The bridge is stale, so the API reads its routes as unknown.
      registration: { status: "unknown", marker: null, observedAt: "2026-11-13T09:00:00.000Z" },
      verification: { kind: "awg_path", status: "unknown", checkedAt: null },
    },
    {
      id: "r2",
      nodeId: NODE,
      nodeName: "Node B",
      publicUdpPort: 41001,
      state: "draft",
      registration: { status: "unknown", marker: null, observedAt: null },
      verification: { kind: "candidate", status: "none", method: null, verifiedAt: null, error: null },
    },
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
    expect(html).toContain("No recent report");
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

  it("shows a stale bridge's routes as unknown, apart from management status", () => {
    const html = render(bridge);
    expect(html).toContain("Not enrolled");
    expect(html).toContain("No recent report");
    // Both routes read Unknown: never offline, never verified.
    expect(html.match(/frpc: Unknown/g)).toHaveLength(2);
    expect(html).toContain("AWG path: No current data");
    expect(html).toContain("AWG path: Not verified");
    expect(html).not.toContain("frpc: Not registered");
    expect(html).not.toContain("frpc: Online");
  });

  it("renders the API's evidence for a healthy bridge, with the evidence time visible", () => {
    const html = render({
      ...bridge,
      managementStatus: "ok",
      routes: [
        {
          ...bridge.routes[0]!,
          registration: { status: "online", marker: "m1", observedAt: "2026-11-13T10:00:00.000Z" },
          verification: { kind: "awg_path", status: "ok", checkedAt: "2026-11-13T10:05:00.000Z" },
        },
        {
          ...bridge.routes[1]!,
          registration: { status: "online", marker: "m2", observedAt: "2026-11-13T10:00:00.000Z" },
          verification: {
            kind: "candidate",
            status: "expired",
            method: "probe",
            verifiedAt: "2026-11-13T08:00:00.000Z",
            error: null,
          },
        },
      ],
    });
    expect(html.match(/frpc: Online/g)).toHaveLength(2);
    expect(html).toContain("AWG path: Working");
    expect(html).toContain("AWG path: Expired, verify again");
    // The times are rendered as text, not only in a title attribute.
    expect(html).toContain(formatDateTime("2026-11-13T10:05:00.000Z", "en"));
    expect(html).toContain(formatDateTime("2026-11-13T08:00:00.000Z", "en"));
  });

  it("shows agent and frps state of an enrolled bridge, never a credential", () => {
    const html = render({
      ...bridge,
      managementStatus: "down",
      lastObservedAt: "2026-11-13T09:00:00.000Z",
      management: {
        apiUrl: "http://host.docker.internal:17600",
        enrolled: true,
        enrolledAt: "2026-11-13T08:00:00.000Z",
        agentVersion: "0.1.0",
        agentApiVersion: 1,
        agentCapabilities: ["status.v1"],
        frpsVersion: "0.72.0",
        frpsReachable: true,
        lastErrorCode: "AGENT_TIMEOUT",
        lastPollAttemptAt: "2026-11-13T09:05:00.000Z",
      },
    });
    expect(html).toContain("0.1.0");
    expect(html).toContain("0.72.0, reachable");
    expect(html).toContain("AGENT_TIMEOUT");
    expect(html).toContain("Last successful poll");
    expect(html).toContain("Last poll attempt");
    expect(html).not.toContain("Not enrolled");
    expect(html).toContain("Unreachable");
  });

  it("says whether the setup command carries an approved agent image", () => {
    const image = `ghcr.io/o/r/bridge-agent@sha256:${"a".repeat(64)}`;
    const none = render({ ...bridge, setupCommands: { ...bridge.setupCommands!, agentImage: null } });
    expect(none).toContain("No approved bridge-agent image is available yet");
    const has = render({ ...bridge, setupCommands: { ...bridge.setupCommands!, agentImage: image } });
    expect(has).toContain("already carries the approved bridge-agent image");
    expect(has).toContain(image);
    expect(has).not.toContain("No approved bridge-agent image");
  });

  it("renders in Russian and without setup commands or routes", () => {
    const html = render({ ...bridge, routes: [], heldPorts: 0, setupCommands: undefined }, "ru");
    expect(html).toContain("Нет свежих данных");
    expect(html).toContain("Маршрутов нет");
    expect(html).not.toContain("install-frps.sh");
  });
});

describe("BridgeCardView agent update", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const operation = {
    operationId: "00000000-0000-4000-8000-0000000000c1",
    state: "succeeded" as const,
    requestedDigest: DIGEST,
    requestedVersion: "0.2.0",
    fromVersion: "0.1.0",
    requestedAt: "2026-11-13T10:00:00.000Z",
    sentAt: "2026-11-13T10:00:01.000Z",
    acknowledgedAt: "2026-11-13T10:00:05.000Z",
    lastCheckedAt: "2026-11-13T10:03:00.000Z",
    notAfter: "2026-11-13T10:02:00.000Z",
    acknowledgementOverdueSince: null,
    contactLostSince: null,
    errorCode: null,
    result: { finishedAt: "2026-11-13T10:03:00.000Z", errorCode: null },
  };
  const enrolled = (agentUpdate: Bridge["agentUpdate"]): Bridge => ({
    ...bridge,
    managementStatus: "ok",
    management: {
      apiUrl: "http://host.docker.internal:17600",
      enrolled: true,
      enrolledAt: "2026-11-13T08:00:00.000Z",
      agentVersion: "0.1.0",
      agentApiVersion: 1,
      agentCapabilities: ["status.v1", "update.v1"],
      frpsVersion: "0.72.0",
      frpsReachable: true,
      lastErrorCode: null,
      lastPollAttemptAt: "2026-11-13T09:05:00.000Z",
    },
    agentUpdate,
  });
  const offered = {
    image: `ghcr.io/o/r/bridge-agent@${DIGEST}`,
    repository: "ghcr.io/o/r/bridge-agent",
    version: "0.2.0",
    digest: DIGEST,
  };
  const renderWithUpdate = (value: Bridge, lang: Lang = "en") =>
    renderToStaticMarkup(
      <BridgeCardView
        bridge={value}
        t={tFor(lang)}
        lang={lang}
        onRename={() => undefined}
        onDelete={() => undefined}
        onUpdateAgent={() => undefined}
      />,
    );

  it("shows installed version, the offered image and the last result", () => {
    const html = renderWithUpdate(
      enrolled({ updateSupported: true, offered, operation }),
    );
    expect(html).toContain("Agent update");
    expect(html).toContain("Installed");
    expect(html).toContain("0.2.0");
    expect(html).toContain("updated");
    expect(html).toContain(formatDateTime("2026-11-13T10:03:00.000Z", "en"));
    expect(html).toContain("Update agent");
  });

  it("names a pickup timeout and tells the admin it is not retried", () => {
    const html = renderWithUpdate(
      enrolled({
        updateSupported: true,
        offered,
        operation: {
          ...operation,
          state: "pickup_timeout",
          errorCode: "UPDATE_NOT_ACKNOWLEDGED",
        },
      }),
    );
    expect(html).toContain("expired, not started");
    expect(html).toContain("will not be applied");
    expect(html).toContain("not retried automatically");
    expect(html).toContain("UPDATE_NOT_ACKNOWLEDGED");
  });

  it("shows lost contact as an observation on a running update, not a failure", () => {
    const html = renderWithUpdate(
      enrolled({
        updateSupported: true,
        offered,
        operation: {
          ...operation,
          state: "running",
          contactLostSince: "2026-11-13T10:01:00.000Z",
          result: null,
        },
      }),
    );
    expect(html).toContain("running");
    expect(html).toContain("Management contact lost since");
    expect(html).not.toContain("failed");
  });

  it("words lost contact differently before pickup and during replacement", () => {
    const lost = (state: "sent" | "running") =>
      renderWithUpdate(
        enrolled({
          updateSupported: true,
          offered,
          operation: { ...operation, state, contactLostSince: "2026-11-13T10:01:00.000Z", result: null },
        }),
      );
    expect(lost("running")).toContain("expected while the agent is replaced");
    const before = lost("sent");
    expect(before).toContain("before the host acknowledged the request");
    expect(before).not.toContain("expected while the agent is replaced");
  });

  it("shows an overdue acknowledgement as an observation on a still outstanding request", () => {
    const html = renderWithUpdate(
      enrolled({
        updateSupported: true,
        offered,
        operation: {
          ...operation,
          state: "sent",
          acknowledgementOverdueSince: "2026-11-13T10:05:00.000Z",
          result: null,
        },
      }),
    );
    expect(html).toContain("sent to the agent");
    expect(html).toContain("Acknowledgement overdue since");
    expect(html).toContain("stays outstanding");
  });

  it("separates a rollback from a failed rollback", () => {
    for (const [state, label] of [
      ["rolled_back", "rolled back"],
      ["rollback_failed", "rollback failed"],
    ] as const) {
      const html = renderWithUpdate(
        enrolled({
          updateSupported: true,
          offered,
          operation: { ...operation, state, errorCode: "HEALTH_GATE_FAILED" },
        }),
      );
      expect(html).toContain(label);
      expect(html).toContain("HEALTH_GATE_FAILED");
    }
    expect(agentUpdateTone("rolled_back")).toBe("warning");
    expect(agentUpdateTone("rollback_failed")).toBe("destructive");
    expect(agentUpdateTone("pickup_timeout")).toBe("warning");
    expect(agentUpdateTone("running")).toBe("outline");
  });

  it("says when nothing is offered or the agent cannot be updated, and hides the block when not enrolled", () => {
    const none = renderWithUpdate(enrolled({ updateSupported: false, offered: null, operation: null }));
    expect(none).toContain("no approved image");
    expect(none).toContain("never requested");
    expect(none).toContain("does not report update.v1");
    expect(renderWithUpdate(bridge)).not.toContain("Agent update");
  });

  it("renders in Russian", () => {
    const html = renderWithUpdate(enrolled({ updateSupported: true, offered, operation }), "ru");
    expect(html).toContain("Обновление агента");
    expect(html).toContain("Обновить агент");
  });
});

describe("BridgeRouteFacts", () => {
  const route = (overrides: Partial<NodeBridgeRoute> = {}): NodeBridgeRoute => ({
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: NODE,
    bridgeId: bridge.id,
    publicUdpPort: 41001,
    state: "draft",
    frpProxyName: "awg-route-x",
    observedOnline: true,
    observedRegistrationMarker: "marker-1",
    observedAt: "2026-11-13T11:59:55.000Z",
    verificationMethod: null,
    verifiedRegistrationMarker: null,
    verifiedAt: null,
    verificationResult: null,
    verificationError: null,
    activatedAt: null,
    retiringSince: null,
    createdAt: "2026-11-13T11:59:00.000Z",
    bridgeName: "Amsterdam bridge",
    bridgePublicIpv4: "198.51.100.10",
    bridgeControlTcpPort: 7000,
    bridgeManagementStatus: "ok",
    bridgeLastObservedAt: "2026-11-13T11:59:55.000Z",
    registration: { status: "online", marker: "marker-1", observedAt: "2026-11-13T11:59:55.000Z" },
    verification: { kind: "candidate", status: "none", method: null, verifiedAt: null, error: null },
    ...overrides,
  });
  const view = (value: NodeBridgeRoute) =>
    renderToStaticMarkup(<BridgeRouteFacts route={value} t={tFor("en")} lang="en" />);

  it("shows the public entry, local target, marker and the API's online registration", () => {
    const html = view(route());
    expect(html).toContain("198.51.100.10:41001/udp");
    expect(html).toContain("127.0.0.1:51890/udp");
    expect(html).toContain("marker-1");
    expect(html).toContain("Online");
    expect(html).toContain("Not verified");
  });

  it("shows an Unknown registration as Unknown, never as online, and hides the marker", () => {
    const html = view(route({ registration: { status: "unknown", marker: null, observedAt: null } }));
    expect(html).not.toContain(">Online<");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("marker-1");
  });

  it("shows a failed candidate verification with its code and a valid one as verified", () => {
    const failed = view(
      route({
        verification: {
          kind: "candidate",
          status: "failed",
          method: "probe",
          verifiedAt: "2026-11-13T11:59:59.000Z",
          error: "AWG_HANDSHAKE_FAILED",
        },
      }),
    );
    expect(failed).toContain("Failed");
    expect(failed).toContain("AWG_HANDSHAKE_FAILED");
    const ok = view(
      route({
        verification: {
          kind: "candidate",
          status: "valid",
          method: "operator",
          verifiedAt: "2026-11-13T11:59:59.000Z",
          error: null,
        },
      }),
    );
    expect(ok).toContain("Verified");
  });

  it("shows an active route's AWG path from the regular reachability result with its time", () => {
    const html = view(
      route({
        state: "active",
        verification: { kind: "awg_path", status: "failed", checkedAt: "2026-11-13T11:50:00.000Z" },
      }),
    );
    expect(html).toContain("Failing");
    expect(html).toContain(formatDateTime("2026-11-13T11:50:00.000Z", "en"));
  });

  it("labels retiring and active states", () => {
    expect(view(route({ state: "retiring" }))).toContain("Retiring");
    expect(view(route({ state: "active" }))).toContain("Active");
  });
});

describe("OverviewBridgesBlock", () => {
  const item = (overrides: Partial<{ id: string; name: string; managementStatus: Bridge["managementStatus"]; activeRoutes: number; verifiedActiveRoutes: number; awgPathOk: number; awgPathFailed: number; awgPathUnknown: number }> = {}) => ({
    id: "00000000-0000-4000-8000-0000000000b1",
    name: "Amsterdam bridge",
    managementStatus: "ok" as const,
    lastObservedAt: null,
    activeRoutes: 3,
    verifiedActiveRoutes: 1,
    awgPathOk: 1,
    awgPathFailed: 1,
    awgPathUnknown: 1,
    ...overrides,
  });
  const view = (bridges: Parameters<typeof OverviewBridgesBlock>[0]["bridges"], lang: Lang = "en") =>
    renderToStaticMarkup(<OverviewBridgesBlock bridges={bridges} t={tFor(lang)} />);

  it("renders nothing without bridges", () => {
    expect(view(undefined)).toBe("");
    expect(view(null)).toBe("");
    expect(view({ count: 0, items: [] })).toBe("");
  });

  it("links to the Bridges tab and shows management and verified counts apart", () => {
    const html = view({
      count: 2,
      items: [
        item(),
        item({ id: "00000000-0000-4000-8000-0000000000b2", name: "Berlin", managementStatus: "stale", activeRoutes: 0, verifiedActiveRoutes: 0, awgPathOk: 0, awgPathFailed: 0, awgPathUnknown: 0 }),
      ],
    });
    expect(html).toContain('href="/admin/nodes?tab=bridges"');
    expect(html).toContain("Amsterdam bridge");
    expect(html).toContain("Online");
    expect(html).toContain("active routes: 3");
    expect(html).toContain("AWG working: 1");
    expect(html).toContain("AWG failing: 1");
    expect(html).toContain("AWG unknown: 1");
    expect(html).toContain("No recent report");
    expect(html).toContain("no active routes");
  });

  it("shows unknown evidence distinctly and never as verified when management is not ok", () => {
    const html = view({
      count: 1,
      items: [item({ managementStatus: "down", verifiedActiveRoutes: 0, awgPathOk: 0, awgPathFailed: 0, awgPathUnknown: 3 })],
    });
    expect(html).toContain("AWG unknown: 3");
    expect(html).not.toContain("AWG working");
    expect(html).not.toContain("AWG failing");
  });

  it("renders in Russian", () => {
    const html = view({ count: 1, items: [item()] }, "ru");
    expect(html).toContain("Мосты");
    expect(html).toContain("активных маршрутов: 3");
    expect(html).toContain("AWG: нет данных: 1");
  });
});
