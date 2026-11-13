import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_OBSERVATION_STALE_MS_DEFAULT,
  BRIDGE_VERIFICATION_VALIDITY_MS,
  type NodeBridgeRoute,
} from "@amnezia/contracts";
import { ApiClientError } from "@/lib/api";
import { messages } from "@/lib/i18n/messages";
import {
  bridgeNeedsHostSetup,
  describeBridgeError,
  nodeRouteEditorHref,
  nodesTabHref,
  parseNodesTab,
  poolCapacity,
  registrationTone,
  routeObservation,
  routeVerification,
  verificationTone,
} from "./bridge-ui";

const tEn = (key: string) => (messages.en as Record<string, string>)[key] ?? key;

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const route = (overrides: Partial<NodeBridgeRoute> = {}): NodeBridgeRoute => ({
  id: "00000000-0000-4000-8000-000000000001",
  nodeId: "00000000-0000-4000-8000-000000000002",
  bridgeId: "00000000-0000-4000-8000-000000000003",
  publicUdpPort: 41000,
  state: "draft",
  frpProxyName: "awg-route-x",
  observedOnline: true,
  observedRegistrationMarker: "m-1",
  observedAt: ago(10_000),
  verificationMethod: null,
  verifiedRegistrationMarker: null,
  verifiedAt: null,
  verificationResult: null,
  verificationError: null,
  activatedAt: null,
  retiringSince: null,
  createdAt: ago(60_000),
  bridgeName: "Bridge A",
  bridgePublicIpv4: "198.51.100.10",
  bridgeControlTcpPort: 7000,
  bridgeManagementStatus: "ok",
  bridgeLastObservedAt: ago(10_000),
  ...overrides,
});

describe("navigation", () => {
  it("renames the nav entry in both locales", () => {
    expect(messages.en["nav.nodes"]).toBe("Nodes and bridges");
    expect(messages.ru["nav.nodes"]).toBe("Ноды и мосты");
  });

  it("keeps /admin/nodes for Nodes and uses ?tab=bridges for Bridges", () => {
    expect(nodesTabHref("nodes")).toBe("/admin/nodes");
    expect(nodesTabHref("bridges")).toBe("/admin/nodes?tab=bridges");
  });

  it("selects the Bridges tab from the deep link and defaults to Nodes", () => {
    expect(parseNodesTab("bridges")).toBe("bridges");
    expect(parseNodesTab(null)).toBe("nodes");
    expect(parseNodesTab(undefined)).toBe("nodes");
    expect(parseNodesTab("anything")).toBe("nodes");
    expect(parseNodesTab(new URLSearchParams("tab=bridges").get("tab"))).toBe("bridges");
  });

  it("links a node to its route editor", () => {
    expect(nodeRouteEditorHref("n 1")).toBe("/admin/policy?node=n%201#node-routes");
  });
});

describe("describeBridgeError", () => {
  it("has a readable message in both locales for every bridge error code", () => {
    for (const code of [...BRIDGE_ERROR_CODES, "CONFIRMATION_REQUIRED"]) {
      for (const lang of ["en", "ru"] as const) {
        const text = (messages[lang] as Record<string, string>)[`bridge.err.${code}`];
        expect(text, `${lang} ${code}`).toBeTruthy();
      }
    }
  });

  it("maps codes to messages and flags the stale-data ones for a refetch", () => {
    for (const code of [
      "BRIDGE_REVISION_CONFLICT",
      "BRIDGE_ROUTE_UNVERIFIED",
      "BRIDGE_OBSERVATION_STALE",
      "BRIDGE_CONFIG_UNSUPPORTED",
    ]) {
      const result = describeBridgeError(new ApiClientError(409, code, "raw"), tEn);
      expect(result.code).toBe(code);
      expect(result.message).toBe(messages.en[`bridge.err.${code}` as keyof typeof messages.en]);
      expect(result.message).not.toBe("raw");
      expect(result.refetch).toBe(true);
    }
    const taken = describeBridgeError(new ApiClientError(409, "BRIDGE_PORT_TAKEN", "x"), tEn);
    expect(taken.refetch).toBe(false);
  });

  it("explains an unavailable probe as an alternative, not a failure", () => {
    const result = describeBridgeError(
      new ApiClientError(409, "BRIDGE_UNSUPPORTED_CAPABILITY", "raw"),
      tEn,
    );
    expect(result.message).toContain("operator verification");
    expect(result.message).toContain("test config");
  });

  it("keeps the API's own message for unknown codes and plain errors", () => {
    expect(describeBridgeError(new ApiClientError(400, "VALIDATION_ERROR", "bad ip"), tEn)).toMatchObject({
      message: "bad ip",
      refetch: false,
    });
    expect(describeBridgeError(new Error("boom"), tEn).message).toBe("boom");
    expect(describeBridgeError("x", tEn).message).toBe(messages.en["bridge.err.generic"]);
  });
});

