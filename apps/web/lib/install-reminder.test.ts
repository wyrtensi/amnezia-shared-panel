import { describe, expect, it } from "vitest";

import {
  INSTALL_REMINDER_KEYS,
  keyNumberOf,
  shouldShowInstallReminder,
} from "./install-reminder";
import type { KeyView, Me } from "./types";

const user = (
  overrides: Partial<Pick<Me, "role" | "policy" | "notices">> = {},
): Pick<Me, "role" | "policy" | "notices"> => ({
  role: "user",
  policy: {},
  ...overrides,
});

const key = (keyNumber: number | null): KeyView => ({
  id: "11111111-1111-1111-1111-111111111111",
  nodeId: "22222222-2222-2222-2222-222222222222",
  state: "provisioning",
  protocol: "awg3",
  deviceType: "android",
  keyNumber,
  nameDisplay: { server: true, label: true, number: false },
  routeProfile: "full_tunnel",
  createdAt: "2026-09-05T00:00:00.000Z",
});

describe("shouldShowInstallReminder", () => {
  it("stops a regular user on their first key", () => {
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 1 })).toBe(true);
  });

  it("shows it once and only once", () => {
    expect(INSTALL_REMINDER_KEYS).toBe(1);
  });

  it("leaves them alone from the second key on", () => {
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 2 })).toBe(false);
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 3 })).toBe(false);
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 40 })).toBe(false);
  });

  it("never shows it to an administrator, at any key number", () => {
    // An admin creates keys all day; being told what the client is, three
    // times, is noise. This holds even with the policy explicitly on.
    for (const keyNumber of [1, 2, 3]) {
      expect(
        shouldShowInstallReminder({
          me: user({ role: "admin", policy: { showInstallReminder: true } }),
          keyNumber,
        }),
        `key #${keyNumber}`,
      ).toBe(false);
    }
  });

  it("is suppressed entirely when the policy flag is off", () => {
    expect(
      shouldShowInstallReminder({
        me: user({ policy: { showInstallReminder: false } }),
        keyNumber: 1,
      }),
    ).toBe(false);
  });

  it("stays on when the payload carries no flag at all", () => {
    // A control API older than the field sends nothing, and the contract's
    // default is ON — an upgrade must not silently remove the warning.
    expect(
      shouldShowInstallReminder({ me: user({ policy: {} }), keyNumber: 1 }),
    ).toBe(true);
  });

  it("shows nothing before the profile has loaded, or without a number", () => {
    expect(shouldShowInstallReminder({ me: null, keyNumber: 1 })).toBe(false);
    expect(shouldShowInstallReminder({ me: user(), keyNumber: null })).toBe(
      false,
    );
    // Defensive: a number below the first key is not a first key.
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 0 })).toBe(false);
  });
});

describe("the counter beats the key number", () => {
  it("stops as soon as either of them says to", () => {
    // A signed counter ends it whatever the ordinal says...
    expect(
      shouldShowInstallReminder({
        me: user({ notices: { install: 1, update: 0 } }),
        keyNumber: 1,
      }),
    ).toBe(false);
    // ...and the ordinal still ends it for somebody who never answered. This
    // is the half that keeps a dismissal (✕ or Esc, which do not count) from
    // turning into a dialog on every key they ever make.
    expect(
      shouldShowInstallReminder({
        me: user({ notices: { install: 0, update: 0 } }),
        keyNumber: 40,
      }),
    ).toBe(false);
    // Both agreeing is the one case that shows it.
    expect(
      shouldShowInstallReminder({
        me: user({ notices: { install: 0, update: 0 } }),
        keyNumber: 1,
      }),
    ).toBe(true);
  });

  it("lets the counter decide alone when there is no ordinal", () => {
    // A key row from before `key_number` existed. The counter is all there is,
    // and it is a better answer than the "no reminder" the ordinal gave.
    expect(
      shouldShowInstallReminder({
        me: user({ notices: { install: 0, update: 0 } }),
        keyNumber: null,
      }),
    ).toBe(true);
    expect(
      shouldShowInstallReminder({
        me: user({ notices: { install: 1, update: 0 } }),
        keyNumber: null,
      }),
    ).toBe(false);
  });

  it("survives a purge that resets the key number", () => {
    // The whole reason the counter exists. An admin purges this user's revoked
    // rows, the next key is numbered 1 again, and the ordinal now says "first
    // key" about somebody who has answered the step already.
    expect(
      shouldShowInstallReminder({
        me: user({ notices: { install: 1, update: 0 } }),
        keyNumber: 1,
      }),
    ).toBe(false);
  });

  it("still honours the policy switch and the admin exclusion", () => {
    expect(
      shouldShowInstallReminder({
        me: user({
          policy: { showInstallReminder: false },
          notices: { install: 0, update: 0 },
        }),
        keyNumber: 1,
      }),
    ).toBe(false);
    expect(
      shouldShowInstallReminder({
        me: user({ role: "admin", notices: { install: 0, update: 0 } }),
        keyNumber: 1,
      }),
    ).toBe(false);
  });

  it("falls back to the ordinal when the API sends no counter", () => {
    // A control API older than the columns. Behaviour there is exactly what it
    // was before, ordinal and all.
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 1 })).toBe(true);
    expect(shouldShowInstallReminder({ me: user(), keyNumber: 2 })).toBe(false);
    expect(shouldShowInstallReminder({ me: user(), keyNumber: null })).toBe(false);
  });
});

describe("keyNumberOf", () => {
  it("reads the per-owner ordinal the API assigns at creation", () => {
    expect(keyNumberOf(key(2))).toBe(2);
  });

  it("reads a pre-migration key as no number rather than as a first key", () => {
    expect(keyNumberOf(key(null))).toBeNull();
    expect(keyNumberOf(undefined)).toBeNull();
  });

  it("counts keys ever created, not keys currently held", () => {
    // The point of using `keyNumber` at all: it is assigned as
    // max(number for this owner) + 1 and a revoked key keeps its row, so
    // somebody who revokes as they go still reaches four and stops being
    // reminded — which counting their live keys would never do.
    const held = [key(4)];
    expect(held.length).toBe(1);
    expect(
      shouldShowInstallReminder({ me: user(), keyNumber: keyNumberOf(held[0]) }),
    ).toBe(false);
  });
});
