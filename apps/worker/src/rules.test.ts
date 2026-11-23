import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RULE_EXTRAS } from "./ruleExtras.js";
import {
  compactRoutes,
  createRuleFetcher,
  DEFAULT_COLLATERAL_CAP,
  DEFAULT_RULE_FEEDS,
  MAX_COMPACT_ROUTES,
  mergeRulePayloads,
  parseRuleSource,
  resolveRuleCompactionOptions,
  resolveRuleFeeds,
  validateRuleObject,
  validateRulePayload,
  type RuleRepository,
  type StoredRuleInput,
} from "./rules.js";
import {
  ALIEXPRESS_DIRECT_V4_CIDRS,
  APPLE_DIRECT_V4_CIDRS,
  BOGON_V4_CIDRS,
  STEAM_CACHE_V4_CIDRS,
  STEAM_CACHE_V6_CIDRS,
  countCidrOverlap,
  measureCidrSpace,
  subtractCidrs,
} from "./cidrSet.js";

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

  it("adds a feed's extras after the exclusion, without fetching them", async () => {
    // A hand-picked range is a deliberate choice: the GeoIP exclusion must not
    // cut it, and there is nothing to download for it.
    const repository = createRepository();
    const { fetchImpl, feed } = excludeFeed({
      "include.lst": "203.0.113.0/24",
      "domains.lst": "blocked.example",
      "exclude.lst": "198.51.100.0/24",
    });

    await createRuleFetcher({
      repository,
      feed: { ...feed, extras: [{ name: "game", cidrs: ["198.51.100.0/25", "192.0.2.0/24"] }] },
      fetchImpl,
    })();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const activated = vi.mocked(repository.activateRuleVersion).mock.calls[0]?.[0];
    expect(activated?.payload.cidrs).toEqual([
      "192.0.2.0/24",
      "198.51.100.0/25",
      "203.0.113.0/24",
    ]);
    expect(activated?.validationReport).toMatchObject({ cidrCount: 3, extras: ["game"] });
    // The version names the extra next to the feeds it was built from.
    expect(activated?.sourceUrl.split(" ")).toContain("extra://game");
  });

  it("refuses an extra with a malformed CIDR instead of shipping without it", async () => {
    const repository = createRepository();
    const { fetchImpl, feed } = excludeFeed({
      "include.lst": "203.0.113.0/24",
      "domains.lst": "blocked.example",
      "exclude.lst": "198.51.100.0/24",
    });

    await expect(
      createRuleFetcher({
        repository,
        feed: { ...feed, extras: [{ name: "game", cidrs: ["192.0.2.0/33"] }] },
        fetchImpl,
      })(),
    ).rejects.toThrow('Rule extra "game" has an invalid CIDR: 192.0.2.0/33');
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
        extras: [],
        compaction: {
          mode: "lossless",
          collateralCap: DEFAULT_COLLATERAL_CAP,
          directApple: true,
          directSteamCache: true,
          maxCompactRoutes: MAX_COMPACT_ROUTES,
        },
        pocApproved: true,
      },
    ]);
  });

  it("adds the built-in extras to the default blacklist only", () => {
    // An operator who wrote their own RULE_FEEDS owns the whole list; the
    // extras ride along with the defaults and nowhere else.
    expect(resolveRuleFeeds({}, approveAll)[0]?.extras).toEqual(RULE_EXTRAS);
    expect(
      resolveRuleFeeds(
        {
          RULE_FEEDS: JSON.stringify([
            {
              profile: "ru_blacklist",
              sources: [{ url: "https://example.com/a.lst", format: "cidr-lines" }],
            },
          ]),
        },
        approveAll,
      )[0]?.extras,
    ).toEqual([]);
  });

  it("keeps Russian address space out of the built-in feed, IPv4 and IPv6", () => {
    const [feed] = resolveRuleFeeds({}, approveAll);
    const excluded = feed?.sources.filter((source) => source.exclude) ?? [];
    expect(excluded.map((source) => source.url)).toEqual([
      expect.stringContaining("/ipblocks/"),
      expect.stringContaining("/ipv6/"),
    ]);
  });

  it("routes blocked providers over both IPv4 and IPv6 with /24 cap on ipsum.lst", () => {
    const [feed] = resolveRuleFeeds({}, approveAll);
    const included = feed?.sources.filter((source) => !source.exclude) ?? [];
    const ipsum = included.find((s) => s.url.endsWith("/ipsum.lst"));
    expect(ipsum?.maxIpv4PrefixLength).toBe(24);
    expect(included.some((s) => s.url.includes("/Subnets/IPv4/meta.lst"))).toBe(true);
    expect(included.some((s) => s.url.includes("/Subnets/IPv6/meta.lst"))).toBe(true);
    expect(included.some((s) => s.url.includes("/Subnets/IPv6/cloudflare.lst"))).toBe(true);
    expect(feed?.compaction?.mode).toBe("compact_world");
  });

  it("validates RULE_COMPACTION_MODE, RULE_COLLATERAL_CAP and direct shield flags", () => {
    expect(resolveRuleCompactionOptions({}, false)).toEqual({
      mode: "compact_world",
      collateralCap: DEFAULT_COLLATERAL_CAP,
      directApple: true,
      directSteamCache: true,
      maxCompactRoutes: MAX_COMPACT_ROUTES,
    });
    expect(resolveRuleCompactionOptions({}, true).mode).toBe("lossless");
    expect(
      resolveRuleCompactionOptions(
        {
          RULE_COMPACTION_MODE: "blocked_only",
          RULE_COLLATERAL_CAP: "0.01",
          RULE_DIRECT_APPLE: "false",
          RULE_DIRECT_STEAM_CACHE: "false",
        },
        false,
      ),
    ).toMatchObject({
      mode: "blocked_only",
      collateralCap: 0.01,
      directApple: false,
      directSteamCache: false,
    });
    expect(() =>
      resolveRuleCompactionOptions({ RULE_COMPACTION_MODE: "unknown" }, false),
    ).toThrow("RULE_COMPACTION_MODE");
    expect(() =>
      resolveRuleCompactionOptions({ RULE_COLLATERAL_CAP: "0.9" }, false),
    ).toThrow("RULE_COLLATERAL_CAP");
    expect(() =>
      resolveRuleCompactionOptions({ RULE_DIRECT_APPLE: "yes" }, false),
    ).toThrow("RULE_DIRECT_APPLE");
    expect(() =>
      resolveRuleFeeds(
        {
          RULE_FEEDS: JSON.stringify([
            {
              profile: "ru_blacklist",
              sources: [
                {
                  url: "https://example.com/a.lst",
                  format: "cidr-lines",
                  maxIpv4PrefixLength: 64,
                },
              ],
            },
          ]),
        },
        approveAll,
      ),
    ).toThrow("maxIpv4PrefixLength");
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
    // A quoted "true" must not quietly turn the exclusion off.
    expect(() =>
      resolveRuleFeeds(
        {
          RULE_FEEDS: JSON.stringify([
            { profile: "ru_blacklist", sources: [include, { ...exclude, exclude: "true" }] },
          ]),
        },
        approveAll,
      ),
    ).toThrow('non-boolean "exclude"');
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

  it("does not let a caller's mutation leak into the shared extras", () => {
    const expected = structuredClone(RULE_EXTRAS);
    const first = resolveRuleFeeds({}, approveAll);
    first[0]!.extras![0]!.cidrs.push("192.0.2.0/24");
    first[0]!.extras!.push({ name: "x", cidrs: [] });

    expect(RULE_EXTRAS).toEqual(expected);
    expect(resolveRuleFeeds({}, approveAll)[0]?.extras).toEqual(expected);
  });
});

