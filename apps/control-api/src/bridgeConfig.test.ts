import { describe, expect, it } from "vitest";
import { assertBridgeJobsEnabled, resolveBridgeConfig } from "./bridgeConfig.js";
import { ApiError } from "./service.js";

describe("resolveBridgeConfig", () => {
  it("defaults to jobs disabled and a five-minute stale window", () => {
    expect(resolveBridgeConfig({})).toEqual({ jobsEnabled: false, observationStaleMs: 300_000 });
  });

  it("enables jobs only for the exact value true", () => {
    expect(resolveBridgeConfig({ VPN_BRIDGE_JOBS_ENABLED: "true" }).jobsEnabled).toBe(true);
    for (const value of ["", "false", "1", "yes", "TRUE"]) {
      expect(resolveBridgeConfig({ VPN_BRIDGE_JOBS_ENABLED: value }).jobsEnabled).toBe(false);
    }
  });

  it("reads a positive stale window and refuses anything else", () => {
    expect(
      resolveBridgeConfig({ VPN_BRIDGE_OBSERVATION_STALE_MS: "60000" }).observationStaleMs,
    ).toBe(60_000);
    for (const value of ["0", "-5", "1.5", "five"]) {
      expect(() => resolveBridgeConfig({ VPN_BRIDGE_OBSERVATION_STALE_MS: value })).toThrow(
        /VPN_BRIDGE_OBSERVATION_STALE_MS/,
      );
    }
  });
});

describe("assertBridgeJobsEnabled", () => {
  it("throws the typed BRIDGE_JOBS_DISABLED while the gate is closed", () => {
    expect(() => assertBridgeJobsEnabled({ jobsEnabled: true })).not.toThrow();
    let caught: unknown;
    try {
      assertBridgeJobsEnabled({ jobsEnabled: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ statusCode: 409, code: "BRIDGE_JOBS_DISABLED" });
  });
});
