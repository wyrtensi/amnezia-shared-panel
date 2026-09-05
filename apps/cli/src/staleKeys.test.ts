import { describe, expect, it } from "vitest";

import {
  PEER_HOLDING_KEY_STATES,
  STALE_DAYS,
  classifyKeyActivity,
  formatDaysAgo,
  isStaleActivity,
  parseStaleDays,
  staleKeys,
  staleSince,
  summarizeStaleKeys,
  type StaleKeyLike,
} from "./staleKeys.js";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const key = (over: Partial<StaleKeyLike> = {}): StaleKeyLike => ({
  state: "active",
  lastUsedAt: daysAgo(1),
  createdAt: daysAgo(90),
  ...over,
});

describe("the copied rule matches the panel's", () => {
  it("pins the window and the peer-holding states", () => {
    // Both are duplicated from apps/web/lib/activity.ts; if either moves, this
    // test and its sibling there fail together.
    expect(STALE_DAYS).toBe(30);
    expect(PEER_HOLDING_KEY_STATES).toEqual(["active", "disabled"]);
  });
});

describe("classifyKeyActivity", () => {
  it("reads the key's own handshake", () => {
    expect(classifyKeyActivity(key({ lastUsedAt: daysAgo(2) }), NOW)).toBe("live");
    expect(classifyKeyActivity(key({ lastUsedAt: daysAgo(60) }), NOW)).toBe("idle");
  });

  it("is strict at exactly the window", () => {
    expect(
      classifyKeyActivity(
        key({ lastUsedAt: new Date(NOW - STALE_DAYS * DAY).toISOString() }),
        NOW,
      ),
    ).toBe("live");
    expect(
      classifyKeyActivity(
        key({ lastUsedAt: new Date(NOW - STALE_DAYS * DAY - 1).toISOString() }),
        NOW,
      ),
    ).toBe("idle");
  });

  it("separates a never-used key from a never-used OLD key", () => {
    expect(
      classifyKeyActivity(key({ lastUsedAt: null, createdAt: daysAgo(1) }), NOW),
    ).toBe("fresh");
    expect(
      classifyKeyActivity(key({ lastUsedAt: null, createdAt: daysAgo(120) }), NOW),
    ).toBe("never");
    // At the boundary a never-used key is still fresh.
    expect(
      classifyKeyActivity(
        key({
          lastUsedAt: null,
          createdAt: new Date(NOW - STALE_DAYS * DAY).toISOString(),
        }),
        NOW,
      ),
    ).toBe("fresh");
  });

  it("counts an unreadable or missing creation date as fresh, never as stale", () => {
    expect(
      classifyKeyActivity(key({ lastUsedAt: null, createdAt: "nonsense" }), NOW),
    ).toBe("fresh");
    expect(
      classifyKeyActivity(key({ lastUsedAt: null, createdAt: undefined }), NOW),
    ).toBe("fresh");
  });

  it("only judges keys that hold a peer", () => {
    for (const state of ["revoking", "revoked", "failed", "provisioning"]) {
      expect(classifyKeyActivity(key({ state, lastUsedAt: daysAgo(400) }), NOW)).toBe(
        "other",
      );
    }
    expect(
      classifyKeyActivity(key({ state: "disabled", lastUsedAt: daysAgo(400) }), NOW),
    ).toBe("idle");
  });

  it("honours a custom window", () => {
    const k = key({ lastUsedAt: daysAgo(45) });
    expect(classifyKeyActivity(k, NOW, 60)).toBe("live");
    expect(classifyKeyActivity(k, NOW, 30)).toBe("idle");
  });
});

describe("isStaleActivity / staleSince", () => {
  it("stale is exactly idle and never", () => {
    expect(isStaleActivity("idle")).toBe(true);
    expect(isStaleActivity("never")).toBe(true);
    expect(isStaleActivity("live")).toBe(false);
    expect(isStaleActivity("fresh")).toBe(false);
    expect(isStaleActivity("other")).toBe(false);
  });

  it("dates an idle key by its handshake and a never-used one by its creation", () => {
    expect(staleSince(key({ lastUsedAt: daysAgo(40) }), NOW)).toBe(
      Date.parse(daysAgo(40)),
    );
    expect(staleSince(key({ lastUsedAt: null, createdAt: daysAgo(80) }), NOW)).toBe(
      Date.parse(daysAgo(80)),
    );
    expect(staleSince(key({ lastUsedAt: daysAgo(1) }), NOW)).toBeNull();
  });
});

describe("staleKeys / summarizeStaleKeys", () => {
  const mixed: Array<StaleKeyLike & { id: string }> = [
    { id: "phone", state: "active", lastUsedAt: daysAgo(0), createdAt: daysAgo(200) },
    { id: "laptop", state: "active", lastUsedAt: daysAgo(70), createdAt: daysAgo(200) },
    { id: "tablet", state: "disabled", lastUsedAt: null, createdAt: daysAgo(150) },
    { id: "brand-new", state: "active", lastUsedAt: null, createdAt: daysAgo(3) },
    { id: "gone", state: "revoked", lastUsedAt: daysAgo(500), createdAt: daysAgo(600) },
  ];

  it("picks only the stale keys, longest stale first", () => {
    expect(staleKeys(mixed, NOW).map((k) => k.id)).toEqual(["tablet", "laptop"]);
  });

  it("tallies a mixed owner without the live key hiding the dead ones", () => {
    expect(summarizeStaleKeys(mixed, NOW)).toEqual({
      held: 4,
      live: 1,
      fresh: 1,
      idle: 1,
      never: 1,
      stale: 2,
      oldestStaleSince: Date.parse(daysAgo(150)),
    });
  });

  it("reports an owner with no keys as having nothing stale", () => {
    expect(summarizeStaleKeys([], NOW).stale).toBe(0);
    expect(summarizeStaleKeys([], NOW).oldestStaleSince).toBeNull();
  });
});

describe("formatDaysAgo / parseStaleDays", () => {
  it("prints whole days and a dash for no timestamp", () => {
    expect(formatDaysAgo(Date.parse(daysAgo(45)), NOW)).toBe("45d");
    expect(formatDaysAgo(NOW, NOW)).toBe("0d");
    expect(formatDaysAgo(null, NOW)).toBe("—");
  });

  it("defaults, accepts an integer and refuses anything else", () => {
    expect(parseStaleDays(undefined)).toBe(STALE_DAYS);
    expect(parseStaleDays("90")).toBe(90);
    expect(() => parseStaleDays("0")).toThrow(/1\.\.3650/);
    expect(() => parseStaleDays("7.5")).toThrow(/1\.\.3650/);
    expect(() => parseStaleDays("soon")).toThrow(/1\.\.3650/);
  });
});
