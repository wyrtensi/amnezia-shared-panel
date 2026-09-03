import { describe, expect, it } from "vitest";

import {
  cliDeviceSupportsRouteProfiles,
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