describe("routeObservation", () => {
  it("reads a fresh online observation", () => {
    expect(routeObservation(route(), NOW)).toEqual({
      status: "online",
      marker: "m-1",
      observedAt: ago(10_000),
    });
  });

  it("shows offline only from a fresh observation", () => {
    expect(routeObservation(route({ observedOnline: false }), NOW).status).toBe("offline");
  });

  it("is Unknown when the route was never observed", () => {
    expect(routeObservation(route({ observedOnline: null, observedAt: null }), NOW).status).toBe(
      "unknown",
    );
  });

  it("is Unknown when the bridge report is older than the stale window", () => {
    const old = ago(BRIDGE_OBSERVATION_STALE_MS_DEFAULT + 1_000);
    const view = routeObservation(route({ bridgeLastObservedAt: old, observedAt: old }), NOW);
    expect(view.status).toBe("unknown");
    expect(view.marker).toBeNull();
  });

  it("is Unknown when the bridge is not ok or the route is not covered by the latest report", () => {
    expect(routeObservation(route({ bridgeManagementStatus: "down" }), NOW).status).toBe("unknown");
    expect(
      routeObservation(route({ observedAt: ago(60_000), bridgeLastObservedAt: ago(10_000) }), NOW)
        .status,
    ).toBe("unknown");
  });
});

describe("routeVerification", () => {
  const verified = (extra: Partial<NodeBridgeRoute> = {}) =>
    route({
      verificationMethod: "operator",
      verificationResult: "success",
      verifiedAt: ago(60_000),
      verifiedRegistrationMarker: "m-1",
      ...extra,
    });

  it("distinguishes none, valid, failed, expired and a changed marker", () => {
    expect(routeVerification(route(), NOW).status).toBe("none");
    expect(routeVerification(verified(), NOW).status).toBe("valid");
    expect(
      routeVerification(
        verified({ verificationResult: "failure", verificationError: "AWG_HANDSHAKE_FAILED" }),
        NOW,
      ),
    ).toMatchObject({ status: "failed", error: "AWG_HANDSHAKE_FAILED" });
    expect(
      routeVerification(verified({ verifiedAt: ago(BRIDGE_VERIFICATION_VALIDITY_MS + 1_000) }), NOW)
        .status,
    ).toBe("expired");
    expect(routeVerification(verified({ verifiedRegistrationMarker: "m-0" }), NOW).status).toBe(
      "marker_changed",
    );
  });
});

describe("bridgeNeedsHostSetup", () => {
  it("is true only for a bridge that was never observed and has no live route", () => {
    expect(bridgeNeedsHostSetup({ lastObservedAt: null, routes: [] })).toBe(true);
    expect(bridgeNeedsHostSetup({ lastObservedAt: null, routes: [{ state: "draft" }] })).toBe(true);
  });

  it("is false for a bridge configured earlier", () => {
    expect(bridgeNeedsHostSetup({ lastObservedAt: ago(1), routes: [] })).toBe(false);
    expect(bridgeNeedsHostSetup({ lastObservedAt: null, routes: [{ state: "active" }] })).toBe(false);
    expect(bridgeNeedsHostSetup({ lastObservedAt: null, routes: [{ state: "retiring" }] })).toBe(
      false,
    );
  });
});

describe("poolCapacity", () => {
  it("counts the default pool and rejects an inverted range", () => {
    expect(poolCapacity(41000, 41031)).toBe(32);
    expect(poolCapacity(5, 5)).toBe(1);
    expect(poolCapacity(10, 9)).toBe(0);
    expect(poolCapacity(Number.NaN, 9)).toBe(0);
  });
});

describe("bridge message keys", () => {
  // `t` accepts any string, so a typo would render the raw key. Scan the
  // sources for literal keys and check them in both locales.
  const roots = ["components", "app", "lib"].map((dir) => join(__dirname, "..", dir));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        files.push(path);
      }
    }
  };
  roots.forEach(walk);

  it("defines every literal bridge.* key in English and Russian", () => {
    const keys = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/\bt\("(bridge\.[A-Za-z0-9_.]+)"/g)) {
        keys.add(match[1]!);
      }
    }
    expect(keys.size).toBeGreaterThan(50);
    for (const key of keys) {
      expect((messages.en as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((messages.ru as Record<string, string>)[key], `ru ${key}`).toBeTruthy();
    }
  });

  it("defines every dynamic status, state, observation, verification and probe key", () => {
    const dynamic = [
      ...["ok", "pending_enrollment", "down", "stale", "identity_mismatch", "unsupported"].map(
        (s) => `bridge.status.${s}`,
      ),
      ...["draft", "active", "retiring"].map((s) => `bridge.state.${s}`),
      ...["online", "offline", "unknown"].map((s) => `bridge.obs.${s}`),
      ...["none", "valid", "failed", "expired", "marker_changed"].map((s) => `bridge.ver.${s}`),
      ...["probe", "operator"].map((s) => `bridge.method.${s}`),
      ...["queued", "pending", "running"].map((s) => `bridge.probe.${s}`),
    ];
    for (const key of dynamic) {
      expect((messages.en as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((messages.ru as Record<string, string>)[key], `ru ${key}`).toBeTruthy();
    }
  });
});

describe("evidence tones", () => {
  it("never paints an unknown registration as a failure", () => {
    expect(registrationTone("online")).toBe("success");
    expect(registrationTone("offline")).toBe("destructive");
    expect(registrationTone("unknown")).toBe("outline");
  });

  it("marks only valid AWG evidence green and only a failed check red", () => {
    expect(verificationTone("valid")).toBe("success");
    expect(verificationTone("failed")).toBe("destructive");
    expect(verificationTone("none")).toBe("outline");
    for (const status of ["unknown", "expired", "marker_changed"] as const) {
      expect(verificationTone(status)).toBe("warning");
    }
  });
});
