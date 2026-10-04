import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { subtractCidrs } from "./cidrSet.js";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 250_000;
// Share of the included address space an exclusion source may remove before the
// version is quarantined. The RU GeoIP list takes ~0.1% out of the default feed;
// a list that suddenly takes a large bite is far more likely a wrong URL or a
// broken mirror than a real change, and shipping it would quietly route that
// traffic outside the tunnel.
const MAX_EXCLUDED_SHARE = 0.1;
// Fraction of entries allowed to be invalid before the whole feed is rejected.
// Community lists (Re:filter etc.) always carry a little noise, so drop the bad
// entries rather than quarantining a 100k-entry feed over a few stragglers.
const MAX_INVALID_RATIO = 0.15;
// TLD may be alphabetic OR a punycode IDN label (e.g. `.рф` → `xn--p1ai`).
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

export type RulePayload = { cidrs: string[]; domains: string[] };
export type RuleValidationReport = Record<string, unknown>;
export type RuleProfile = "ru_blacklist";
export type RuleFeedFormat = "json" | "cidr-lines" | "domain-lines";
/**
 * One feed source. An `exclude` source is not part of the list: its CIDRs are
 * taken OUT of what the other sources supply (its domains are ignored), so a
 * coarse feed can be trimmed by a list of address space that must stay direct.
 */
export type RuleSource = { url: string; format: RuleFeedFormat; exclude?: boolean };

export type ValidRulePayload = {
  ok: true;
  payload: RulePayload;
  report: {
    cidrCount: number;
    domainCount: number;
    droppedInvalid?: number;
    /** Included prefixes an `exclude` source cut into or removed. */
    excludedPrefixes?: number;
  };
};

export type InvalidRulePayload = {
  ok: false;
  payload: RulePayload;
  report: { invalidEntries: string[]; reason?: string; excludedShare?: number };
};

const inputSchema = z.object({
  cidrs: z.array(z.string()),
  domains: z.array(z.string()),
});

const readBoundedResponse = async (response: Response): Promise<string> => {
  const contentLengthRaw = response.headers.get("content-length");
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
  if (
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_SOURCE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Rule source response is too large");
  }
  if (!response.body) {
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
      throw new Error("Rule source response is too large");
    }
    return source;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let source = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error("Rule source response is too large");
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
    return source;
  } finally {
    reader.releaseLock();
  }
};

const isCidr = (value: string): boolean => {
  const [address, prefixRaw, extra] = value.split("/");
  if (!address || !prefixRaw || extra !== undefined) return false;
  // Strict decimal prefix only — reject hex/scientific/signed/whitespace that
  // Number() would otherwise coerce (e.g. "0x20", "3e1", " 24").
  if (!/^\d{1,3}$/.test(prefixRaw)) return false;
  const version = isIP(address);
  const prefix = Number(prefixRaw);
  return (
    (version === 4 && prefix <= 32) || (version === 6 && prefix <= 128)
  );
};

/**
 * Parse a single feed source into a raw rule payload based on its format.
 * `cidr-lines` / `domain-lines` accept one entry per line with `#` comments.
 */
export const parseRuleSource = (
  source: string,
  format: RuleFeedFormat,
): RulePayload => {
  if (format === "json") {
    const parsed = inputSchema.parse(JSON.parse(source));
    return { cidrs: parsed.cidrs, domains: parsed.domains };
  }
  const entries = source
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
  return format === "cidr-lines"
    ? { cidrs: entries, domains: [] }
    : { cidrs: [], domains: entries };
};

/**
 * Merge several raw payloads into one, de-duplicating entries.
 */
export const mergeRulePayloads = (payloads: RulePayload[]): RulePayload => ({
  cidrs: [...new Set(payloads.flatMap((payload) => payload.cidrs))],
  domains: [...new Set(payloads.flatMap((payload) => payload.domains))],
});

