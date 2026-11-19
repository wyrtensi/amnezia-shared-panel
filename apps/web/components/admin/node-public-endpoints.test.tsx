import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminNodeEndpoint } from "@amnezia/contracts";
import { messages } from "@/lib/i18n/messages";
import { NodePublicEndpoints } from "./node-public-endpoints";

const endpoint = (overrides: Partial<AdminNodeEndpoint>): AdminNodeEndpoint => ({
  id: "00000000-0000-4000-8000-000000000001",
  ordinal: 1,
  name: "Edge Primary",
  publicAddress: "192.0.2.10",
  enabled: true,
  reachabilityEnabled: true,
  probeStatus: null,
  probeLevels: null,
  probeCheckedAt: null,
  probeFailingSince: null,
  probeConsecutiveFailures: 0,
  incidentOpen: false,
  probeDetail: null,
  reachability: { state: "unknown", since: null },
  ...overrides,
});

const render = (endpoints: AdminNodeEndpoint[]) =>
  renderToStaticMarkup(
    <NodePublicEndpoints
      endpoints={endpoints}
      canAdd
      onSave={() => Promise.resolve()}
    />,
  );

describe("NodePublicEndpoints", () => {
  it("renders unambiguous labels without raw i18n keys or misleading node-disable text", () => {
    const html = render([
      endpoint({ id: "ep-1", ordinal: 1, name: "Edge-1", publicAddress: "192.0.2.10" }),
      endpoint({
        id: "ep-2",
        ordinal: 2,
        name: "Edge-2",
        publicAddress: "192.0.2.20",
        probeStatus: "ok",
        reachability: { state: "ok", since: null },
      }),
    ]);

    expect(html).not.toContain("common.edit");
    expect(html).not.toContain(messages.ru["nodes.toggleOff"]);
    expect(html).toContain(messages.ru["nodes.endpointPrimary"]);
    expect(html).toContain(messages.ru["nodes.endpointProbeUnknown"]);
    expect(html).toContain(messages.ru["nodes.endpointProbeOk"]);
    // Both IPs are toggleable when 2+ are enabled (including ordinal 1).
    expect(html).toContain('aria-label="Выключить адрес Edge-1"');
    expect(html).toContain('aria-label="Выключить адрес Edge-2"');
    expect(html).not.toContain('disabled=""');
  });

  it("disables the toggle only on the sole remaining enabled endpoint", () => {
    const html = render([
      endpoint({ id: "ep-1", ordinal: 1, name: "Edge-1", enabled: false }),
      endpoint({
        id: "ep-2",
        ordinal: 2,
        name: "Edge-2",
        publicAddress: "192.0.2.20",
        enabled: true,
        incidentOpen: true,
        probeStatus: "failed",
        reachability: { state: "blocked", since: "2026-11-10T08:00:00.000Z" },
      }),
    ]);

    expect(html).toContain(messages.ru["nodes.endpointDisabled"]);
    expect(html).toContain(messages.ru["nodes.endpointProbeBlocked"]);
    expect(html).toContain(messages.ru["reachability.incident"]);
    expect(html).toContain(messages.ru["nodes.endpointLastEnabledHint"]);
  });
});
