import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRuleFetcher,
  DEFAULT_RULE_FEEDS,
  mergeRulePayloads,
  parseRuleSource,
  resolveRuleFeeds,
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

describe("rule feed ingestion", () => {
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
      Promise.resolve({
        version: "old-checksum",
        etag: '"old-etag"',
        pinned: false,
      }),
    ),
    storeQuarantinedRule: vi.fn(() => Promise.resolve()),
    storeUnpublishedRule: vi.fn(() => Promise.resolve()),
    activateRuleVersion: vi.fn(() => Promise.resolve()),
  });

  const jsonFeed = {
    profile: "ru_blacklist" as const,
    sources: [
      { url: "https://rules.example/blacklist.json", format: "json" as const },
    ],
    pocApproved: true,
  };

  it("skips storing when the merged checksum is unchanged", async () => {
    const repository = createRepository();
    vi.mocked(repository.getLastKnownGoodRule).mockResolvedValue({
      version: checksum,
      etag: null,
      pinned: false,
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
      profile: "ru_blacklist",
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

  it("records but does not publish a new version while the profile is pinned", async () => {
    // The admin picked a version by hand. Silently republishing over that on
    // the next tick is exactly what the pin exists to prevent — but the new
    // version must still be recorded, or the admin cannot see or diff it.
    const repository = createRepository();
    vi.mocked(repository.getLastKnownGoodRule).mockResolvedValue({
      version: "pinned-checksum",
      etag: null,
      pinned: true,
    });
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() => Promise.resolve(new Response(sourceBody))),
    });

    await fetchRules();

    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
    expect(repository.storeQuarantinedRule).not.toHaveBeenCalled();
    expect(repository.storeUnpublishedRule).toHaveBeenCalledWith(
      expect.objectContaining({ version: checksum, checksum }),
    );
  });

  it("quarantines rather than holds an invalid version, pinned or not", async () => {
    // Order matters: a payload that fails validation is bad regardless of who
    // pinned what, and must not be filed as a publishable candidate.
    const repository = createRepository();
    vi.mocked(repository.getLastKnownGoodRule).mockResolvedValue({
      version: "pinned-checksum",
      etag: null,
      pinned: true,
    });
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ cidrs: ["nonsense"], domains: ["!!"] })),
        ),
      ),
    });

    await fetchRules();

    expect(repository.storeUnpublishedRule).not.toHaveBeenCalled();
    expect(repository.storeQuarantinedRule).toHaveBeenCalled();
  });

  it("publishes normally once the pin is released", async () => {
    const repository = createRepository();
    vi.mocked(repository.getLastKnownGoodRule).mockResolvedValue({
      version: "old-checksum",
      etag: null,
      pinned: false,
    });
    const fetchRules = createRuleFetcher({
      repository,
      feed: jsonFeed,
      fetchImpl: vi.fn(() => Promise.resolve(new Response(sourceBody))),
    });

    await fetchRules();

    expect(repository.storeUnpublishedRule).not.toHaveBeenCalled();
    expect(repository.activateRuleVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: checksum }),
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

  const excludeFeed = (bodies: Record<string, string>) => {
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve(new Response(bodies[(input as string).split("/").pop()!] ?? "")),
    );
    return {
      fetchImpl,
      feed: {
        profile: "ru_blacklist" as const,
        sources: [
          { url: "https://feed.example/include.lst", format: "cidr-lines" as const },
          { url: "https://feed.example/domains.lst", format: "domain-lines" as const },
          {
            url: "https://feed.example/exclude.lst",
            format: "cidr-lines" as const,
            exclude: true,
          },
        ],
        pocApproved: true,
      },
    };
  };

  it("takes an exclude source's address space out of the published list", async () => {
    // A coarse /8 with a direct-only hole in it, and a prefix the exclusion
    // does not touch: the hole goes, the rest survives, domains are untouched.
    const repository = createRepository();
    const { fetchImpl, feed } = excludeFeed({
      "include.lst": "10.0.0.0/8\n203.0.113.0/24",
      "domains.lst": "blocked.example",
      // A stray name in a CIDR list is ignored, not treated as an address.
      "exclude.lst": "10.0.0.0/12\nblocked.example",
    });

    await createRuleFetcher({ repository, feed, fetchImpl })();

    const activated = vi.mocked(repository.activateRuleVersion).mock.calls[0]?.[0];
    expect(activated?.payload.cidrs).toEqual(
      expect.arrayContaining(["10.16.0.0/12", "10.32.0.0/11", "10.64.0.0/10", "10.128.0.0/9"]),
    );
    expect(activated?.payload.cidrs).not.toContain("10.0.0.0/8");
    expect(activated?.payload.cidrs).toContain("203.0.113.0/24");
    expect(activated?.payload.domains).toEqual(["blocked.example"]);
    expect(activated?.validationReport).toMatchObject({ excludedPrefixes: 1 });
    // The version names every source it was built from, exclusions included.
    expect(activated?.sourceUrl).toContain("https://feed.example/exclude.lst");
  });

  it("quarantines a version an exclusion would gut", async () => {
    // A broken mirror answering with a huge block must not silently send most
    // of the list outside the tunnel.
    const repository = createRepository();
    const { fetchImpl, feed } = excludeFeed({
      "include.lst": "10.0.0.0/8\n203.0.113.0/24",
      "domains.lst": "blocked.example",
      "exclude.lst": "0.0.0.0/1",
    });

    await createRuleFetcher({ repository, feed, fetchImpl })();

    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
    expect(
      vi.mocked(repository.storeQuarantinedRule).mock.calls[0]?.[0].validationReport,
    ).toMatchObject({ reason: "exclusion_too_broad" });
  });

  it("fails the tick when an exclude source yields no CIDRs", async () => {
    // "Exclude nothing" would put the excluded space back into the tunnel, so
    // the last good version has to stay live instead.
    const repository = createRepository();
    const { fetchImpl, feed } = excludeFeed({
      "include.lst": "203.0.113.0/24",
      "domains.lst": "blocked.example",
      "exclude.lst": "<html>maintenance</html>",
    });

    await expect(createRuleFetcher({ repository, feed, fetchImpl })()).rejects.toThrow(
      "no valid CIDRs",
    );
    expect(repository.activateRuleVersion).not.toHaveBeenCalled();
    expect(repository.storeQuarantinedRule).not.toHaveBeenCalled();
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

describe("resolveRuleFeeds", () => {
  const approveAll = () => true;

  it("falls back to the built-in feeds when nothing is configured", () => {
    const feeds = resolveRuleFeeds({}, approveAll);

    expect(feeds.map((feed) => feed.profile)).toEqual(["ru_blacklist"]);
    // The defaults must be usable as-is, not placeholders an operator has to fix.
    for (const feed of feeds) {
      expect(feed.sources.length).toBeGreaterThan(0);
      for (const source of feed.sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(["json", "cidr-lines", "domain-lines"]).toContain(source.format);
      }
    }
  });

  it("treats an empty RULE_FEEDS array as a deliberate opt-out", () => {
    expect(resolveRuleFeeds({ RULE_FEEDS: "[]" }, approveAll)).toEqual([]);
  });

  // The exact shape of a production .env written before ru_whitelist was
  // removed. Throwing on it crash-looped a live worker through an upgrade,
  // so the blacklist half has to survive the whitelist half being obsolete.
  it("ignores a leftover ru_whitelist entry and keeps the rest of the feed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const feeds = resolveRuleFeeds(
        {
          RULE_FEEDS: JSON.stringify([
            {
              profile: "ru_blacklist",
              sources: [
                { url: "https://example.com/ipsum.lst", format: "cidr-lines" },
              ],
            },
            {
              profile: "ru_whitelist",
              sources: [
                { url: "https://example.com/whitelist.txt", format: "cidr-lines" },
              ],
            },
          ]),
        },
        approveAll,
      );

      expect(feeds.map((feed) => feed.profile)).toEqual(["ru_blacklist"]);
      expect(feeds[0]?.sources).toEqual([
        { url: "https://example.com/ipsum.lst", format: "cidr-lines" },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ru_whitelist"));
    } finally {
      warn.mockRestore();
    }
  });

  // A configuration naming only the removed profile stays configuration: it
  // must not silently resurrect the built-in defaults the operator never asked
  // for. No feeds means no rule updates, and the warning above says why.
  it("leaves no feeds when ru_whitelist was the only one configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        resolveRuleFeeds(
          {
            RULE_FEEDS: JSON.stringify([
              {
                profile: "ru_whitelist",
                sources: [
                  { url: "https://example.com/whitelist.txt", format: "cidr-lines" },
                ],
              },
            ]),
          },
          approveAll,
        ),
      ).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ru_whitelist"));
    } finally {
      warn.mockRestore();
    }
  });

  it("uses a configured RULE_FEEDS instead of the defaults", () => {
    const feeds = resolveRuleFeeds(
      {
        RULE_FEEDS: JSON.stringify([
          {
            profile: "ru_blacklist",
            sources: [{ url: "https://example.com/a.lst", format: "cidr-lines" }],
          },
        ]),
      },
      approveAll,
    );

    expect(feeds).toEqual([
      {
        profile: "ru_blacklist",
        sources: [{ url: "https://example.com/a.lst", format: "cidr-lines" }],
        pocApproved: true,
      },
    ]);
  });

  it("keeps Russian address space out of the built-in feed", () => {
    const [feed] = resolveRuleFeeds({}, approveAll);
    expect(feed?.sources.filter((source) => source.exclude)).toEqual([
      expect.objectContaining({ format: "cidr-lines", exclude: true }),
    ]);
  });

  it("accepts an exclude source in RULE_FEEDS but not a feed of exclusions alone", () => {
    const include = { url: "https://example.com/a.lst", format: "cidr-lines" };
    const exclude = { url: "https://example.com/ru.zone", format: "cidr-lines", exclude: true };
    expect(
      resolveRuleFeeds(
        { RULE_FEEDS: JSON.stringify([{ profile: "ru_blacklist", sources: [include, exclude] }]) },
        approveAll,
      )[0]?.sources,
    ).toEqual([include, exclude]);
    expect(() =>
      resolveRuleFeeds(
        { RULE_FEEDS: JSON.stringify([{ profile: "ru_blacklist", sources: [exclude] }]) },
        approveAll,
      ),
    ).toThrow("no valid sources");
  });

  it("carries the approval gate onto the defaults", () => {
    const feeds = resolveRuleFeeds({}, () => false);

    expect(
      Object.fromEntries(
        feeds.map((feed) => [feed.profile, feed.pocApproved]),
      ),
    ).toEqual({ ru_blacklist: false });
  });

  it("throws on malformed configuration instead of silently using the defaults", () => {
    expect(() => resolveRuleFeeds({ RULE_FEEDS: "{" }, approveAll)).toThrow(
      "not valid JSON",
    );
    expect(() => resolveRuleFeeds({ RULE_FEEDS: "{}" }, approveAll)).toThrow(
      "must be an array",
    );
    expect(() =>
      resolveRuleFeeds(
        { RULE_FEEDS: JSON.stringify([{ profile: "nope", sources: [] }]) },
        approveAll,
      ),
    ).toThrow("invalid profile");
    expect(() =>
      resolveRuleFeeds(
        {
          RULE_FEEDS: JSON.stringify([
            { profile: "ru_blacklist", sources: [{ url: "x", format: "bad" }] },
          ]),
        },
        approveAll,
      ),
    ).toThrow("no valid sources");
  });

  it("does not let a caller's mutation leak into the shared defaults", () => {
    // Captured before the mutation: comparing against the constant afterwards
    // would compare it with itself and pass no matter what.
    const expected = DEFAULT_RULE_FEEDS[0]!.sources.length;

    const first = resolveRuleFeeds({}, approveAll);
    first[0]!.sources.push({ url: "https://example.com/x", format: "json" });

    expect(DEFAULT_RULE_FEEDS[0]!.sources).toHaveLength(expected);
    expect(resolveRuleFeeds({}, approveAll)[0]?.sources).toHaveLength(expected);
  });
});
