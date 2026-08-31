import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRuleFetcher,
  mergeRulePayloads,
  parseRuleSource,
  validateRulePayload,
  type RuleRepository,
} from "./rules.js";

const stableChecksum = (payload: {
  cidrs: string[];
  domains: string[];
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        cidrs: [...payload.cidrs].sort(),
        domains: [...payload.domains].sort(),
      }),
    )
    .digest("hex");

describe("routing rule validation", () => {
  it("normalizes and deduplicates a bounded JSON ruleset", () => {
    expect(
      validateRulePayload(
        JSON.stringify({
          cidrs: ["203.0.113.0/24", "203.0.113.0/24"],
          domains: ["Example.RU", "example.ru"],
        }),
      ),
    ).toEqual({
      ok: true,
      payload: { cidrs: ["203.0.113.0/24"], domains: ["example.ru"] },
      report: { cidrCount: 1, domainCount: 1 },
    });
  });

  it("rejects a version that is mostly malformed", () => {
    expect(
      validateRulePayload(
        JSON.stringify({ cidrs: ["203.0.113.0/99"], domains: ["example.ru"] }),
      ),
    ).toMatchObject({ ok: false, report: { invalidEntries: ["203.0.113.0/99"] } });
  });

  it("drops a few invalid entries but keeps a mostly-valid ruleset", () => {
    const cidrs = Array.from({ length: 20 }, (_, index) => `10.${index}.0.0/24`);
    const result = validateRulePayload(
      JSON.stringify({ cidrs: [...cidrs, "203.0.113.0/99"], domains: ["a.com"] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.cidrs).not.toContain("203.0.113.0/99");
      expect(result.payload.domains).toContain("a.com");
      expect(result.report.droppedInvalid).toBe(1);
    }
  });

  it("accepts punycode IDN (.рф) domains", () => {
    expect(
      validateRulePayload(
        JSON.stringify({ cidrs: [], domains: ["xn--80aswg.xn--p1ai"] }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("feed source parsing", () => {
  it("parses line-based cidr and domain feeds, ignoring comments", () => {
    expect(
      parseRuleSource("1.2.3.0/24\n# comment\n\n4.5.6.0/24 # inline", "cidr-lines"),
    ).toEqual({ cidrs: ["1.2.3.0/24", "4.5.6.0/24"], domains: [] });
    expect(parseRuleSource("example.ru\n# note\nblocked.ru", "domain-lines")).toEqual(
      { cidrs: [], domains: ["example.ru", "blocked.ru"] },
    );
  });

  it("merges and deduplicates payloads from several sources", () => {
    expect(
      mergeRulePayloads([
        { cidrs: ["1.0.0.0/8"], domains: ["a.ru"] },
        { cidrs: ["1.0.0.0/8", "2.0.0.0/8"], domains: ["b.ru"] },
      ]),
    ).toEqual({ cidrs: ["1.0.0.0/8", "2.0.0.0/8"], domains: ["a.ru", "b.ru"] });
  });
});

describe("RoscomVPN rule ingestion", () => {
  const sourceBody = JSON.stringify({
    cidrs: ["203.0.113.0/24"],
    domains: ["example.ru"],
  });
  const checksum = stableChecksum({
    cidrs: ["203.0.113.0/24"],
    domains: ["example.ru"],
  });

  const createRepository = (): RuleRepository => ({
    getLastKnownGoodRule: vi.fn(() =>
      Promise.resolve({ version: "old-checksum", etag: '"old-etag"' }),
    ),
    storeQuarantinedRule: vi.fn(() => Promise.resolve()),
    activateRuleVersion: vi.fn(() => Promise.resolve()),
  });

  const jsonFeed = {
    profile: "ru_whitelist" as const,
    sources: [
      { url: "https://rules.example/roscomvpn.json", format: "json" as const },
    ],
    pocApproved: true,
  };

  it("skips storing when the merged checksum is unchanged", async () => {
    const repository = createRepository();
    vi.mocked(repository.getLastKnownGoodRule).mockResolvedValue({
      version: checksum,
      etag: null,
    });
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() => Promise.resolve(new Response(sourceBody))),
    });

    await fetchRules();

    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
    expect(repository.storeQuarantinedRule).not.toHaveBeenCalled();
  });

  it("quarantines a valid version before PoC approval", async () => {
    const repository = createRepository();
    const fetchRules = createRuleFetcher({
      repository,
      feed: { ...jsonFeed, pocApproved: false },
      fetchImpl: vi.fn(() =>
        Promise.resolve(
          new Response(sourceBody, {
            status: 200,
            headers: { etag: '"new-etag"' },
          }),
        ),
      ),
    });

    await fetchRules();

    const quarantined = vi.mocked(repository.storeQuarantinedRule).mock
      .calls[0]?.[0];
    expect(quarantined).toMatchObject({
      profile: "ru_whitelist",
      version: checksum,
      checksum,
    });
    expect(quarantined?.validationReport).toMatchObject({
      reason: "poc_gate_closed",
    });
    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
  });

  it("quarantines an invalid new version and preserves last-known-good", async () => {
    const repository = createRepository();
    const invalidBody = JSON.stringify({ cidrs: ["not-a-cidr"], domains: [] });
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() => Promise.resolve(new Response(invalidBody))),
    });

    await fetchRules();

    expect(repository.storeQuarantinedRule).toHaveBeenCalledOnce();
    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
  });

  it("atomically activates a validated version only after PoC approval", async () => {
    const repository = createRepository();
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() => Promise.resolve(new Response(sourceBody))),
    });

    await fetchRules();

    expect(repository.activateRuleVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: checksum, checksum }),
    );
  });

  it("merges a multi-source blacklist feed of cidr and domain lines", async () => {
    const repository = createRepository();
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        new Response(
          (input as string).endsWith("cidrs.lst")
            ? "198.51.100.0/24"
            : "blocked.ru",
        ),
      ),
    );
    const fetchRules = createRuleFetcher({
      repository,
      feed: {
        profile: "ru_blacklist",
        sources: [
          { url: "https://feed.example/cidrs.lst", format: "cidr-lines" },
          { url: "https://feed.example/domains.lst", format: "domain-lines" },
        ],
        pocApproved: true,
      },
      fetchImpl,
    });

    await fetchRules();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(repository.activateRuleVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "ru_blacklist",
        payload: { cidrs: ["198.51.100.0/24"], domains: ["blocked.ru"] },
      }),
    );
  });

  it("rejects an oversized response from Content-Length before reading its body", async () => {
    const repository = createRepository();
    const response = new Response(sourceBody, {
      headers: { "content-length": String(11 * 1024 * 1024) },
    });
    const textSpy = vi.spyOn(response, "text");
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() => Promise.resolve(response)),
    });

    await expect(fetchRules()).rejects.toThrow("too large");
    expect(textSpy).not.toHaveBeenCalled();
    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
    expect(repository.storeQuarantinedRule).not.toHaveBeenCalled();
  });
});
