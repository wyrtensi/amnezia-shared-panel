import { describe, expect, it } from "vitest";
import { globalRouteProfileSchema } from "@amnezia/contracts";
import { mergeRoutePayload } from "./routeMerge.js";

const profile = (input: unknown) => globalRouteProfileSchema.parse(input);

describe("mergeRoutePayload", () => {
  const base = {
    cidrs: ["10.0.0.0/8", "192.0.2.0/24"],
    domains: ["blocked.ru", "cdn.example.com", "example.com", "keep.org"],
  };

  it("returns the base feed's addresses when nothing is configured", () => {
    expect(mergeRoutePayload({ base })).toEqual({ cidrs: base.cidrs });
  });

  it("drops excluded CIDRs by exact match only", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({ exclude: { cidrs: ["10.0.0.0/8"] } }),
    });

    expect(merged.cidrs).toEqual(["192.0.2.0/24"]);
  });

  it("applies the admin additions after the exclusions", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({
        add: { cidrs: ["203.0.113.0/24"] },
        exclude: { cidrs: ["10.0.0.0/8"] },
      }),
    });

    expect(merged.cidrs).toEqual(["192.0.2.0/24", "203.0.113.0/24"]);
  });

  it("lets a user's own routes re-add what the admin excluded", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({ exclude: { cidrs: ["10.0.0.0/8"] } }),
      userExtra: { cidrs: ["10.0.0.0/8"] },
    });

    expect(merged.cidrs).toContain("10.0.0.0/8");
  });

  it("de-duplicates entries shared by the feed, the admin and the user", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({ add: { cidrs: ["10.0.0.0/8"] } }),
      userExtra: { cidrs: ["10.0.0.0/8", "198.51.100.0/24"] },
    });

    expect(merged.cidrs.filter((cidr) => cidr === "10.0.0.0/8")).toHaveLength(1);
    expect(merged.cidrs).toContain("198.51.100.0/24");
  });

  it("works with no base feed at all", () => {
    const merged = mergeRoutePayload({
      base: { cidrs: [], domains: [] },
      global: profile({ add: { cidrs: ["203.0.113.0/24"] } }),
      userExtra: { cidrs: ["198.51.100.0/24"] },
    });

    expect(merged).toEqual({
      cidrs: ["203.0.113.0/24", "198.51.100.0/24"],
    });
  });

  // Rows written before route rules became addresses-only still carry domains
  // in every layer. None of them can reach an exported key, so the merge has to
  // ignore them rather than pass them on to something that will look routed.
  it("ignores the domains a stored payload still carries, in every layer", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({
        add: { domains: ["extra.io"] },
        exclude: { domains: ["example.com"] },
      }),
      userExtra: { cidrs: ["198.51.100.0/24"] },
    });

    expect(merged).toEqual({
      cidrs: ["10.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24"],
    });
    expect(merged).not.toHaveProperty("domains");
  });
});