describe("compactRoutes compaction modes", () => {
  it("applies maxIpv4PrefixLength when ingesting cidr-lines while keeping IPv6 intact", async () => {
    const repository: RuleRepository = {
      getLastKnownGoodRule: vi.fn(() => Promise.resolve(null)),
      storeQuarantinedRule: vi.fn(() => Promise.resolve()),
      storeUnpublishedRule: vi.fn(() => Promise.resolve()),
      activateRuleVersion: vi.fn(() => Promise.resolve()),
    };
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          "104.16.0.0/24\n104.16.5.7/32\n104.16.6.0/25\n2a03:2880::/48\n",
        ),
      ),
    );
    await createRuleFetcher({
      repository,
      feed: {
        profile: "ru_blacklist",
        sources: [
          {
            url: "https://feed.example/ipsum.lst",
            format: "cidr-lines",
            maxIpv4PrefixLength: 24,
          },
        ],
        pocApproved: true,
      },
      fetchImpl,
    })();

    const activated = vi.mocked(repository.activateRuleVersion).mock.calls[0]?.[0];
    expect(activated?.payload.cidrs).toEqual(["104.16.0.0/24", "2a03:2880::/48"]);
  });

  it("compacts blocked_only safely without overlapping RU, bogons, Apple, or SteamCache", () => {
    const validation = validateRuleObject({
      cidrs: [
        "104.16.0.0/24",
        "104.16.2.0/24",
        "17.0.0.0/24",
        "155.133.248.0/24",
        "192.168.1.0/24",
        "2a03:2880::/36",
        "2a03:2880:f000::/36",
      ],
      domains: [],
    });
    const ru = ["5.255.255.0/24", "2a02:6b8::/32"];
    const result = compactRoutes(validation, ru, ["160.79.104.0/23"], {
      mode: "blocked_only",
      collateralCap: 0.005,
      directApple: true,
      directSteamCache: true,
      maxCompactRoutes: 2800,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.cidrs).toContain("104.16.0.0/22");
    expect(result.payload.cidrs).toContain("160.79.104.0/23");
    expect(result.payload.cidrs).toContain("2a03:2880::/32");
    expect(countCidrOverlap(result.payload.cidrs, ru)).toEqual({ 4: 0n, 6: 0n });
    expect(countCidrOverlap(result.payload.cidrs, BOGON_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, APPLE_DIRECT_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, STEAM_CACHE_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, ALIEXPRESS_DIRECT_V4_CIDRS)[4]).toBe(0n);
    expect(result.report).toMatchObject({
      compactionMode: "blocked_only",
      ruOverlap: 0,
      bogonOverlap: 0,
      directShields: ["apple", "steam-cache", "aliexpress"],
    });
  });

  it("builds compact_world complement keeping RU, bogons, Apple, and SteamCache direct", () => {
    const validation = validateRuleObject({
      cidrs: ["157.240.0.0/16", "2a03:2880::/32"],
      domains: [],
    });
    const ru = ["5.255.255.0/24", "77.88.55.0/24", "2a02:6b8::/32"];
    const result = compactRoutes(validation, ru, ["160.79.104.0/23"], {
      mode: "compact_world",
      collateralCap: 0.005,
      directApple: true,
      directSteamCache: true,
      maxCompactRoutes: 2800,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countCidrOverlap(result.payload.cidrs, ru)).toEqual({ 4: 0n, 6: 0n });
    expect(countCidrOverlap(result.payload.cidrs, BOGON_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, APPLE_DIRECT_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, STEAM_CACHE_V4_CIDRS)[4]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, STEAM_CACHE_V6_CIDRS)[6]).toBe(0n);
    expect(countCidrOverlap(result.payload.cidrs, ALIEXPRESS_DIRECT_V4_CIDRS)[4]).toBe(0n);
    // Neighboring Alibaba CDN ranges used by HoYoLAB on RU GeoDNS stay in VPN.
    expect(countCidrOverlap(result.payload.cidrs, ["47.246.2.0/24"])[4]).toBe(256n);
    // Akamai (Steam Store / Community) and Meta stay routed through the tunnel.
    expect(countCidrOverlap(result.payload.cidrs, ["23.220.114.106/32"])[4]).toBe(1n);
    expect(countCidrOverlap(result.payload.cidrs, ["157.240.0.0/16"])[4]).toBe(65536n);
    expect(result.report.compactionMode).toBe("compact_world");
  });

  it("unions exact Genshin SDK prefixes without widening compact_world RU expansion and respects manual exclusions", () => {
    const validation = validateRuleObject({ cidrs: ["157.240.0.0/16"], domains: [] });
    // An RU prefix in 171.0.0.0/8 expands across 171.43.164.x when no protected
    // core entry sits inside 171.0.0.0/8. Exact extras must add ONLY the four
    // requested prefixes (+8 IPv4) without preventing that RU expansion.
    const ru = ["171.32.0.0/16"];
    const baseExtras = RULE_EXTRAS.filter((extra) => !extra.exact).flatMap((extra) => extra.cidrs);
    const exactExtras = RULE_EXTRAS.filter((extra) => extra.exact).flatMap((extra) => extra.cidrs);
    const compaction = {
      mode: "compact_world" as const,
      collateralCap: 0.005,
      directApple: true,
      directSteamCache: true,
      maxCompactRoutes: 2800,
    };

    const before = compactRoutes(validation, ru, baseExtras, compaction);
    const after = compactRoutes(validation, ru, baseExtras, compaction, { exactExtras });
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const added = subtractCidrs(after.payload.cidrs, before.payload.cidrs).cidrs;
    const removed = subtractCidrs(before.payload.cidrs, after.payload.cidrs).cidrs;
    const addedV4 = added.filter((cidr) => !cidr.includes(":"));
    const addedV6 = added.filter((cidr) => cidr.includes(":"));
    expect(removed).toEqual([]);
    expect(addedV4).toEqual([
      "171.43.164.91/32",
      "171.43.164.92/30",
      "171.43.164.96/31",
      "171.43.164.98/32",
    ]);
    expect(measureCidrSpace(addedV4)).toEqual({ 4: 8n, 6: 0n });
    expect(addedV6).toEqual(
      exactExtras.filter((cidr) => cidr.includes(":")).sort(),
    );

    const withAdminExclude = compactRoutes(validation, ru, baseExtras, compaction, {
      exactExtras,
      adminExcluded: ["171.43.164.92/32"],
    });
    expect(withAdminExclude.ok).toBe(true);
    if (!withAdminExclude.ok) return;
    expect(countCidrOverlap(withAdminExclude.payload.cidrs, ["171.43.164.91/32"])[4]).toBe(1n);
    expect(countCidrOverlap(withAdminExclude.payload.cidrs, ["171.43.164.92/32"])[4]).toBe(0n);
    expect(countCidrOverlap(withAdminExclude.payload.cidrs, ["171.43.164.93/32"])[4]).toBe(1n);
  });

  it("routes GitHub and observed web CDN gaps without widening shared networks or bypassing exclusions", () => {
    const validation = validateRuleObject({ cidrs: ["157.240.0.0/16"], domains: [] });
    const ru = ["62.3.34.0/24", "185.0.12.0/22"];
    const baseExtras = RULE_EXTRAS.filter((extra) => !extra.exact).flatMap((extra) => extra.cidrs);
    const exactExtras = RULE_EXTRAS.filter((extra) => extra.exact).flatMap((extra) => extra.cidrs);
    const options = {
      mode: "compact_world" as const,
      collateralCap: DEFAULT_COLLATERAL_CAP,
      directApple: true,
      directSteamCache: true,
    };
    const after = compactRoutes(validation, ru, baseExtras, options, { exactExtras });
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    expect(countCidrOverlap(after.payload.cidrs, ["185.199.108.0/22"])[4]).toBe(1024n);
    expect(countCidrOverlap(after.payload.cidrs, ["185.198.108.1/32"])[4]).toBe(0n);
    for (const ip of ["62.115.253.24", "62.115.253.33", "62.115.253.40"]) {
      expect(countCidrOverlap(after.payload.cidrs, [`${ip}/32`])[4], ip).toBe(1n);
    }
    for (const ip of ["62.115.253.25", "62.115.253.32", "62.115.253.41"]) {
      expect(countCidrOverlap(after.payload.cidrs, [`${ip}/32`])[4], ip).toBe(0n);
    }
    for (const direct of [ru, APPLE_DIRECT_V4_CIDRS, STEAM_CACHE_V4_CIDRS, ALIEXPRESS_DIRECT_V4_CIDRS]) {
      expect(countCidrOverlap(after.payload.cidrs, direct)[4]).toBe(0n);
    }

    const withAdminExclude = compactRoutes(validation, ru, baseExtras, options, {
      exactExtras,
      adminExcluded: ["185.199.108.133/32", "62.115.253.24/32"],
    });
    expect(withAdminExclude.ok).toBe(true);
    if (!withAdminExclude.ok) return;
    expect(countCidrOverlap(withAdminExclude.payload.cidrs, ["185.199.108.133/32", "62.115.253.24/32"])[4]).toBe(0n);
    expect(countCidrOverlap(withAdminExclude.payload.cidrs, ["185.199.109.133/32", "62.115.253.33/32"])[4]).toBe(2n);
  });

  it("quarantines compact_world when no exclusions are supplied", () => {
    const validation = validateRuleObject({ cidrs: ["157.240.0.0/16"], domains: [] });
    const result = compactRoutes(validation, [], [], {
      mode: "compact_world",
      collateralCap: 0.005,
      directApple: true,
      directSteamCache: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.reason).toBe("compact_world_requires_exclusions");
    }
  });

  it("quarantines a compacted version when it exceeds maxCompactRoutes", () => {
    const validation = validateRuleObject({
      cidrs: ["104.16.0.0/24", "157.240.0.0/24", "142.250.0.0/24"],
      domains: [],
    });
    const result = compactRoutes(validation, ["5.255.255.0/24"], [], {
      mode: "blocked_only",
      collateralCap: 0,
      directApple: true,
      directSteamCache: true,
      maxCompactRoutes: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.report.reason).toBe("route_budget_exceeded");
    }
  });

  it("appends RULE_EXTRA_INCLUDE_URLS and RULE_EXTRA_EXCLUDE_URLS onto built-in E-Core defaults", () => {
    const [feed] = resolveRuleFeeds(
      {
        RULE_EXTRA_INCLUDE_URLS:
          "https://example.test/steam-cm.lst, https://example.test/vpn-extra.lst",
        RULE_EXTRA_EXCLUDE_URLS: "https://example.test/direct.lst",
      },
      () => true,
    );
    expect(feed?.compaction?.mode).toBe("compact_world");
    expect((feed?.extras ?? []).length).toBeGreaterThan(0);
    expect(feed?.sources).toEqual(
      expect.arrayContaining([
        {
          url: "https://example.test/direct.lst",
          format: "cidr-lines",
          exactExclude: true,
        },
        {
          url: "https://example.test/steam-cm.lst",
          format: "cidr-lines",
          forceInclude: true,
        },
        {
          url: "https://example.test/vpn-extra.lst",
          format: "cidr-lines",
          forceInclude: true,
        },
      ]),
    );
    expect(() =>
      resolveRuleFeeds({ RULE_EXTRA_INCLUDE_URLS: "ftp://example.test/bad.lst" }, () => true),
    ).toThrow(/RULE_EXTRA_INCLUDE_URLS/);
    expect(() =>
      resolveRuleFeeds({ RULE_EXTRA_EXCLUDE_URLS: "not a url" }, () => true),
    ).toThrow(/RULE_EXTRA_EXCLUDE_URLS/);
  });

  it("bakes global_route_overrides and extra URL feeds cleanly into daily compact_world runs", async () => {
    const activated: StoredRuleInput[] = [];
    let adminOverrides = {
      addCidrs: ["5.255.255.10/32", "198.51.100.10/32"],
      excludeCidrs: ["198.51.100.0/24", "160.79.104.5/32"],
    };

    const repository: RuleRepository = {
      getLastKnownGoodRule: vi.fn(() =>
        Promise.resolve(
          activated.length > 0
            ? { version: activated[activated.length - 1]!.version, etag: null, pinned: false }
            : null,
        ),
      ),
      getGlobalRouteOverrides: vi.fn(() => Promise.resolve(adminOverrides)),
      storeQuarantinedRule: vi.fn(() => Promise.resolve()),
      storeUnpublishedRule: vi.fn(() => Promise.resolve()),
      activateRuleVersion: vi.fn((input: StoredRuleInput) => {
        activated.push(input);
        return Promise.resolve();
      }),
    };

    const fetchImpl: typeof fetch = vi.fn((input) => {
      const url = String(input);
      if (url.endsWith("/base.lst")) {
        return Promise.resolve(
          new Response("157.240.0.0/16\n198.51.100.0/24\n2a03:2880::/32\n", {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/ru.lst")) {
        return Promise.resolve(
          new Response("5.255.255.0/24\n77.88.55.0/24\n2a02:6b8::/32\n", {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/extra-exclude.lst")) {
        return Promise.resolve(
          new Response("# exact direct CDN\n203.0.113.0/24\n", { status: 200 }),
        );
      }
      if (url.endsWith("/extra-include.lst")) {
        // Surgical Steam CM /32 inside Valve AS32590 155.133.224.0/19
        return Promise.resolve(
          new Response("# valve cm\n155.133.226.1/32\n", { status: 200 }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const fetcher = createRuleFetcher({
      repository,
      fetchImpl,
      feed: {
        profile: "ru_blacklist",
        sources: [
          { url: "https://example.test/base.lst", format: "cidr-lines" },
          { url: "https://example.test/ru.lst", format: "cidr-lines", exclude: true },
          {
            url: "https://example.test/extra-exclude.lst",
            format: "cidr-lines",
            exactExclude: true,
          },
          {
            url: "https://example.test/extra-include.lst",
            format: "cidr-lines",
            forceInclude: true,
          },
        ],
        extras: [{ name: "anthropic", cidrs: ["160.79.104.0/24"] }],
        compaction: {
          mode: "compact_world",
          collateralCap: 0.005,
          directApple: true,
          directSteamCache: true,
          maxCompactRoutes: 2800,
        },
        pocApproved: true,
      },
    });

    await fetcher();
    expect(activated).toHaveLength(1);
    const first = activated[0]!;
    const cidrs = first.payload.cidrs;

    // 1. Extra-exclude URL (203.0.113.0/24) is excluded exactly without expanding
    // into surrounding non-RU space (203.0.114.0/24 stays routed).
    expect(countCidrOverlap(cidrs, ["203.0.113.0/24"])[4]).toBe(0n);
    expect(countCidrOverlap(cidrs, ["203.0.114.0/24"])[4]).toBe(256n);

    // 2. Extra-include URL punches Steam CM 155.133.226.1/32 back into VPN while
    // keeping neighboring Valve AS32590 SteamCache IPs (155.133.226.2/32) direct.
    expect(countCidrOverlap(cidrs, ["155.133.226.1/32"])[4]).toBe(1n);
    expect(countCidrOverlap(cidrs, ["155.133.226.2/32"])[4]).toBe(0n);

    // 3. Admin exclude punches 160.79.104.5/32 out of built-in extra 160.79.104.0/24
    // and excludes 198.51.100.0/24 except admin add 198.51.100.10/32 (add > exclude).
    expect(countCidrOverlap(cidrs, ["160.79.104.5/32"])[4]).toBe(0n);
    expect(countCidrOverlap(cidrs, ["160.79.104.6/32"])[4]).toBe(1n);
    expect(countCidrOverlap(cidrs, ["198.51.100.10/32"])[4]).toBe(1n);
    expect(countCidrOverlap(cidrs, ["198.51.100.11/32"])[4]).toBe(0n);

    // 4. Admin add overrides RU GeoIP for 5.255.255.10/32 while keeping the rest of RU direct.
    expect(countCidrOverlap(cidrs, ["5.255.255.10/32"])[4]).toBe(1n);
    expect(countCidrOverlap(cidrs, ["5.255.255.11/32"])[4]).toBe(0n);

    // Report records counts only (no raw CIDRs).
    expect(first.validationReport).toMatchObject({
      extraIncludedCidrs: 1,
      extraExcludedCidrs: 1,
      adminAddedCidrs: 2,
      adminExcludedCidrs: 2,
      directShields: [
        "apple",
        "steam-cache",
        "aliexpress",
        "extra-exclude-urls",
        "admin-global-exclude",
      ],
    });

    // Updating admin overrides changes the checksum and publishes a new version.
    adminOverrides = { addCidrs: [], excludeCidrs: [] };
    await fetcher();
    expect(activated).toHaveLength(2);
    expect(activated[1]!.version).not.toBe(first.version);
  });

  it("allows an intentionally empty RULE_EXTRA_EXCLUDE_URLS file but rejects non-empty garbage", async () => {
    const repository: RuleRepository = {
      getLastKnownGoodRule: vi.fn(() => Promise.resolve(null)),
      storeQuarantinedRule: vi.fn(() => Promise.resolve()),
      storeUnpublishedRule: vi.fn(() => Promise.resolve()),
      activateRuleVersion: vi.fn(() => Promise.resolve()),
    };

    const runWithExtraBody = async (body: string) => {
      const fetcher = createRuleFetcher({
        repository,
        fetchImpl: vi.fn((input) => {
          const url = String(input);
          if (url.endsWith("/base.lst")) {
            return Promise.resolve(new Response("157.240.0.0/16\n", { status: 200 }));
          }
          if (url.endsWith("/ru.lst")) {
            return Promise.resolve(new Response("5.255.255.0/24\n", { status: 200 }));
          }
          return Promise.resolve(new Response(body, { status: 200 }));
        }),
        feed: {
          profile: "ru_blacklist",
          sources: [
            { url: "https://example.test/base.lst", format: "cidr-lines" },
            { url: "https://example.test/ru.lst", format: "cidr-lines", exclude: true },
            {
              url: "https://example.test/extra-exclude.lst",
              format: "cidr-lines",
              exactExclude: true,
            },
          ],
          compaction: {
            mode: "compact_world",
            collateralCap: 0.005,
            directApple: true,
            directSteamCache: true,
          },
          pocApproved: true,
        },
      });
      await fetcher();
    };

    await expect(runWithExtraBody("# intentionally empty\n\n")).resolves.toBeUndefined();
    await expect(runWithExtraBody("<html>error page</html>\n")).rejects.toThrow(
      /has no valid CIDRs/,
    );
  });
});