export const validateRuleObject = (
  raw: RulePayload,
): ValidRulePayload | InvalidRulePayload => {
  const rawCidrs = [...new Set(raw.cidrs.map((value) => value.trim()))].sort();
  const rawDomains = [
    ...new Set(raw.domains.map((value) => value.trim().toLowerCase())),
  ].sort();
  const total = rawCidrs.length + rawDomains.length;
  if (total > MAX_ENTRIES) {
    return {
      ok: false,
      payload: { cidrs: [], domains: [] },
      report: { invalidEntries: [], reason: "too_many_entries" },
    };
  }

  const cidrs = rawCidrs.filter((value) => isCidr(value));
  const domains = rawDomains.filter((value) => domainPattern.test(value));
  const invalidEntries = [
    ...rawCidrs.filter((value) => !isCidr(value)),
    ...rawDomains.filter((value) => !domainPattern.test(value)),
  ];
  const kept = cidrs.length + domains.length;

  // Nothing usable → reject. Otherwise drop the invalid entries, but bail if the
  // feed is mostly garbage (usually a wrong URL or the wrong format).
  if (kept === 0) {
    return {
      ok: false,
      payload: { cidrs, domains },
      report: { invalidEntries: invalidEntries.slice(0, 100), reason: "empty_ruleset" },
    };
  }
  if (total > 0 && invalidEntries.length / total > MAX_INVALID_RATIO) {
    return {
      ok: false,
      payload: { cidrs, domains },
      report: {
        invalidEntries: invalidEntries.slice(0, 100),
        reason: "too_many_invalid",
      },
    };
  }

  return {
    ok: true,
    payload: { cidrs, domains },
    report: {
      cidrCount: cidrs.length,
      domainCount: domains.length,
      ...(invalidEntries.length > 0
        ? { droppedInvalid: invalidEntries.length }
        : {}),
    },
  };
};

/**
 * Validate a JSON feed body (`{cidrs, domains}`) after enforcing the size cap.
 */
export const validateRulePayload = (
  source: string,
): ValidRulePayload | InvalidRulePayload => {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      payload: { cidrs: [], domains: [] },
      report: { invalidEntries: [], reason: "source_too_large" },
    };
  }
  let parsed: RulePayload;
  try {
    parsed = parseRuleSource(source, "json");
  } catch {
    return {
      ok: false,
      payload: { cidrs: [], domains: [] },
      report: { invalidEntries: [], reason: "invalid_json_shape" },
    };
  }
  return validateRuleObject(parsed);
};

export type StoredRuleInput = {
  profile: RuleProfile;
  version: string;
  sourceUrl: string;
  etag: string | null;
  checksum: string;
  payload: RulePayload;
  validationReport: RuleValidationReport;
  fetchedAt: Date;
};

export interface RuleRepository {
  getLastKnownGoodRule: (profile: RuleProfile) => Promise<{
    version: string;
    etag: string | null;
    /** True when an admin pinned the active version by hand. */
    pinned: boolean;
  } | null>;
  storeQuarantinedRule: (input: StoredRuleInput) => Promise<void>;
  /**
   * Record a version that fetched and validated cleanly but must not go live,
   * because an admin pinned the profile to an older one. Stored `superseded`
   * so the admin can see it, diff it and activate it when they choose to.
   */
  storeUnpublishedRule: (input: StoredRuleInput) => Promise<void>;
  activateRuleVersion: (input: StoredRuleInput) => Promise<void>;
}

export type RuleFeed = {
  profile: RuleProfile;
  sources: RuleSource[];
  pocApproved: boolean;
};

