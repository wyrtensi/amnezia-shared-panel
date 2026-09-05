import { describe, expect, it } from "vitest";

import { messages } from "./i18n/messages";
import { routeProfileChoice } from "./route-profile-choice";

const PROFILES = ["full_tunnel", "ru_whitelist", "ru_blacklist"] as const;

// The everything-is-fine baseline; each test perturbs one field.
const ok = {
  rulesReady: true,
  policyLocked: false,
};

describe("routeProfileChoice", () => {
  it("enables every profile when nothing is wrong", () => {
    for (const profile of PROFILES) {
      const choice = routeProfileChoice({ ...ok, profile });
      expect(choice.disabled, profile).toBe(false);
      expect(choice.hintKey, profile).toBeNull();
    }
  });

  // The platform used to gate this: an iOS key was refused a route profile
  // because Default VPN, the listing the Russian App Store offers, connects and
  // filters nothing. The panel cannot tell which client a device runs, so it no
  // longer guesses — every profile is offered on every device.
  it("does not decide on the platform at all", () => {
    for (const profile of PROFILES) {
      expect(routeProfileChoice({ ...ok, profile })).toEqual({
        disabled: false,
        hintKey: null,
      });
    }
  });

  it("keeps the two administrator reasons working", () => {
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

  it("names the rule set before the policy when both apply", () => {
    expect(
      routeProfileChoice({
        profile: "ru_blacklist",
        rulesReady: false,
        policyLocked: true,
      }),
    ).toEqual({ disabled: true, hintKey: "wizard.rulesNotActive" });
  });

  it("only ever returns hint keys that exist in both languages", () => {
    const keys = new Set<string>();
    for (const profile of PROFILES) {
      for (const rulesReady of [true, false]) {
        for (const policyLocked of [true, false]) {
          const { hintKey } = routeProfileChoice({
            profile,
            rulesReady,
            policyLocked,
          });
          if (hintKey) keys.add(hintKey);
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

// The panel no longer tells anyone that a platform cannot apply a profile, so
// nothing may be left saying it. A stale string is worse than a missing one:
// it contradicts the cards the user is looking at.
describe("the retired platform strings", () => {
  it("are gone from both languages", () => {
    for (const key of [
      "wizard.profileNoIphone",
      "wizard.routingNoIphone",
      "wizard.hasAmneziaClient",
      "wizard.hasAmneziaClientHint",
      "keyCard.iphoneProfileWarning",
    ]) {
      expect(messages.ru, `ru still has ${key}`).not.toHaveProperty(key);
      expect(messages.en, `en still has ${key}`).not.toHaveProperty(key);
    }
  });

  it("keeps the install guide's AmneziaVPN pointer, which is still true", () => {
    for (const key of [
      "install.iosAmneziaTitle",
      "install.iosAmneziaBody",
      "install.iosAmneziaOpen",
    ]) {
      expect(messages.ru, `ru is missing ${key}`).toHaveProperty(key);
      expect(messages.en, `en is missing ${key}`).toHaveProperty(key);
    }
  });
});
