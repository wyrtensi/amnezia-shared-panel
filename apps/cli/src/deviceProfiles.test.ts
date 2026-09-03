import { describe, expect, it } from "vitest";

import {
  cliDeviceSupportsRouteProfiles,
  keyNeedsRouteProfileWarning,
  routeProfileWarning,
} from "./deviceProfiles.js";

describe("cliDeviceSupportsRouteProfiles", () => {
  it("mirrors the contract: iOS cannot use route profiles", () => {
    expect(cliDeviceSupportsRouteProfiles("ios")).toBe(false);
  });

  it("leaves every other device type alone", () => {
    for (const device of [
      "android",
      "macos",
      "windows",
      "linux",
      "other",
      "unspecified",
    ]) {
      expect(cliDeviceSupportsRouteProfiles(device), device).toBe(true);
    }
  });
});

describe("routeProfileWarning", () => {
  it("warns when an iOS key is given a route profile", () => {
    const warning = routeProfileWarning("ios", "ru_whitelist");
    expect(warning).toBeTruthy();
    expect(warning).toContain("ios");
    expect(warning).toContain("ru_whitelist");
  });

  it("stays quiet for an iOS key with the full tunnel", () => {
    expect(routeProfileWarning("ios", "full_tunnel")).toBeNull();
    // --route omitted: the API defaults to full_tunnel.
    expect(routeProfileWarning("ios", undefined)).toBeNull();
  });

  it("stays quiet for a profile on any other device", () => {
    expect(routeProfileWarning("windows", "ru_blacklist")).toBeNull();
    expect(routeProfileWarning(undefined, "ru_blacklist")).toBeNull();
  });
});

describe("keyNeedsRouteProfileWarning", () => {
  it("is true for a gated device on a split-tunnel profile", () => {
    // The predicate reads the shared unsupported-platform list, so it follows
    // any later change to that list.
    expect(
      keyNeedsRouteProfileWarning({
        deviceType: "ios",
        routeProfile: "ru_whitelist",
      }),
    ).toBe(true);
    expect(
      keyNeedsRouteProfileWarning({
        deviceType: "ios",
        routeProfile: "ru_blacklist",
      }),
    ).toBe(true);
  });

  it("is false on a full tunnel, which is the combination that works", () => {
    expect(
      keyNeedsRouteProfileWarning({
        deviceType: "ios",
        routeProfile: "full_tunnel",
      }),
    ).toBe(false);
  });

  it("is false for a device that applies route profiles correctly", () => {
    expect(
      keyNeedsRouteProfileWarning({
        deviceType: "android",
        routeProfile: "ru_blacklist",
      }),
    ).toBe(false);
  });

  it("is false when either field is missing, rather than guessing", () => {
    expect(keyNeedsRouteProfileWarning({})).toBe(false);
  });
});
