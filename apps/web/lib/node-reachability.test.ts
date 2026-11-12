import { describe, expect, it } from "vitest";

import { blockedFirst, keyBadgeState } from "./node-reachability";

const blocked = { state: "blocked" as const, since: "2026-11-12T09:11:00.000Z", sinceText: "12.11 10:11" };
const ok = { state: "ok" as const, since: null, sinceText: null };
const unknown = { state: "unknown" as const, since: null, sinceText: null };

describe("keyBadgeState", () => {
  it("turns an active key on a blocked server into blocked", () => {
    expect(keyBadgeState("active", blocked)).toBe("blocked");
  });

  it.each(["provisioning", "failed", "disabled", "revoking", "revoked"])(
    "keeps %s even on a blocked server",
    (state) => {
      expect(keyBadgeState(state, blocked)).toBe(state);
    },
  );

  it("keeps active on an ok, unknown or unreported server", () => {
    expect(keyBadgeState("active", ok)).toBe("active");
    expect(keyBadgeState("active", unknown)).toBe("active");
    expect(keyBadgeState("active", undefined)).toBe("active");
  });
});

describe("blockedFirst", () => {
  it("lifts blocked servers to the top and keeps the admin order otherwise", () => {
    const nodes = [
      { id: "a", reachability: ok },
      { id: "b", reachability: blocked },
      { id: "c" },
      { id: "d", reachability: unknown },
      { id: "e", reachability: blocked },
    ];
    expect(blockedFirst(nodes).map((node) => node.id)).toEqual(["b", "e", "a", "c", "d"]);
  });
});
