import { describe, expect, it } from "vitest";
import { complementIpv4, WHITELIST_GAP_MERGE } from "./routeComplement.js";

/** Addresses the complement covers, for asserting on exact coverage. */
const covered = (cidrs: string[]): number =>
  cidrs.reduce((sum, cidr) => sum + 2 ** (32 - Number(cidr.split("/")[1])), 0);

describe("complementIpv4", () => {
  it("returns the whole space when nothing is carved out", () => {
    expect(complementIpv4([])).toEqual(["0.0.0.0/0"]);
  });

  it("returns nothing when the default route is carved out", () => {
    expect(complementIpv4(["0.0.0.0/0"])).toEqual([]);
  });

  it("splits the space around a single carved-out block", () => {
    expect(complementIpv4(["128.0.0.0/1"], 0)).toEqual(["0.0.0.0/1"]);
  });

  it("subtracts a prefix exactly when no gap is absorbed", () => {
    const complement = complementIpv4(["10.0.0.0/8"], 0);
    expect(complement).toContain("11.0.0.0/8");
    expect(complement).not.toContain("10.0.0.0/8");
    expect(covered(complement)).toBe(2 ** 32 - 2 ** 24);
  });

  it("keeps every listed prefix out of the complement, gap merging or not", () => {
    // 10.0.0.0/32 and 10.0.0.64/32 sit 63 addresses apart: merging swallows the
    // hole between them, but neither host may ever appear in the complement.
    for (const maxGap of [0, 64]) {
      const complement = complementIpv4(["10.0.0.0/32", "10.0.0.64/32"], maxGap);
      expect(complement).not.toContain("10.0.0.0/32");
      expect(complement).not.toContain("10.0.0.64/32");
    }
  });

  it("absorbs a hole no wider than maxGap and nothing wider", () => {
    const pair = ["10.0.0.0/32", "10.0.0.64/32"];
    // The hole is 10.0.0.1 - 10.0.0.63, so 63 addresses.
    const absorbed = complementIpv4(pair, 63);
    const kept = complementIpv4(pair, 62);
    expect(covered(absorbed)).toBe(2 ** 32 - 65);
    expect(covered(kept)).toBe(2 ** 32 - 2);
    expect(absorbed.length).toBeLessThan(kept.length);
  });

  it("merges adjacent and overlapping inputs", () => {
    const complement = complementIpv4(["10.0.0.0/9", "10.128.0.0/9"], 0);
    expect(complement).toContain("11.0.0.0/8");
    expect(complement.filter((cidr) => cidr.startsWith("10."))).toEqual([]);
  });

  it("ignores IPv6 and malformed entries instead of failing", () => {
    expect(
      complementIpv4(["::/0", "not-a-cidr", "10.0.0.0/33", "0.0.0.0/0"]),
    ).toEqual([]);
  });

  it("covers every address outside the input exactly once", () => {
    const complement = complementIpv4(["10.0.0.0/8", "192.168.0.0/16"], 0);
    expect(covered(complement)).toBe(2 ** 32 - 2 ** 24 - 2 ** 16);
  });

  it("shrinks a fragmented list far below its exact inverse", () => {
    // 512 scattered hosts inside one /16 — the shape the RoscomVPN whitelist
    // has, and the reason the exact inverse does not fit in a Binder parcel.
    const hosts = Array.from({ length: 512 }, (_, index) => {
      const third = index % 256;
      const fourth = (index * 7) % 256;
      return `203.0.${third}.${fourth}/32`;
    });
    expect(complementIpv4(hosts, WHITELIST_GAP_MERGE).length).toBeLessThan(
      complementIpv4(hosts, 0).length,
    );
  });

  it("defaults to the documented gap threshold", () => {
    expect(WHITELIST_GAP_MERGE).toBe(32);
    expect(complementIpv4(["10.0.0.0/32", "10.0.0.16/32"])).toEqual(
      complementIpv4(["10.0.0.0/32", "10.0.0.16/32"], WHITELIST_GAP_MERGE),
    );
  });
});
