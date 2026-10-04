import { describe, expect, it } from "vitest";
import { subtractCidrs } from "./cidrSet.js";

describe("subtractCidrs", () => {
  it("leaves prefixes the exclusion does not touch, in address order", () => {
    const result = subtractCidrs(["203.0.113.0/24", "198.51.100.7/32"], ["192.0.2.0/24"]);
    expect(result).toEqual({
      cidrs: ["198.51.100.7/32", "203.0.113.0/24"],
      touched: 0,
      removedShare: { 4: 0, 6: 0 },
    });
  });

  it("compacts nested and adjacent prefixes even with nothing excluded", () => {
    // A /24 inside a /16 adds no address; two halves make one whole.
    expect(
      subtractCidrs(["10.0.0.0/16", "10.0.5.0/24", "192.0.2.0/25", "192.0.2.128/25"], [])
        .cidrs,
    ).toEqual(["10.0.0.0/16", "192.0.2.0/24"]);
  });

  it("passes an unparseable entry through rather than dropping it", () => {
    expect(subtractCidrs(["not-a-cidr", "10.0.0.0/24"], []).cidrs).toEqual([
      "not-a-cidr",
      "10.0.0.0/24",
    ]);
  });

  it("drops a prefix the exclusion covers whole", () => {
    const result = subtractCidrs(["10.1.2.0/24", "203.0.113.0/24"], ["10.0.0.0/8"]);
    expect(result.cidrs).toEqual(["203.0.113.0/24"]);
    expect(result.touched).toBe(1);
  });

  it("splits a wide prefix around an excluded hole into the fewest prefixes", () => {
    // 10.0.0.0/8 minus 10.128.0.0/9 is exactly 10.0.0.0/9.
    expect(subtractCidrs(["10.0.0.0/8"], ["10.128.0.0/9"]).cidrs).toEqual(["10.0.0.0/9"]);
    // A hole in the middle leaves both sides, each as aligned blocks.
    expect(subtractCidrs(["10.0.0.0/22"], ["10.0.1.0/24"]).cidrs).toEqual([
      "10.0.0.0/24",
      "10.0.2.0/23",
    ]);
  });

  it("handles several holes in one prefix, including overlapping exclusions", () => {
    expect(
      subtractCidrs(["10.0.0.0/24"], ["10.0.0.0/26", "10.0.0.32/27", "10.0.0.192/26"]).cidrs,
    ).toEqual(["10.0.0.64/26", "10.0.0.128/26"]);
  });

  it("reports the share of included addresses removed", () => {
    const result = subtractCidrs(["10.0.0.0/8", "203.0.113.0/24"], ["10.0.0.0/9"]);
    // 2^23 of 2^24 + 2^8 addresses.
    expect(result.removedShare[4]).toBeCloseTo(0.4999, 3);
    expect(result.removedShare[6]).toBe(0);
  });

  it("normalises host bits before comparing", () => {
    expect(subtractCidrs(["10.0.0.77/24"], ["10.0.0.0/25"]).cidrs).toEqual([
      "10.0.0.128/25",
    ]);
  });

  it("subtracts IPv6 the same way and leaves the other family alone", () => {
    const result = subtractCidrs(
      ["2001:db8::/32", "203.0.113.0/24"],
      ["2001:db8:8000::/33", "::ffff:203.0.113.0/120"],
    );
    expect(result.cidrs).toEqual(["203.0.113.0/24", "2001:db8::/33"]);
    expect(result.removedShare[6]).toBe(0.5);
  });

  it("writes split IPv6 prefixes in compressed form", () => {
    expect(subtractCidrs(["2001:db8::/126"], ["2001:db8::/127"]).cidrs).toEqual([
      "2001:db8::2/127",
    ]);
  });

  it("returns each resulting prefix once", () => {
    expect(
      subtractCidrs(["10.0.0.0/23", "10.0.0.0/23"], ["10.0.1.0/24"]).cidrs,
    ).toEqual(["10.0.0.0/24"]);
  });

  it("covers exactly the same addresses after compaction", () => {
    // Random prefixes and holes, checked address by address over a /16.
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % limit;
    };
    const prefix = () => {
      const length = 18 + next(10);
      const size = 2 ** (32 - length);
      const start = Math.floor(next(65536) / size) * size;
      return { cidr: `10.0.${start >> 8}.${start & 255}/${length}`, start, size };
    };
    const include = Array.from({ length: 40 }, prefix);
    const exclude = Array.from({ length: 15 }, prefix);
    const inSet = (set: Array<{ start: number; size: number }>, address: number) =>
      set.some(({ start, size }) => address >= start && address < start + size);
    const result = subtractCidrs(
      include.map((entry) => entry.cidr),
      exclude.map((entry) => entry.cidr),
    ).cidrs.map((cidr) => {
      const [address = "", length = ""] = cidr.split("/");
      const [, , third = 0, fourth = 0] = address.split(".").map(Number);
      return { start: third * 256 + fourth, size: 2 ** (32 - Number(length)) };
    });
    const wrong: number[] = [];
    for (let address = 0; address < 65536; address += 1) {
      const expected = inSet(include, address) && !inSet(exclude, address);
      if (inSet(result, address) !== expected) wrong.push(address);
    }
    expect(wrong).toEqual([]);
  });
});
