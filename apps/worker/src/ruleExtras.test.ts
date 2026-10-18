import { describe, expect, it } from "vitest";
import { RULE_EXTRAS } from "./ruleExtras.js";
import { validateRuleObject } from "./rules.js";

describe("RULE_EXTRAS", () => {
  it("names every extra by a unique slug", () => {
    const names = RULE_EXTRAS.map((extra) => extra.name);
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries only valid prefixes", () => {
    // A typo here would fail every fetch tick, so it has to fail CI first.
    for (const extra of RULE_EXTRAS) {
      expect(extra.cidrs.length, extra.name).toBeGreaterThan(0);
      const validation = validateRuleObject({ cidrs: extra.cidrs, domains: [] });
      expect(validation.ok, extra.name).toBe(true);
      expect(validation.payload.cidrs, extra.name).toHaveLength(extra.cidrs.length);
    }
  });

  it("routes the Wardogs match servers through the tunnel", () => {
    const wardogs = RULE_EXTRAS.find((extra) => extra.name === "wardogs");
    expect(wardogs?.cidrs).toEqual(["54.115.0.0/16", "85.236.96.0/21", "85.236.104.0/23"]);
  });
});
