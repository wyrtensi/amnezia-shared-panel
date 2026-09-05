import { describe, expect, it } from "vitest";

import {
  INACTIVE_DAYS,
  classifyKeyActivity,
  isStaleActivity,
  staleKeys,
  staleSince,
  summarizeStaleKeys,
  type ActivityKeyLike,
} from "./activity";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

/** A key holding a peer, with only the fields the rule reads. */
const key = (over: Partial<ActivityKeyLike> = {}): ActivityKeyLike => ({
  state: "active",
  lastUsedAt: daysAgo(1),
  createdAt: daysAgo(90),
  ...over,
});

describe("classifyKeyActivity", () => {
  it("reads the key's own handshake, not its owner's", () => {
    expect(classifyKeyActivity(key({ lastUsedAt: daysAgo(2) }), NOW)).toBe(
      "live",
    );
    expect(classifyKeyActivity(key({ lastUsedAt: daysAgo(60) }), NOW)).toBe(
      "idle",
    );
  });

  it("is strict at exactly the window, so a 30-day-old handshake is still live", () => {
    const boundary = key({ lastUsedAt: new Date(NOW - INACTIVE_DAYS * DAY).toISOString() });
    expect(classifyKeyActivity(boundary, NOW)).toBe("live");
    // One millisecond past it is not.
    const past = key({
      lastUsedAt: new Date(NOW - INACTIVE_DAYS * DAY - 1).toISOString(),
    });
    expect(classifyKeyActivity(past, NOW)).toBe("idle");
  });

  it("separates a key nobody has used yet from one nobody has used in months", () => {
    // Provisioned yesterday, no handshake: not stale, and must never be.
    expect(
      classifyKeyActivity(
        key({ lastUsedAt: null, createdAt: daysAgo(1) }),
        NOW,
      ),
    ).toBe("fresh");
    // Provisioned in spring, still no handshake: nobody ever connected with it.
    expect(
      classifyKeyActivity(
        key({ lastUsedAt: null, createdAt: daysAgo(120) }),
        NOW,
      ),
    ).toBe("never");
  });

  it("holds a never-used key fresh right up to the boundary", () => {
    const atBoundary = key({
      lastUsedAt: null,
      createdAt: new Date(NOW - INACTIVE_DAYS * DAY).toISOString(),
    });
    expect(classifyKeyActivity(atBoundary, NOW)).toBe("fresh");
  });

  it("counts an unreadable creation date as fresh rather than guessing", () => {
    expect(
      classifyKeyActivity(key({ lastUsedAt: null, createdAt: "not a date" }), NOW),
    ).toBe("fresh");
  });

  it("only judges keys that hold a peer", () => {
    for (const state of ["revoking", "revoked", "failed", "provisioning"]) {
      expect(
        classifyKeyActivity(key({ state, lastUsedAt: daysAgo(400) }), NOW),
      ).toBe("other");
    }
    // A disabled key still has a peer configured on the node, so it counts.
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

describe("isStaleActivity", () => {
  it("is exactly the two verdicts a cleanup acts on", () => {
    expect(isStaleActivity("idle")).toBe(true);
    expect(isStaleActivity("never")).toBe(true);
    expect(isStaleActivity("live")).toBe(false);
    expect(isStaleActivity("fresh")).toBe(false);
    expect(isStaleActivity("other")).toBe(false);
  });
});

describe("staleSince", () => {
  it("dates an idle key by its handshake and a never-used one by its creation", () => {
    expect(staleSince(key({ lastUsedAt: daysAgo(40) }), NOW)).toBe(
      Date.parse(daysAgo(40)),
    );
    expect(
      staleSince(key({ lastUsedAt: null, createdAt: daysAgo(80) }), NOW),
    ).toBe(Date.parse(daysAgo(80)));
  });

  it("is null for anything not stale", () => {
    expect(staleSince(key({ lastUsedAt: daysAgo(1) }), NOW)).toBeNull();
    expect(
      staleSince(key({ lastUsedAt: null, createdAt: daysAgo(2) }), NOW),
    ).toBeNull();
    expect(staleSince(key({ state: "revoked" }), NOW)).toBeNull();
  });
});

describe("staleKeys / summarizeStaleKeys", () => {
  // One owner with every case at once: a phone used today, a laptop nobody has
  // touched since spring, a key issued in winter that never connected, a key
  // handed out this week that has not connected yet, and a revoked leftover.
  const mixed: Array<ActivityKeyLike & { id: string }> = [
    { id: "phone", state: "active", lastUsedAt: daysAgo(0), createdAt: daysAgo(200) },
    { id: "laptop", state: "active", lastUsedAt: daysAgo(70), createdAt: daysAgo(200) },
    { id: "tablet", state: "disabled", lastUsedAt: null, createdAt: daysAgo(150) },
    { id: "brand-new", state: "active", lastUsedAt: null, createdAt: daysAgo(3) },
    { id: "gone", state: "revoked", lastUsedAt: daysAgo(500), createdAt: daysAgo(600) },
  ];

  it("picks only the stale keys, longest stale first", () => {
    expect(staleKeys(mixed, NOW).map((k) => k.id)).toEqual(["tablet", "laptop"]);
  });

  it("tallies a mixed owner without letting the live key hide the dead ones", () => {
    expect(summarizeStaleKeys(mixed, NOW)).toEqual({
      // The revoked key holds no peer, so it is outside the denominator.
      held: 4,
      live: 1,
      fresh: 1,
      idle: 1,
      never: 1,
      stale: 2,
      oldestStaleSince: Date.parse(daysAgo(150)),
    });
  });

  it("reports nothing stale for an owner with no keys", () => {
    expect(summarizeStaleKeys([], NOW)).toEqual({
      held: 0,
      live: 0,
      fresh: 0,
      idle: 0,
      never: 0,
      stale: 0,
      oldestStaleSince: null,
    });
  });

  it("reports an entirely stale owner as stale === held", () => {
    const summary = summarizeStaleKeys(
      [
        { state: "active", lastUsedAt: daysAgo(60), createdAt: daysAgo(300) },
        { state: "disabled", lastUsedAt: daysAgo(90), createdAt: daysAgo(300) },
      ],
      NOW,
    );
    expect(summary.stale).toBe(2);
    expect(summary.held).toBe(2);
  });
});
