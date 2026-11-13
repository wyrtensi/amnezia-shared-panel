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
  state: "draft",
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
      kind: "candidate",
      status: "valid",
      method: "probe",
      verifiedAt: ago(60_000).toISOString(),
      error: null,
    });
  });

  it("is none without a result", () => {
    expect(verify(route({ verificationResult: null, verificationMethod: null, verifiedAt: null }))).toEqual({
      kind: "candidate",
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

  it("applies the 30-minute expiry to draft and retiring routes", () => {
    const old = { verifiedAt: ago(31 * 60_000) };
    expect(verify(route({ state: "retiring", ...old })).status).toBe("expired");
    expect(verify(route({ state: "draft", ...old })).status).toBe("expired");
  });

  it("reads an active route's AWG path from the node's regular reachability, not from candidate verification (R19)", () => {
    const active = route({ state: "active", verificationResult: null, verificationMethod: null, verifiedAt: null });
    const registration = routeRegistration(active, bridge(), NOW, STALE_MS);
    const checkedAt = ago(120_000);
    expect(routeVerification(active, registration, NOW, { status: "ok", checkedAt })).toEqual({
      kind: "awg_path",
      status: "ok",
      checkedAt: checkedAt.toISOString(),
    });
    expect(routeVerification(active, registration, NOW, { status: "failed", checkedAt }).status).toBe("failed");
    // No evidence at all is unknown, and a 31-minute-old verification neither helps nor hurts.
    expect(routeVerification(active, registration, NOW)).toEqual({ kind: "awg_path", status: "unknown", checkedAt: null });
    const verifiedLongAgo = route({ state: "active", verifiedAt: ago(40 * 60_000) });
    expect(routeVerification(verifiedLongAgo, registration, NOW, { status: "ok", checkedAt }).kind).toBe("awg_path");
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
  const summary = (state: "active" | "draft", status: "ok" | "failed" | "unknown") => ({
    id: crypto.randomUUID(),
    nodeId: crypto.randomUUID(),
    nodeName: "n",
    publicUdpPort: 41000,
    state,
    registration: { status: "online" as const, marker: M1, observedAt: null },
    verification: { kind: "awg_path" as const, status, checkedAt: null },
  });
  const bridgeOf = (managementStatus: Bridge["managementStatus"]) =>
    ({
      id: "b",
      name: "Frankfurt",
      managementStatus,
      lastObservedAt: null,
      routes: [summary("active", "ok"), summary("active", "failed"), summary("active", "unknown"), summary("draft", "ok")],
    }) as unknown as Bridge;

  it("counts active routes by AWG path evidence", () => {
    expect(overviewBridgeOf(bridgeOf("ok"))).toEqual({
      id: "b",
      name: "Frankfurt",
      managementStatus: "ok",
      lastObservedAt: null,
      activeRoutes: 3,
      verifiedActiveRoutes: 1,
      awgPathOk: 1,
      awgPathFailed: 1,
      awgPathUnknown: 1,
    });
  });

  it("reads every active route as unknown while management is not ok", () => {
    for (const status of ["stale", "down", "pending_enrollment"] as const) {
      expect(overviewBridgeOf(bridgeOf(status))).toMatchObject({
        activeRoutes: 3,
        verifiedActiveRoutes: 0,
        awgPathOk: 0,
        awgPathFailed: 0,
        awgPathUnknown: 3,
      });
    }
  });
});
