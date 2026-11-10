import { describe, expect, it } from "vitest";

import {
  AWG_PROFILE_GAP,
  AWG_PROFILE_JC,
  AWG_PROFILE_JMIN,
  awgClientProfileV1Schema,
  profileOrder,
  selectAwgClientProfile,
} from "./awgClientProfile.js";

const valid = { version: 1, revision: 1, jc: 5, jmin: 50, jmax: 120, cpsOrder: 0 };

describe("awgClientProfileV1Schema", () => {
  it("accepts a profile inside every bound, inclusive", () => {
    expect(awgClientProfileV1Schema.safeParse(valid).success).toBe(true);
    for (const profile of [
      { ...valid, jc: 3, jmin: 40, jmax: 70, cpsOrder: 0 },
      { ...valid, jc: 10, jmin: 100, jmax: 300, cpsOrder: 5 },
    ]) {
      expect(awgClientProfileV1Schema.safeParse(profile).success).toBe(true);
    }
  });

  it.each([
    ["jc below range", { jc: 2 }],
    ["jc above range", { jc: 11 }],
    ["jmin below range", { jmin: 39, jmax: 100 }],
    ["jmin above range", { jmin: 101, jmax: 200 }],
    ["gap too small", { jmin: 50, jmax: 79 }],
    ["gap too large", { jmin: 50, jmax: 251 }],
    ["fractional jc", { jc: 5.5 }],
    ["revision 0", { revision: 0 }],
    ["order 6", { cpsOrder: 6 }],
    ["negative order", { cpsOrder: -1 }],
    ["another version", { version: 2 }],
    ["an extra field", { extra: true }],
  ])("rejects %s", (_name, patch) => {
    expect(awgClientProfileV1Schema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("selectAwgClientProfile", () => {
  it("draws every field inside its bounds and keeps the revision", () => {
    for (let n = 0; n < 2000; n += 1) {
      const profile = selectAwgClientProfile(7);
      expect(profile.revision).toBe(7);
      expect(profile.version).toBe(1);
      expect(profile.jc).toBeGreaterThanOrEqual(AWG_PROFILE_JC.min);
      expect(profile.jc).toBeLessThanOrEqual(AWG_PROFILE_JC.max);
      expect(profile.jmin).toBeGreaterThanOrEqual(AWG_PROFILE_JMIN.min);
      expect(profile.jmin).toBeLessThanOrEqual(AWG_PROFILE_JMIN.max);
      expect(profile.jmax - profile.jmin).toBeGreaterThanOrEqual(AWG_PROFILE_GAP.min);
      expect(profile.jmax - profile.jmin).toBeLessThanOrEqual(AWG_PROFILE_GAP.max);
      expect(awgClientProfileV1Schema.safeParse(profile).success).toBe(true);
    }
  });

  it("reaches both ends of every range over many draws", () => {
    const jc = new Set<number>();
    const order = new Set<number>();
    let jminLow = false;
    let jminHigh = false;
    for (let n = 0; n < 5000; n += 1) {
      const profile = selectAwgClientProfile(1);
      jc.add(profile.jc);
      order.add(profile.cpsOrder);
      jminLow ||= profile.jmin === AWG_PROFILE_JMIN.min;
      jminHigh ||= profile.jmin === AWG_PROFILE_JMIN.max;
    }
    expect([...jc].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(jminLow && jminHigh).toBe(true);
  });

  it("never repeats an in-range previous Jc, and still reaches the other seven", () => {
    for (const previous of [3, 6, 10]) {
      const seen = new Set<number>();
      for (let n = 0; n < 3000; n += 1) {
        const { jc } = selectAwgClientProfile(2, previous);
        expect(jc).not.toBe(previous);
        seen.add(jc);
      }
      expect(seen.size).toBe(7);
    }
  });

  it("ignores a previous Jc that is outside the range", () => {
    const seen = new Set<number>();
    for (let n = 0; n < 3000; n += 1) seen.add(selectAwgClientProfile(2, 42).jc);
    expect(seen.size).toBe(8);
  });
});

describe("profileOrder", () => {
  it("maps an index onto the orders of two or three entries", () => {
    expect(profileOrder(0, 3)).toEqual([0, 1, 2]);
    expect(profileOrder(5, 3)).toEqual([2, 1, 0]);
    expect(profileOrder(0, 2)).toEqual([0, 1]);
    expect(profileOrder(1, 2)).toEqual([1, 0]);
    expect(profileOrder(4, 2)).toEqual([0, 1]);
  });

  it("covers all six orders of three, and leaves one entry alone", () => {
    const all = new Set([0, 1, 2, 3, 4, 5].map((i) => profileOrder(i, 3).join("")));
    expect(all.size).toBe(6);
    expect(profileOrder(3, 1)).toEqual([0]);
    expect(profileOrder(3, 0)).toEqual([]);
  });
});
