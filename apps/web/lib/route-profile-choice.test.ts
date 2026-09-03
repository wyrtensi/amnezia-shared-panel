import { describe, expect, it } from "vitest";

import { messages } from "./i18n/messages";
import { routeProfileChoice } from "./route-profile-choice";

const PROFILES = ["full_tunnel", "ru_whitelist", "ru_blacklist"] as const;

// The everything-is-fine baseline; each test perturbs one field.
const ok = {
  rulesReady: true,
  policyLocked: false,
  deviceType: "windows",
};

describe("routeProfileChoice", () => {
  it("enables every profile when nothing is wrong", () => {
    for (const profile of PROFILES) {
      const choice = routeProfileChoice({ ...ok, profile });
      expect(choice.disabled, profile).toBe(false);
      expect(choice.hintKey, profile).toBeNull();
    }
  });

  // D9: the operator's decision of 2026-09-03. On iOS a route-profile key
  // connects and filters nothing, with both import paths, so the panel stops
  // offering the choice at creation time. "ios" covers iPhone and iPad.
  it("disables the route profiles when the device is an iPhone or iPad", () => {
    for (const profile of ["ru_whitelist", "ru_blacklist"] as const) {
      const choice = routeProfileChoice({ ...ok, profile, deviceType: "ios" });
      expect(choice.disabled, profile).toBe(true);
      expect(choice.hintKey, profile).toBe("wizard.profileNoIphone");
    }
  });

  it("always leaves the full tunnel selectable on iOS", () => {
    const choice = routeProfileChoice({
      ...ok,
      profile: "full_tunnel",
      deviceType: "ios",
    });
    expect(choice.disabled).toBe(false);
    expect(choice.hintKey).toBeNull();
  });

  it("does not disable profiles for any other device type", () => {
    for (const device of [
      "android",
      "macos",
      "windows",
      "linux",
      "other",
      "unspecified",
    ]) {
      const choice = routeProfileChoice({
        ...ok,
        profile: "ru_whitelist",
        deviceType: device,
      });
      expect(choice.disabled, device).toBe(false);
    }
  });

  it("keeps the two pre-existing reasons working", () => {
    expect(
      routeProfileChoice({ ...ok, profile: "ru_whitelist", rulesReady: false }),
    ).toEqual({ disabled: true, hintKey: "wizard.rulesNotActive" });
    expect(
      routeProfileChoice({ ...ok, profile: "ru_whitelist", policyLocked: true }),
    ).toEqual({ disabled: true, hintKey: "wizard.profileDisabled" });
    // A policy lock never touches the full tunnel — that was true before and
    // must stay true, or a locked-down panel could create no keys at all.
    expect(
      routeProfileChoice({ ...ok, profile: "full_tunnel", policyLocked: true }),
    ).toEqual({ disabled: false, hintKey: null });
  });

  it("names the iPhone first when several reasons apply", () => {
    // The only one of the three the user can act on themselves: change the
    // device type, or accept a full-tunnel key. The other two need an admin.
    const choice = routeProfileChoice({
      profile: "ru_blacklist",
      rulesReady: false,
      policyLocked: true,
      deviceType: "ios",
    });
    expect(choice.disabled).toBe(true);
    expect(choice.hintKey).toBe("wizard.profileNoIphone");
  });

  it("only ever returns hint keys that exist in both languages", () => {
    const keys = new Set<string>();
    for (const profile of PROFILES) {
      for (const rulesReady of [true, false]) {
        for (const policyLocked of [true, false]) {
          for (const deviceType of ["windows", "ios"]) {
            const { hintKey } = routeProfileChoice({
              profile,
              rulesReady,
              policyLocked,
              deviceType,
            });
            if (hintKey) keys.add(hintKey);
          }
        }
      }
    }
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });
});

describe("iPhone strings", () => {
  it("exist in both languages", () => {
    for (const key of [
      "wizard.profileNoIphone",
      "wizard.routingNoIphone",
      "keyCard.iphoneProfileWarning",
    ]) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });
});
