import { describe, expect, it } from "vitest";
import { BRIDGE_VERIFICATION_VALIDITY_MS, bridgeFrpProxyName } from "@amnezia/contracts";
import {
  checkActivationGuard,
  checkReleaseGuard,
  isBridgeObservationFresh,
  type GuardBridge,
  type GuardRoute,
} from "./bridgeGuards.js";

const STALE_MS = 300_000;
const now = new Date("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const routeId = "0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a";

const bridge = (overrides: Partial<GuardBridge> = {}): GuardBridge => ({
  managementStatus: "ok",
  lastObservedAt: ago(60_000),
  ...overrides,
});

const route = (overrides: Partial<GuardRoute> = {}): GuardRoute => ({
  id: routeId,
  state: "draft",
  frpProxyName: bridgeFrpProxyName(routeId),
  observedOnline: true,
  observedRegistrationMarker: "marker-1",
  observedAt: ago(60_000),
  verificationMethod: "probe",
  verifiedRegistrationMarker: "marker-1",
  verifiedAt: ago(60_000),
  verificationResult: "success",
  ...overrides,
});

describe("isBridgeObservationFresh", () => {
  it("needs status ok and an observation inside the window", () => {
    expect(isBridgeObservationFresh(bridge(), now, STALE_MS)).toBe(true);
    expect(isBridgeObservationFresh(bridge({ lastObservedAt: ago(STALE_MS) }), now, STALE_MS)).toBe(
      true,
    );
    expect(
      isBridgeObservationFresh(bridge({ lastObservedAt: ago(STALE_MS + 1) }), now, STALE_MS),
    ).toBe(false);
    expect(isBridgeObservationFresh(bridge({ lastObservedAt: null }), now, STALE_MS)).toBe(false);
    for (const managementStatus of [
      "pending_enrollment",
      "down",
      "stale",
      "identity_mismatch",
      "unsupported",
    ] as const) {
      expect(isBridgeObservationFresh(bridge({ managementStatus }), now, STALE_MS)).toBe(false);
    }
  });
});

describe("checkActivationGuard", () => {
  const codeOf = (r: GuardRoute, b: GuardBridge = bridge()) =>
    checkActivationGuard(r, b, now, STALE_MS)?.code ?? null;

  it("passes a fresh, online, freshly verified route", () => {
    expect(codeOf(route())).toBeNull();
    expect(codeOf(route({ verificationMethod: "operator" }))).toBeNull();
    expect(codeOf(route({ verifiedAt: ago(BRIDGE_VERIFICATION_VALIDITY_MS) }))).toBeNull();
  });

  it("reports a missing, stale or uncovered observation as stale", () => {
    expect(codeOf(route({ observedAt: null }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(route(), bridge({ lastObservedAt: ago(STALE_MS + 1) }))).toBe(
      "BRIDGE_OBSERVATION_STALE",
    );
    expect(codeOf(route(), bridge({ managementStatus: "down" }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(route({ observedAt: ago(120_000) }))).toBe("BRIDGE_OBSERVATION_STALE");
  });

  it("requires the route online under its own proxy name with a marker", () => {
    expect(codeOf(route({ observedOnline: false }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(route({ observedOnline: null }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(route({ frpProxyName: "awg-route-other" }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(route({ observedRegistrationMarker: null }))).toBe("BRIDGE_OBSERVATION_STALE");
  });

  it("requires a successful verification of the observed marker within 30 minutes", () => {
    expect(codeOf(route({ verifiedAt: null }))).toBe("BRIDGE_ROUTE_UNVERIFIED");
    expect(codeOf(route({ verificationMethod: null }))).toBe("BRIDGE_ROUTE_UNVERIFIED");
    expect(codeOf(route({ verificationResult: "failure" }))).toBe("BRIDGE_ROUTE_UNVERIFIED");
    expect(codeOf(route({ verifiedRegistrationMarker: "marker-0" }))).toBe(
      "BRIDGE_ROUTE_UNVERIFIED",
    );
    expect(codeOf(route({ verifiedAt: ago(BRIDGE_VERIFICATION_VALIDITY_MS + 1) }))).toBe(
      "BRIDGE_ROUTE_UNVERIFIED",
    );
  });
});

describe("checkReleaseGuard", () => {
  const codeOf = (r: GuardRoute, b: GuardBridge = bridge()) =>
    checkReleaseGuard(r, b, now, STALE_MS)?.code ?? null;

  it("releases only after a fresh poll that did not report the route online", () => {
    expect(codeOf(route({ observedOnline: false }))).toBeNull();
    expect(codeOf(route({ observedOnline: null }))).toBeNull();
    expect(codeOf(route({ observedOnline: true }))).toBe("BRIDGE_OBSERVATION_STALE");
  });

  it("keeps the reservation while the bridge state is unknown", () => {
    const absent = route({ observedOnline: false });
    expect(codeOf(route({ observedOnline: false, observedAt: null }))).toBe(
      "BRIDGE_OBSERVATION_STALE",
    );
    expect(codeOf(absent, bridge({ lastObservedAt: null }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(absent, bridge({ managementStatus: "down" }))).toBe("BRIDGE_OBSERVATION_STALE");
    expect(codeOf(absent, bridge({ lastObservedAt: ago(STALE_MS + 1) }))).toBe(
      "BRIDGE_OBSERVATION_STALE",
    );
    expect(codeOf(route({ observedOnline: false, observedAt: ago(120_000) }))).toBe(
      "BRIDGE_OBSERVATION_STALE",
    );
  });

  it("releases a draft on a never-enrolled bridge without an observation", () => {
    const pending = bridge({ managementStatus: "pending_enrollment", lastObservedAt: null });
    const unobserved = route({ observedOnline: null, observedAt: null });
    expect(codeOf(unobserved, pending)).toBeNull();
    // Retiring keeps the full rule.
    expect(codeOf({ ...unobserved, state: "retiring" }, pending)).toBe(
      "BRIDGE_OBSERVATION_STALE",
    );
    // Once observed (enrolled at some point), the exception no longer applies.
    expect(
      codeOf(unobserved, bridge({ managementStatus: "pending_enrollment", lastObservedAt: ago(1) })),
    ).toBe("BRIDGE_OBSERVATION_STALE");
    // Enrolled but stale.
    expect(
      codeOf(unobserved, bridge({ managementStatus: "stale", lastObservedAt: ago(STALE_MS + 1) })),
    ).toBe("BRIDGE_OBSERVATION_STALE");
  });
});
