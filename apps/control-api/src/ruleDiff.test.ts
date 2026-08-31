import { describe, expect, it } from "vitest";
import { diffRulePayloads } from "./ruleDiff.js";

describe("diffRulePayloads", () => {
  it("reports added and removed cidrs and domains with counts", () => {
    const base = {
      cidrs: ["1.0.0.0/8", "2.0.0.0/8"],
      domains: ["a.com", "b.com"],
    };
    const next = {
      cidrs: ["2.0.0.0/8", "3.0.0.0/8"],
      domains: ["b.com", "c.com"],
    };

    const diff = diffRulePayloads(base, next);

    expect(diff.cidrs.added).toEqual(["3.0.0.0/8"]);
    expect(diff.cidrs.removed).toEqual(["1.0.0.0/8"]);
    expect(diff.cidrs.addedCount).toBe(1);
    expect(diff.cidrs.removedCount).toBe(1);
    expect(diff.domains.added).toEqual(["c.com"]);
    expect(diff.domains.removed).toEqual(["a.com"]);
  });

  it("caps sample lists but keeps full counts", () => {
    const next = {
      cidrs: Array.from({ length: 120 }, (_, index) => `10.0.${index}.0/24`),
      domains: [],
    };
    const diff = diffRulePayloads({ cidrs: [], domains: [] }, next);

    expect(diff.cidrs.addedCount).toBe(120);
    expect(diff.cidrs.added).toHaveLength(50);
  });
});
