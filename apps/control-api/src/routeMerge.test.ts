import { describe, expect, it } from "vitest";
import { globalRouteProfileSchema } from "@amnezia/contracts";
import { isDomainExcluded, mergeRoutePayload } from "./routeMerge.js";

const profile = (input: unknown) => globalRouteProfileSchema.parse(input);

describe("isDomainExcluded", () => {
  it("matches a domain exactly", () => {
    expect(isDomainExcluded("example.com", new Set(["example.com"]))).toBe(true);
  });

  it("matches every subdomain of an excluded parent zone", () => {
    const excluded = new Set(["example.com"]);
    expect(isDomainExcluded("a.b.example.com", excluded)).toBe(true);
    expect(isDomainExcluded("cdn.example.com", excluded)).toBe(true);
  });

  it("does not match on a bare string suffix", () => {
    // "notexample.com" ends with "example.com" as text but is a different zone.
    expect(isDomainExcluded("notexample.com", new Set(["example.com"]))).toBe(
      false,
    );
  });

  it("does not treat a subdomain exclusion as covering its parent", () => {
    expect(isDomainExcluded("example.com", new Set(["cdn.example.com"]))).toBe(
      false,
    );
  });

  it("returns false when nothing is excluded", () => {
    expect(isDomainExcluded("example.com", new Set())).toBe(false);
  });
});

describe("mergeRoutePayload", () => {
  const base = {
    cidrs: ["10.0.0.0/8", "192.0.2.0/24"],
    domains: ["blocked.ru", "cdn.example.com", "example.com", "keep.org"],
  };

  it("returns the base feed unchanged when nothing is configured", () => {
    expect(mergeRoutePayload({ base })).toEqual(base);
  });

  it("drops excluded CIDRs by exact match only", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({ exclude: { cidrs: ["10.0.0.0/8"] } }),
    });

    expect(merged.cidrs).toEqual(["192.0.2.0/24"]);
  });

  it("drops an excluded domain together with its subdomains", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({ exclude: { domains: ["example.com"] } }),
    });

    expect(merged.domains).toEqual(["blocked.ru", "keep.org"]);
  });

  it("applies the admin additions after the exclusions", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({
        add: { cidrs: ["203.0.113.0/24"], domains: ["extra.io"] },
        exclude: { cidrs: ["10.0.0.0/8"], domains: ["blocked.ru"] },
      }),
    });

    expect(merged.cidrs).toEqual(["192.0.2.0/24", "203.0.113.0/24"]);
    expect(merged.domains).toEqual([
      "cdn.example.com",
      "example.com",
      "keep.org",
      "extra.io",
    ]);
  });

  it("lets a user's own routes re-add what the admin excluded", () => {
    const merged = mergeRoutePayload({
      base,
      global: profile({
        exclude: { cidrs: ["10.0.0.0/8"], domains: ["example.com"] },
      }),
      userExtra: { cidrs: ["10.0.0.0/8"], domains: ["cdn.example.com"] },
    });

    expect(merged.cidrs).toContain("10.0.0.0/8");
    expect(merged.domains).toContain("cdn.example.com");
    // Only the entry the user opted back into returns; the rest stays excluded.
    expect(merged.domains).not.toContain("example.com");
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
      global: profile({ add: { domains: ["only.example"] } }),
      userExtra: { domains: ["mine.example"] },
    });

    expect(merged).toEqual({
      cidrs: [],
      domains: ["only.example", "mine.example"],
    });
  });

  it("ignores case when matching excluded domains", () => {
    const merged = mergeRoutePayload({
      base: { cidrs: [], domains: ["CDN.Example.COM"] },
      global: profile({ exclude: { domains: ["example.com"] } }),
    });

    expect(merged.domains).toEqual([]);
  });
});
