import { describe, expect, it } from "vitest";
import {
  ALIEXPRESS_DIRECT_V4_CIDRS,
  APPLE_DIRECT_V4_CIDRS,
  BOGON_V4_CIDRS,
  BOGON_V6_CIDRS,
  STEAM_CACHE_V4_CIDRS,
  complementCidrs,
  countCidrOverlap,
  expandExclusionsSafely,
  measureCidrSpace,
  normalizeCidrOrIp,
  splitCidrsByFamily,
  subtractCidrs,
  subtractCidrsPreservingUntouched,
  supernetCidrsSafely,
} from "./cidrSet.js";

describe("cidrSet helpers", () => {
  it("normalizes bare IPv4 and IPv6 literals to host prefixes", () => {
    expect(normalizeCidrOrIp("1.1.1.1")).toBe("1.1.1.1/32");
    expect(normalizeCidrOrIp("2606:4700:4700::1111")).toBe(
      "2606:4700:4700::1111/128",
    );
    expect(normalizeCidrOrIp("198.51.100.0/24")).toBe("198.51.100.0/24");
    expect(normalizeCidrOrIp("not-an-ip")).toBe("not-an-ip");
  });

  it("splits prefixes by family and measures space and overlap exactly", () => {
    const cidrs = ["198.51.100.0/24", "2001:db8::/32"];
    expect(splitCidrsByFamily(cidrs)).toEqual({
      4: ["198.51.100.0/24"],
      6: ["2001:db8::/32"],
    });
    expect(measureCidrSpace(cidrs)).toEqual({
      4: 256n,
      6: 1n << 96n,
    });
    expect(
      countCidrOverlap(["198.51.100.0/24"], ["198.51.100.128/25"]),
    ).toEqual({ 4: 128n, 6: 0n });
  });

  it("exposes valid non-overlapping direct shield constants", () => {
    for (const list of [
      BOGON_V4_CIDRS,
      BOGON_V6_CIDRS,
      APPLE_DIRECT_V4_CIDRS,
      STEAM_CACHE_V4_CIDRS,
      ALIEXPRESS_DIRECT_V4_CIDRS,
    ]) {
      expect(list.length).toBeGreaterThan(0);
      const compacted = subtractCidrs(list, []).cidrs;
      expect(compacted.length).toBeGreaterThan(0);
    }
    // Apple, SteamCache, and AliExpress must stay outside RFC1918/bogon space.
    expect(countCidrOverlap(APPLE_DIRECT_V4_CIDRS, BOGON_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(STEAM_CACHE_V4_CIDRS, BOGON_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(ALIEXPRESS_DIRECT_V4_CIDRS, BOGON_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(APPLE_DIRECT_V4_CIDRS, STEAM_CACHE_V4_CIDRS)[4]).toBe(
      0n,
    );
    expect(countCidrOverlap(ALIEXPRESS_DIRECT_V4_CIDRS, APPLE_DIRECT_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(ALIEXPRESS_DIRECT_V4_CIDRS, STEAM_CACHE_V4_CIDRS)[4]).toBe(0n);
  });
});

describe("supernetCidrsSafely", () => {
  it("collapses nearby prefixes across a safe gap without touching forbidden space", () => {
    // 198.51.100.0/25 and 198.51.100.192/26 sit inside 198.51.100.0/24 with a
    // clean /26 gap at .128/26; forbidden lives outside in 198.51.101.0/24.
    const result = supernetCidrsSafely(
      ["198.51.100.0/25", "198.51.100.192/26"],
      ["198.51.101.0/24"],
    );

    expect(result.cidrs).toEqual(["198.51.100.0/24"]);
    expect(result.losslessCount).toBe(2);
    expect(result.compactedCount).toBe(1);
    expect(result.extraSpace[4]).toBe(64n);
    expect(countCidrOverlap(result.cidrs, ["198.51.101.0/24"])[4]).toBe(0n);
  });

  it("refuses to merge across a forbidden prefix sitting in the gap", () => {
    const result = supernetCidrsSafely(
      ["198.51.100.0/26", "198.51.100.192/26"],
      ["198.51.100.128/26"],
    );

    expect(result.cidrs).toEqual(["198.51.100.0/26", "198.51.100.192/26"]);
    expect(result.extraSpace[4]).toBe(0n);
    expect(countCidrOverlap(result.cidrs, ["198.51.100.128/26"])[4]).toBe(0n);
  });

  it("honors maxExtraIps budget and picks the cheapest merges first", () => {
    // Pair A: 198.51.100.0/26 + .64/26 are already adjacent (lossless /25).
    // Pair B: 198.51.100.0/25 + .192/26 -> costs 64 extra IPs to save 1 route.
    // Pair C: 203.0.113.0/26 + 203.0.113.128/26 -> costs 128 extra IPs (the whole /24).
    const include = [
      "198.51.100.0/25",
      "198.51.100.192/26",
      "203.0.113.0/26",
      "203.0.113.128/26",
    ];
    const result = supernetCidrsSafely(include, [], {
      maxExtraIps: { 4: 80n },
    });

    expect(result.cidrs).toEqual([
      "198.51.100.0/24",
      "203.0.113.0/26",
      "203.0.113.128/26",
    ]);
    expect(result.extraSpace[4]).toBe(64n);
  });

  it("stops collapsing once maxRoutes is reached", () => {
    const include = [
      "198.51.100.0/26",
      "198.51.100.128/26",
      "203.0.113.0/26",
      "203.0.113.128/26",
    ];
    const result = supernetCidrsSafely(include, [], {
      maxRoutes: { 4: 3 },
    });
    expect(result.countsByFamily[4]).toBe(3);
  });

  it("compacts IPv6 safely inside 2000::/3 without touching forbidden IPv6", () => {
    const include = ["2a03:2880::/36", "2a03:2880:f000::/36"];
    const forbidden = [...BOGON_V6_CIDRS, "2a02:6b8::/32"];
    const result = supernetCidrsSafely(include, forbidden);

    expect(result.cidrs).toEqual(["2a03:2880::/32"]);
    expect(countCidrOverlap(result.cidrs, forbidden)[6]).toBe(0n);
    expect(subtractCidrs(include, result.cidrs).cidrs).toEqual([]);
  });

  it("never overlaps forbidden space and never drops included addresses on randomized inputs", () => {
    let seed = 42;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % limit;
    };
    const randomPrefix = () => {
      const length = 20 + next(8);
      const size = 2 ** (32 - length);
      const start = Math.floor(next(65536) / size) * size;
      return `198.51.${start >> 8}.${start & 255}/${length}`;
    };
    const include = Array.from({ length: 80 }, randomPrefix);
    const forbidden = Array.from({ length: 25 }, randomPrefix);

    const expectedKept = subtractCidrs(include, forbidden).cidrs;
    const result = supernetCidrsSafely(include, forbidden, {
      maxExtraIps: { 4: 8192n },
    });

    expect(result.compactedCount).toBeLessThanOrEqual(result.losslessCount);
    expect(countCidrOverlap(result.cidrs, forbidden)[4]).toBe(0n);
    expect(subtractCidrs(expectedKept, result.cidrs).cidrs).toEqual([]);
    // Deterministic across repeated invocations and input reorderings.
    const reversed = supernetCidrsSafely([...include].reverse(), forbidden, {
      maxExtraIps: { 4: 8192n },
    });
    expect(reversed.cidrs).toEqual(result.cidrs);
  });
});

describe("expandExclusionsSafely and complementCidrs", () => {
  it("expands exclusions around protected ranges and builds a clean complement", () => {
    const ru = ["5.255.255.0/24", "5.255.252.0/24"];
    const protectedServices = ["157.240.0.0/16", "104.16.0.0/13"];
    const expanded = expandExclusionsSafely(ru, protectedServices);
    const complement = complementCidrs([...expanded.cidrs, ...BOGON_V4_CIDRS], 4);

    // Zero overlap with RU or bogons; 100% of protected services remain routed.
    expect(countCidrOverlap(complement, ru)[4]).toBe(0n);
    expect(countCidrOverlap(complement, BOGON_V4_CIDRS)[4]).toBe(0n);
    expect(subtractCidrs(protectedServices, complement).cidrs).toEqual([]);
  });
});

describe("subtractCidrsPreservingUntouched", () => {
  it("punches CIDR holes in overlapping prefixes while leaving untouched prefixes verbatim", () => {
    const input = ["10.0.0.0/24", "10.0.1.0/24", "198.51.100.0/24"];
    // Adjacent 10.0.0.0/24 + 10.0.1.0/24 stay separate because neither overlaps
    // the exclusion; only 198.51.100.0/24 is split around 198.51.100.0/25.
    const result = subtractCidrsPreservingUntouched(input, ["198.51.100.0/25"]);
    expect(result).toEqual([
      "10.0.0.0/24",
      "10.0.1.0/24",
      "198.51.100.128/25",
    ]);
  });
});
