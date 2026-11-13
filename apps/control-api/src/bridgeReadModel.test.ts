import { describe, expect, it } from "vitest";
import type { Bridge } from "@amnezia/contracts";

import type { GuardBridge, GuardRoute } from "./bridgeGuards.js";
import {
  effectiveManagementStatus,
  overviewBridgeOf,
  routeRegistration,
  routeVerification,
} from "./bridgeReadModel.js";

const STALE_MS = 300_000;
const NOW = new Date("2026-11-13T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const M1 = "1".repeat(32);
const M2 = "2".repeat(32);

const bridge = (overrides: Partial<GuardBridge> = {}): GuardBridge => ({
  managementStatus: "ok",
  lastObservedAt: ago(10_000),
  ...overrides,
});
const route = (overrides: Partial<GuardRoute> = {}): GuardRoute => ({
  id: "0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f",
  state: "active",
  frpProxyName: "awg-route-0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f",
  observedOnline: true,
  observedRegistrationMarker: M1,
  observedAt: ago(10_000),
  verificationMethod: "probe",
  verifiedRegistrationMarker: M1,
  verifiedAt: ago(60_000),
  verificationResult: "success",
  ...overrides,
});

describe("effectiveManagementStatus", () => {
  it("reads a stored ok past the window, or without an observation, as stale", () => {
    expect(effectiveManagementStatus(bridge(), NOW, STALE_MS)).toBe("ok");
    expect(effectiveManagementStatus(bridge({ lastObservedAt: ago(STALE_MS + 1) }), NOW, STALE_MS)).toBe("stale");
    expect(effectiveManagementStatus(bridge({ lastObservedAt: null }), NOW, STALE_MS)).toBe("stale");
  });

  it("leaves every other stored status alone", () => {
    for (const managementStatus of ["down", "identity_mismatch", "unsupported", "pending_enrollment"] as const) {
      expect(effectiveManagementStatus(bridge({ managementStatus, lastObservedAt: ago(STALE_MS * 4) }), NOW, STALE_MS)).toBe(
        managementStatus,
      );
    }
  });
});

describe("routeRegistration", () => {
  const read = (r: GuardRoute, b: GuardBridge = bridge()) => routeRegistration(r, b, NOW, STALE_MS);

  it("is online with the marker only while the latest poll covers the route", () => {
    expect(read(route())).toEqual({ status: "online", marker: M1, observedAt: ago(10_000).toISOString() });
  });

  it("is offline without a marker when the covering poll saw it gone", () => {
    expect(read(route({ observedOnline: false, observedRegistrationMarker: null }))).toMatchObject({
      status: "offline",
      marker: null,
    });
  });

  it.each([
    ["a stale bridge observation", route(), bridge({ lastObservedAt: ago(STALE_MS + 1), managementStatus: "ok" })],
    ["a bridge that is down", route(), bridge({ managementStatus: "down" })],
    ["a bridge never enrolled", route({ observedOnline: null, observedAt: null }), bridge({ managementStatus: "pending_enrollment", lastObservedAt: null })],
    // frps unreachable advances only the bridge's observation time.
    ["a poll that did not cover the route", route({ observedAt: ago(70_000) }), bridge()],
    ["a route never observed", route({ observedOnline: null, observedAt: null }), bridge()],
  ])("is unknown, never offline, for %s", (_label, r, b) => {
    expect(read(r, b)).toMatchObject({ status: "unknown", marker: null });
  });
});

describe("routeVerification", () => {
  const verify = (r: GuardRoute, b: GuardBridge = bridge()) =>
    routeVerification(r, routeRegistration(r, b, NOW, STALE_MS), NOW);

  it("is valid for a recent success bound to the marker observed now", () => {
    expect(verify(route())).toEqual({
      status: "valid",
      method: "probe",
      verifiedAt: ago(60_000).toISOString(),
      error: null,
    });
  });

  it("is none without a result", () => {
    expect(verify(route({ verificationResult: null, verificationMethod: null, verifiedAt: null }))).toEqual({
      status: "none",
      method: null,
      verifiedAt: null,
      error: null,
    });
  });

  it("carries a failure's bounded code", () => {
    expect(verify(route({ verificationResult: "failure", verificationError: "NO_HANDSHAKE" }))).toMatchObject({
      status: "failed",
      error: "NO_HANDSHAKE",
    });
  });

  it("expires after 30 minutes", () => {
    expect(verify(route({ state: "draft", verifiedAt: ago(30 * 60_000 + 1) })).status).toBe("expired");
  });

  it("keeps an active route's evidence valid past 30 minutes while the marker still matches", () => {
    const old = { verifiedAt: ago(31 * 60_000) };
    expect(verify(route({ state: "active", ...old })).status).toBe("valid");
    expect(verify(route({ state: "active", ...old, observedRegistrationMarker: M2 })).status).toBe(
      "marker_changed",
    );
    // A draft or retiring route gets no such grace: it has not been activated on that evidence.
    expect(verify(route({ state: "retiring", ...old })).status).toBe("expired");
    expect(verify(route({ state: "draft", ...old })).status).toBe("expired");
  });

  it("reports a replaced registration as marker_changed", () => {
    expect(verify(route({ observedRegistrationMarker: M2 })).status).toBe("marker_changed");
  });

  it("is unknown when no current online observation can vouch for the success", () => {
    expect(verify(route(), bridge({ lastObservedAt: ago(STALE_MS + 1) })).status).toBe("unknown");
    expect(verify(route({ observedOnline: false, observedRegistrationMarker: null })).status).toBe("unknown");
  });
});

describe("overviewBridgeOf", () => {
  it("counts active routes and the ones with valid verification", () => {
    const summary = (state: "active" | "draft", status: "valid" | "none") => ({
      id: crypto.randomUUID(),
      nodeId: crypto.randomUUID(),
      nodeName: "n",
      publicUdpPort: 41000,
      state,
      registration: { status: "online" as const, marker: M1, observedAt: null },
      verification: { status, method: null, verifiedAt: null, error: null },
    });
    const result = overviewBridgeOf({
      id: "b",
      name: "Frankfurt",
      managementStatus: "stale",
      lastObservedAt: null,
      routes: [summary("active", "valid"), summary("active", "none"), summary("draft", "valid")],
    } as unknown as Bridge);
    expect(result).toEqual({
      id: "b",
      name: "Frankfurt",
      managementStatus: "stale",
      lastObservedAt: null,
      activeRoutes: 2,
      verifiedActiveRoutes: 1,
    });
  });
});
