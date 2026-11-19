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

  it("subtracts excluded CIDRs by exact match and punches holes out of enclosing supernets", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({ exclude: { cidrs: ["10.0.0.0/8"] } }),
    });

    expect(merged.cidrs).toEqual(["192.0.2.0/24"]);

    // Excluding a /25 inside a /24 supernet leaves the remaining half cleanly.
    const punched = mergeRoutePayload({
      base: { cidrs: ["198.51.100.0/24"], domains: [] },
      global: profile({ exclude: { cidrs: ["198.51.100.0/25"] } }),
    });
    expect(punched.cidrs).toEqual(["198.51.100.128/25"]);

    // Bare IP exclusions (stored as host literals without /32) punch a /32 hole.
    const bareExcluded = mergeRoutePayload({
      base: { cidrs: ["198.51.100.0/30"], domains: [] },
      global: profile({ exclude: { cidrs: ["198.51.100.0"] } }),
    });
    expect(bareExcluded.cidrs).toEqual([
      "198.51.100.1/32",
      "198.51.100.2/31",
    ]);

    // IPv6 exclusions punch holes out of enclosing IPv6 supernets too.
    const punchedV6 = mergeRoutePayload({
      base: { cidrs: ["2001:db8::/32"], domains: [] },
      global: profile({ exclude: { cidrs: ["2001:db8:8000::/33"] } }),
    });
    expect(punchedV6.cidrs).toEqual(["2001:db8::/33"]);
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
