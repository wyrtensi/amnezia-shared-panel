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

  it("includes Google/YouTube dual-stack and Anthropic prefixes", () => {
    const google = RULE_EXTRAS.find((extra) => extra.name === "google-youtube");
    expect(google?.cidrs).toContain("142.250.0.0/15");
    expect(google?.cidrs).toContain("2a00:1450::/32");
    const anthropic = RULE_EXTRAS.find((extra) => extra.name === "anthropic");
    expect(anthropic?.cidrs).toContain("160.79.104.0/23");
  });

  it("includes only the four exact Genshin SDK DNS prefixes", () => {
    const genshin = RULE_EXTRAS.find((extra) => extra.name === "genshin-sdk-dns-2026-11-21");
    expect(genshin?.exact).toBe(true);
    expect(genshin?.cidrs).toEqual([
      "171.43.164.91/32",
      "171.43.164.92/30",
      "171.43.164.96/31",
      "171.43.164.98/32",
    ]);
  });

  it("includes exact Yahoo EU, expertizeme, and missed foreign service supernets", () => {
    const byName = new Map(RULE_EXTRAS.map((extra) => [extra.name, extra]));
    expect(byName.get("yahoo-eu")).toMatchObject({
      exact: true,
      cidrs: ["87.248.96.0/19", "188.125.64.0/19", "212.82.96.0/19", "2a00:1288::/32"],
    });
    expect(byName.get("expertizeme")).toMatchObject({
      exact: true,
      cidrs: ["176.98.186.130/32"],
    });
    for (const slug of [
      "proton",
      "tuta",
      "mega",
      "fastly",
      "gcp-linkedin",
      "wikimedia",
      "bitbucket",
      "faceit",
      "mangadex",
      "riot-eu-dns-2026-11-22",
      "major-cdn-v6",
      "azure-clarity",
    ]) {
      expect(byName.get(slug)?.exact, slug).toBe(true);
    }
    expect(byName.get("azure-clarity")?.cidrs).toEqual(["23.96.0.0/13"]);
  });
});
