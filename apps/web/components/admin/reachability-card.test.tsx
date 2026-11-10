import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminReachabilityNode, AdminReachabilityView } from "@amnezia/contracts";

import { formatDateTime } from "@/lib/format";
import { messages, type MessageKey } from "@/lib/i18n/messages";
import {
  levelMark,
  ReachabilityBody,
  reachabilityStatusBadge,
} from "./reachability-card";

// The real English strings, so the assertions read like the card does.
const t = (key: string, vars?: Record<string, string | number>): string =>
  (messages.en as Record<string, string>)[key]?.replace(
    /\{(\w+)\}/g,
    (match, name: string) => (vars && name in vars ? String(vars[name]) : match),
  ) ?? key;
const en = (key: MessageKey) => messages.en[key];

const PROBE: NonNullable<AdminReachabilityView["probe"]> = {
  label: "Testland",
  apiBaseUrl: "http://192.0.2.50:8080",
  enabled: true,
  controlUrl: "https://192.0.2.60/",
  egressUrl: "https://192.0.2.61/",
  intervalSec: 3600,
  failThreshold: 2,
  staleAfterSec: 10800,
  lastResultAt: "2026-11-10T08:00:00.000Z",
  lastError: null,
  lastErrorAt: null,
  stale: false,
  runInFlight: false,
  runRequestedAt: null,
};

const level = (ok: boolean | null) => ({ ok, detail: null, latencyMs: ok ? 12 : null });

const node = (overrides: Partial<AdminReachabilityNode>): AdminReachabilityNode => ({
  nodeId: "00000000-0000-4000-8000-00000000000a",
  nodeName: "node-a",
  nodeEnabled: true,
  reachabilityEnabled: true,
  status: "ok",
  checkedAt: "2026-11-10T08:00:00.000Z",
  failingSince: null,
  consecutiveFailures: 0,
  incidentOpen: false,
  detail: null,
  protocols: [],
  ...overrides,
});

const render = (view: AdminReachabilityView | null, failed = false) =>
  renderToStaticMarkup(
    <ReachabilityBody
      view={view}
      failed={failed}
      t={t}
      lang="en"
      busy={null}
      onRun={() => undefined}
      onToggleNode={() => undefined}
    />,
  );

describe("reachabilityStatusBadge", () => {
  it("never reads an error as unavailable", () => {
    expect(reachabilityStatusBadge("ok")).toEqual({
      variant: "success",
      labelKey: "reachability.status.ok",
    });
    expect(reachabilityStatusBadge("failed")).toEqual({
      variant: "destructive",
      labelKey: "reachability.status.failed",
    });
    expect(reachabilityStatusBadge("error")).toEqual({
      variant: "outline",
      labelKey: "reachability.status.error",
    });
    expect(reachabilityStatusBadge(null)).toEqual({
      variant: "outline",
      labelKey: "reachability.status.none",
    });
  });
});

describe("levelMark", () => {
  it("tells passed, failed and not attempted apart", () => {
    expect(levelMark(level(true))).toBe("ok");
    expect(levelMark(level(false))).toBe("fail");
    expect(levelMark(level(null))).toBe("none");
    expect(levelMark(undefined)).toBe("none");
  });
});

describe("ReachabilityBody", () => {
  it("titles the card from the probe label", () => {
    expect(render({ probe: PROBE, nodes: [] })).toContain("Checks from Testland");
  });

  it("shows an error as unknown, never as unavailable", () => {
    const html = render({
      probe: PROBE,
      nodes: [node({ status: "error", detail: "control failed" })],
    });
    expect(html).toContain(en("reachability.status.error"));
    expect(html).not.toContain(en("reachability.status.failed"));
  });

  it("shows when a node started failing and the open incident", () => {
    const failingSince = "2026-11-09T22:00:00.000Z";
    const html = render({
      probe: PROBE,
      nodes: [
        node({
          status: "failed",
          failingSince,
          consecutiveFailures: 3,
          incidentOpen: true,
        }),
      ],
    });
    expect(html).toContain(en("reachability.status.failed"));
    expect(html).toContain(
      t("reachability.failingSince", { time: formatDateTime(failingSince, "en") }),
    );
    expect(html).toContain(en("reachability.incident"));
  });

  it("renders every level of every protocol with the egress IP", () => {
    const html = render({
      probe: PROBE,
      nodes: [
        node({
          protocols: [
            {
              protocol: "awg3",
              status: "failed",
              levels: {
                ping: level(true),
                tcp: level(true),
                handshake: level(false),
                http: level(null),
              },
              egressIp: "192.0.2.77",
              detail: "no handshake",
              checkedAt: "2026-11-10T08:00:00.000Z",
              keyState: "active",
            },
          ],
        }),
      ],
    });
    for (const name of ["ping", "tcp/22", "handshake", "http"]) {
      expect(html).toContain(name);
    }
    expect(html).toContain("192.0.2.77");
    expect(html).toContain("no handshake");
    expect(html).toContain('data-level="ping" data-mark="ok"');
    expect(html).toContain('data-level="tcp" data-mark="ok"');
    expect(html).toContain('data-level="handshake" data-mark="fail"');
    expect(html).toContain('data-level="http" data-mark="none"');
  });

  it("points at the CLI when no probe is set up", () => {
    const html = render({ probe: null, nodes: [node({})] });
    expect(html).toContain(en("reachability.titleNone"));
    expect(html).toContain("probe-set");
  });

  it("marks a stale probe, its last error and a run in flight", () => {
    const html = render({
      probe: {
        ...PROBE,
        stale: true,
        lastError: "tunnel down",
        lastErrorAt: "2026-11-10T07:00:00.000Z",
        runInFlight: true,
      },
      nodes: [],
    });
    expect(html).toContain(en("reachability.stale"));
    expect(html).toContain("tunnel down");
    expect(html).toContain(en("reachability.runInFlight"));
  });

  it("shows a failed load instead of an empty card", () => {
    expect(render(null, true)).toContain(en("reachability.loadFailed"));
  });

  it("marks a node excluded from the probe and a disabled node", () => {
    const html = render({
      probe: PROBE,
      nodes: [node({ nodeEnabled: false, reachabilityEnabled: false })],
    });
    expect(html).toContain(en("reachability.nodeDisabled"));
    expect(html).toContain("opacity-60");
  });
});
