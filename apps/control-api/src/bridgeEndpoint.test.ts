import { describe, expect, it } from "vitest";
import {
  resolveKeyBridgeInfo,
  type KeyBridgeRouteRecord,
} from "./bridgeEndpoint.js";

const ACTIVE_ROUTE: KeyBridgeRouteRecord = {
  routeId: "11111111-1111-4111-8111-111111111111",
  bridgeId: "22222222-2222-4222-8222-222222222222",
  bridgeName: "edge-a",
  publicIpv4: "198.51.100.10",
  publicUdpPort: 41000,
};

const PINNED_ROUTE: KeyBridgeRouteRecord = {
  routeId: "33333333-3333-4333-8333-333333333333",
  bridgeId: "44444444-4444-4444-8444-444444444444",
  bridgeName: "edge-b",
  publicIpv4: "203.0.113.20",
  publicUdpPort: 41001,
};

describe("resolveKeyBridgeInfo", () => {
  it("stays Direct by default when useBridge is false even with an active node route", () => {
    expect(
      resolveKeyBridgeInfo({
        protocol: "awg3",
        bridgeMode: "inherit",
        pinnedRouteId: null,
        pinnedRoute: null,
        activeRoute: ACTIVE_ROUTE,
        useBridge: false,
      }),
    ).toEqual({
      mode: "inherit",
      routeId: null,
      effective: null,
    });
  });

  it("uses the node's active route when inherit and useBridge is true", () => {
    expect(
      resolveKeyBridgeInfo({
        protocol: "awg3",
        bridgeMode: "inherit",
        pinnedRouteId: null,
        pinnedRoute: null,
        activeRoute: ACTIVE_ROUTE,
        useBridge: true,
      }),
    ).toEqual({
      mode: "inherit",
      routeId: null,
      effective: { ...ACTIVE_ROUTE, source: "policy" },
    });
  });

  it("forces Direct when bridgeMode is direct even if useBridge is true", () => {
    expect(
      resolveKeyBridgeInfo({
        protocol: "awg3",
        bridgeMode: "direct",
        pinnedRouteId: null,
        pinnedRoute: null,
        activeRoute: ACTIVE_ROUTE,
        useBridge: true,
      }),
    ).toEqual({
      mode: "direct",
      routeId: null,
      effective: null,
    });
  });

  it("uses the pinned route when bridgeMode is route even when useBridge is false", () => {
    expect(
      resolveKeyBridgeInfo({
        protocol: "awg3",
        bridgeMode: "route",
        pinnedRouteId: PINNED_ROUTE.routeId,
        pinnedRoute: PINNED_ROUTE,
        activeRoute: ACTIVE_ROUTE,
        useBridge: false,
      }),
    ).toEqual({
      mode: "route",
      routeId: PINNED_ROUTE.routeId,
      effective: { ...PINNED_ROUTE, source: "key" },
    });
  });

  it("falls back to Direct when a pinned route is gone", () => {
    expect(
      resolveKeyBridgeInfo({
        protocol: "awg3",
        bridgeMode: "route",
        pinnedRouteId: null,
        pinnedRoute: null,
        activeRoute: ACTIVE_ROUTE,
        useBridge: true,
      }),
    ).toEqual({
      mode: "route",
      routeId: null,
      effective: null,
    });
  });

  it("keeps AWG 2 keys Direct regardless of policy or key pin", () => {
    expect(
      resolveKeyBridgeInfo({
        protocol: "awg2",
        bridgeMode: "route",
        pinnedRouteId: PINNED_ROUTE.routeId,
        pinnedRoute: PINNED_ROUTE,
        activeRoute: ACTIVE_ROUTE,
        useBridge: true,
      }),
    ).toEqual({
      mode: "route",
      routeId: PINNED_ROUTE.routeId,
      effective: null,
    });
  });
});