export type RuleFetcherOptions = {
  repository: RuleRepository;
  feed: RuleFeed;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** A feed without the operator-controlled approval gate. */
export type RuleFeedSources = { profile: RuleProfile; sources: RuleSource[] };

/**
 * itdoginfo/allow-domains publishes, weekly, the address space of the hosting
 * providers and services that are blocked or throttled in Russia as a whole.
 * iplist only knows the sites in its own catalogue, so a foreign site on a
 * Hetzner, DigitalOcean or OVH address it has never heard of went direct and
 * hit the block. Whole provider ranges close that gap for ~470 prefixes.
 */
const ITDOG_SUBNETS = [
  "cloudflare",
  "cloudfront",
  "digitalocean",
  "hetzner",
  "ovh",
  "meta",
  "twitter",
  "discord",
  "telegram",
  "google_meet",
  "roblox",
].map(
  (name): RuleSource => ({
    url: `https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/${name}.lst`,
    format: "cidr-lines",
  }),
);

/**
 * The sources every deployment gets out of the box, so a fresh install has a
 * working route profile without an operator pasting JSON: iplist, the
 * itdoginfo provider ranges and Re:filter domains for the blacklist, minus
 * Russian address space. `RULE_FEEDS` overrides this list entirely;
 * `RULE_FEEDS=[]` opts out of feeds.
 */
export const DEFAULT_RULE_FEEDS: RuleFeedSources[] = [
  {
    profile: "ru_blacklist",
    sources: [
      // iplist rather than Re:filter's ipsum.lst: ipsum carries ~27k CIDRs,
      // and a config that large does not survive the trip to Android's VPN
      // service — the Messenger parcel lands around 2.7 MB against a 1 MB
      // Binder limit, so the profile never connects at all. iplist covers the
      // same services in ~3.6k aggregated prefixes.
      {
        url: "https://iplist.opencck.org/?format=text&data=cidr4",
        format: "cidr-lines",
      },
      ...ITDOG_SUBNETS,
      {
        url: "https://github.com/1andrevich/Re-filter-lists/releases/latest/download/domains_all.lst",
        format: "domain-lines",
      },
      // iplist aggregates down to /7 and /8, and those blocks swallow ~1.4M
      // Russian addresses: Yandex Cloud, Selectel and TimeWeb neighbours of a
      // blocked site, and whole MTS and Beeline subscriber pools. Russian
      // services increasingly refuse a foreign address, so anything hosted
      // there broke under this profile. Russian space stays direct; the cost
      // is that a blocked resource hosted inside Russia is not tunnelled.
      {
        url: "https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone",
        format: "cidr-lines",
        exclude: true,
      },
    ],
  },
];

const RULE_FEED_FORMATS: RuleFeedFormat[] = ["json", "cidr-lines", "domain-lines"];

/**
 * A profile this worker no longer supports but operators may still have in
 * their environment. Kept as a named constant so the reason it is tolerated
 * lives next to the code that tolerates it.
 */
const REMOVED_RULE_PROFILE = "ru_whitelist";

/**
 * Resolve the feeds to fetch from the environment, in priority order:
 *
 *   1. `RULE_FEEDS` — a JSON array of `{ profile, sources: [{ url, format }] }`.
 *   2. `DEFAULT_RULE_FEEDS` — only when the operator configured nothing, so a
 *      fresh install fetches the built-in blacklist feeds without any
 *      configuration at all.
 *
 * `RULE_FEEDS=[]` is a deliberate "no feeds": it counts as configuration, so it
 * opts out of the defaults instead of being treated as an absent value. A
 * malformed `RULE_FEEDS` throws rather than falling back — a typo in the
 * operator's own configuration must be visible, not silently replaced.
 *
 * The one exception is `REMOVED_RULE_PROFILE`, which is skipped with a warning
 * rather than refused: it was valid configuration before the profile was
 * removed, and a host still carrying it must survive the upgrade. Skipping it
 * still counts as configuration, so a `RULE_FEEDS` that named only that
 * profile ends up with no feeds rather than quietly gaining the defaults.
 */
export const resolveRuleFeeds = (
  env: Record<string, string | undefined>,
  isProfileApproved: (profile: RuleProfile) => boolean,
): RuleFeed[] => {
  const feeds: RuleFeedSources[] = [];
  let configured = false;

  const raw = env.RULE_FEEDS?.trim();
  if (raw) {
    configured = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("RULE_FEEDS is not valid JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("RULE_FEEDS must be an array");
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const profile = entry.profile;
      // `ru_whitelist` was a real profile until it was removed. Hosts upgrading
      // across that removal still carry it in their own RULE_FEEDS, and
      // throwing here would crash-loop the worker on a configuration that was
      // valid when it was written - taking rule updates, reconcile and every
      // queued job down with it. Skip it loudly instead; a genuinely unknown
      // profile is still a typo worth refusing to start on.
      if (profile === REMOVED_RULE_PROFILE) {
        console.warn(
          `RULE_FEEDS still lists the removed "${REMOVED_RULE_PROFILE}" profile; ignoring that entry. Drop it from RULE_FEEDS to silence this.`,
        );
        continue;
      }
      if (profile !== "ru_blacklist") {
        throw new Error(`RULE_FEEDS has an invalid profile: ${String(profile)}`);
      }
      // A malformed `exclude` is refused, not filtered out with the other bad
      // sources: dropping it would ship the list with the address space it
      // was meant to keep direct, and nothing would say so.
      const badExclude = (entry.sources as RuleSource[] | undefined)?.find(
        (source) =>
          source?.exclude !== undefined && typeof source.exclude !== "boolean",
      );
      if (badExclude) {
        throw new Error(
          `RULE_FEEDS entry for ${profile} has a non-boolean "exclude" on ${String(badExclude.url)}`,
        );
      }
      const sources = (entry.sources as RuleSource[] | undefined)?.filter(
        (source) =>
          typeof source?.url === "string" &&
          RULE_FEED_FORMATS.includes(source?.format),
      );
      // Exclusions alone describe nothing to route.
      if (!sources?.some((source) => !source.exclude)) {
        throw new Error(`RULE_FEEDS entry for ${profile} has no valid sources`);
      }
      feeds.push({ profile, sources });
    }
  }

  const resolved = configured ? feeds : DEFAULT_RULE_FEEDS;
  // Copy the sources: the defaults are a module-level constant, and handing out
  // the same array would let any caller's mutation corrupt every later call.
  return resolved.map((feed) => ({
    profile: feed.profile,
    sources: feed.sources.map((source) => ({ ...source })),
    pocApproved: isProfileApproved(feed.profile),
  }));
};

/**
 * Shape a validated payload's CIDRs into the list that gets published: the
 * `exclude` sources' address space taken out, and the rest compacted to the
 * fewest prefixes that cover it (see `subtractCidrs` for why every route
 * counts).
 *
 * Runs after validation so the invalid-entry ratio is judged on what the feeds
 * actually sent, not on a list an exclusion has already thinned. An invalid
 * payload passes through untouched: it is quarantined either way.
 */
export const compactRoutes = (
  validation: ValidRulePayload | InvalidRulePayload,
  excluded: string[],
): ValidRulePayload | InvalidRulePayload => {
  if (!validation.ok) return validation;
  const { cidrs, touched, removedShare } = subtractCidrs(
    validation.payload.cidrs,
    excluded,
  );
  const payload = { cidrs: [...cidrs].sort(), domains: validation.payload.domains };
  if (Math.max(removedShare[4], removedShare[6]) > MAX_EXCLUDED_SHARE) {
    return {
      ok: false,
      payload,
      report: {
        invalidEntries: [],
        reason: "exclusion_too_broad",
        excludedShare: Math.max(removedShare[4], removedShare[6]),
      },
    };
  }
  return {
    ok: true,
    payload,
    report: {
      ...validation.report,
      cidrCount: payload.cidrs.length,
      ...(touched > 0 ? { excludedPrefixes: touched } : {}),
    },
  };
};

const stableChecksum = (payload: RulePayload): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        cidrs: [...payload.cidrs].sort(),
        domains: [...payload.domains].sort(),
      }),
    )
    .digest("hex");

export const createRuleFetcher = ({
  repository,
  feed,
  fetchImpl = fetch,
  now = () => new Date(),
}: RuleFetcherOptions) => async (): Promise<void> => {
  const { profile, sources, pocApproved } = feed;
  const lastKnownGood = await repository.getLastKnownGoodRule(profile);

  // Fetch and parse every source, merging them into one payload. The version
  // is a stable checksum of the merged, canonical payload so unchanged feeds
  // are skipped even across multiple sources.
  const parsed: RulePayload[] = [];
  const excluded: string[] = [];
  let firstEtag: string | null = null;
  for (const source of sources) {
    const response = await fetchImpl(source.url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Rule source ${source.url} failed with status ${response.status}`,
      );
    }
    firstEtag ??= response.headers.get("etag");
    const payload = parseRuleSource(await readBoundedResponse(response), source.format);
    if (!source.exclude) {
      parsed.push(payload);
      continue;
    }
    const cidrs = payload.cidrs.map((value) => value.trim()).filter(isCidr);
    // An exclusion that answered with nothing usable must not pass as "exclude
    // nothing": that would quietly put the address space it exists to keep
    // direct back into the tunnel. Fail the tick and keep the last good list.
    if (cidrs.length === 0) {
      throw new Error(`Rule exclusion source ${source.url} has no valid CIDRs`);
    }
    excluded.push(...cidrs);
  }

  const validation = compactRoutes(
    validateRuleObject(mergeRulePayloads(parsed)),
    excluded,
  );
  const checksum = stableChecksum(validation.payload);
  if (checksum === lastKnownGood?.version) return;

  const baseInput = {
    profile,
    version: checksum,
    sourceUrl: sources.map((source) => source.url).join(" "),
    etag: firstEtag,
    checksum,
    payload: validation.payload,
    fetchedAt: now(),
  };
  if (!validation.ok) {
    await repository.storeQuarantinedRule({
      ...baseInput,
      validationReport: validation.report,
    });
    return;
  }
  if (!pocApproved) {
    await repository.storeQuarantinedRule({
      ...baseInput,
      validationReport: { ...validation.report, reason: "poc_gate_closed" },
    });
    return;
  }
  // An admin pinned this profile to a version of their choosing. Keep
  // fetching, keep recording what the feed now says, but do not publish it:
  // the panel shows the newer version next to the pinned one and the admin
  // decides. Idempotent across ticks — the insert conflicts on the second.
  if (lastKnownGood?.pinned) {
    await repository.storeUnpublishedRule({
      ...baseInput,
      validationReport: validation.report,
    });
    return;
  }
  await repository.activateRuleVersion({
    ...baseInput,
    validationReport: validation.report,
  });
};
