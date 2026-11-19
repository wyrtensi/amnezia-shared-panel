import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import {
  APPLE_DIRECT_V4_CIDRS,
  BOGON_V4_CIDRS,
  BOGON_V6_CIDRS,
  STEAM_CACHE_V4_CIDRS,
  complementCidrs,
  countCidrOverlap,
  expandExclusionsSafely,
  measureCidrSpace,
  splitCidrsByFamily,
  subtractCidrs,
  supernetCidrsSafely,
} from "./cidrSet.js";
import { RULE_EXTRAS, type RuleExtra } from "./ruleExtras.js";

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
// Hard ceiling for compacted split profiles. Kept well under iOS's ~3,100-route
// NEPacketTunnelProvider failure cliff (amnezia-client#3207) and less than half
// of Android's ~6,800-route Binder limit.
export const MAX_COMPACT_ROUTES = 2800;
export const DEFAULT_COLLATERAL_CAP = 0.005;
const MAX_COLLATERAL_CAP = 0.25;

// TLD may be alphabetic OR a punycode IDN label (e.g. `.рф` → `xn--p1ai`).
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

export type RulePayload = { cidrs: string[]; domains: string[] };
export type RuleValidationReport = Record<string, unknown>;
export type RuleProfile = "ru_blacklist";
export type RuleFeedFormat = "json" | "cidr-lines" | "domain-lines";
export type RuleCompactionMode = "blocked_only" | "compact_world" | "lossless";

export type RuleCompactionOptions = {
  mode: RuleCompactionMode;
  /**
   * Maximum share (0..0.25) of non-forbidden public IPv4 space that gap-filling
   * supernetting may add in `blocked_only` mode.
   */
  collateralCap: number;
  /** Keep Apple's 17.0.0.0/8 direct so iOS updates / iCloud stay off the VPS. */
  directApple: boolean;
  /** Keep Valve AS32590 primary SteamCache download servers direct. */
  directSteamCache: boolean;
  /** Maximum compacted routes allowed before the version is quarantined. */
  maxCompactRoutes?: number;
};

/**
 * One feed source. An `exclude` source is not part of the list: its CIDRs are
 * taken OUT of what the other sources supply (its domains are ignored), so a
 * coarse feed can be trimmed by a list of address space that must stay direct.
 */
export type RuleSource = {
  url: string;
  format: RuleFeedFormat;
  exclude?: boolean;
  /**
   * Optional upper bound on IPv4 prefix length (0..32) kept from this source
   * (e.g. `24` keeps every `/0`–`/24` subnet while skipping scattered single-IP
   * `/25`–`/32` entries). IPv6 prefixes are not affected.
   */
  maxIpv4PrefixLength?: number;
};

export type ValidRulePayload = {
  ok: true;
  payload: RulePayload;
  report: {
    cidrCount: number;
    domainCount: number;
    ipv4Count?: number;
    ipv6Count?: number;
    losslessCidrCount?: number;
    compactionMode?: RuleCompactionMode;
    collateralNonRuShare?: number;
    ruOverlap?: number;
    bogonOverlap?: number;
    directShields?: string[];
    droppedInvalid?: number;
    /** Included prefixes an `exclude` source cut into or removed. */
    excludedPrefixes?: number;
    /** Names of the hand-picked extras merged into this version. */
    extras?: string[];
  };
};

export type InvalidRulePayload = {
  ok: false;
  payload: RulePayload;
  report: {
    invalidEntries: string[];
    reason?: string;
    excludedShare?: number;
    cidrCount?: number;
    maxCompactRoutes?: number;
  };
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

const filterIpv4PrefixLength = (
  cidrs: string[],
  maxIpv4PrefixLength: number,
): string[] =>
  cidrs.filter((entry) => {
    const [address, prefixRaw, extra] = entry.split("/");
    if (!address || !prefixRaw || extra !== undefined || !/^\d{1,3}$/.test(prefixRaw)) {
      return true;
    }
    if (isIP(address) !== 4) return true;
    const prefix = Number(prefixRaw);
    if (prefix > 32) return true;
    return prefix <= maxIpv4PrefixLength;
  });

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
  /** Hand-picked ranges added after the exclusions; see `RULE_EXTRAS`. */
  extras?: RuleExtra[];
  /** Compaction strategy applied after exclusion subtraction. */
  compaction?: RuleCompactionOptions;
  pocApproved: boolean;
};

export type RuleFetcherOptions = {
  repository: RuleRepository;
  feed: RuleFeed;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** A feed without the operator-controlled approval gate. */
export type RuleFeedSources = {
  profile: RuleProfile;
  sources: RuleSource[];
  extras?: RuleExtra[];
};

/**
 * itdoginfo/allow-domains publishes, weekly, the IPv4 and IPv6 address space of
 * the hosting providers and services that are blocked or throttled in Russia as
 * a whole. Including both families closes IPv6 leaks on dual-stack Wi-Fi
 * (particularly Meta/Instagram's 42 IPv6 prefixes) while keeping route counts
 * compact after RU-safe supernetting.
 */
const ITDOG_IPV4_NAMES = [
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
] as const;

const ITDOG_IPV6_NAMES = [
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
] as const;

const ITDOG_IPV4_SUBNETS: RuleSource[] = ITDOG_IPV4_NAMES.map((name) => ({
  url: `https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/${name}.lst`,
  format: "cidr-lines",
}));

const ITDOG_IPV6_SUBNETS: RuleSource[] = ITDOG_IPV6_NAMES.map((name) => ({
  url: `https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv6/${name}.lst`,
  format: "cidr-lines",
}));

/**
 * The sources every deployment gets out of the box:
 *   - Re:filter `ipsum.lst` filtered to `/0`–`/24` subnets (covers 99.7%+ of
 *     its IP volume without the ~9,700 isolated `/32` tail that blew up mobile
 *     route tables);
 *   - itdoginfo IPv4 (11 lists) and IPv6 (10 lists) provider & service ranges;
 *   - Re:filter `domains_all.lst` (metadata only; WG routes on CIDRs);
 *   - minus Russian IPv4 and IPv6 space from ipdeny.com;
 *   - plus `RULE_EXTRAS` (Google/YouTube dual-stack, Anthropic, Wardogs).
 *
 * Compacted by default with `blocked_only` RU-safe supernetting (~780 routes
 * total, 0% RU, 0% RFC1918/LAN, Apple & Valve SteamCache direct).
 */
export const DEFAULT_RULE_FEEDS: RuleFeedSources[] = [
  {
    profile: "ru_blacklist",
    sources: [
      {
        url: "https://github.com/1andrevich/Re-filter-lists/releases/latest/download/ipsum.lst",
        format: "cidr-lines",
        maxIpv4PrefixLength: 24,
      },
      ...ITDOG_IPV4_SUBNETS,
      ...ITDOG_IPV6_SUBNETS,
      {
        url: "https://github.com/1andrevich/Re-filter-lists/releases/latest/download/domains_all.lst",
        format: "domain-lines",
      },
      {
        url: "https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone",
        format: "cidr-lines",
        exclude: true,
      },
      {
        url: "https://www.ipdeny.com/ipv6/ipaddresses/aggregated/ru-aggregated.zone",
        format: "cidr-lines",
        exclude: true,
      },
    ],
    extras: RULE_EXTRAS,
  },
];

const RULE_FEED_FORMATS: RuleFeedFormat[] = ["json", "cidr-lines", "domain-lines"];
const RULE_COMPACTION_MODES: RuleCompactionMode[] = [
  "blocked_only",
  "compact_world",
  "lossless",
];

/**
 * A profile this worker no longer supports but operators may still have in
 * their environment. Kept as a named constant so the reason it is tolerated
 * lives next to the code that tolerates it.
 */
const REMOVED_RULE_PROFILE = "ru_whitelist";

const parseBooleanEnv = (
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: boolean,
): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false", got "${env[name]}"`);
};

/**
 * Resolve and validate the compaction settings from environment variables.
 * Throws loudly on typos so a broken setting cannot silently change routing.
 */
export const resolveRuleCompactionOptions = (
  env: Record<string, string | undefined>,
  hasCustomFeeds = false,
): RuleCompactionOptions => {
  const modeRaw = env.RULE_COMPACTION_MODE?.trim();
  const mode: RuleCompactionMode = modeRaw
    ? (modeRaw as RuleCompactionMode)
    : hasCustomFeeds
      ? "lossless"
      : "blocked_only";
  if (!RULE_COMPACTION_MODES.includes(mode)) {
    throw new Error(
      `RULE_COMPACTION_MODE must be one of ${RULE_COMPACTION_MODES.join(", ")}, got "${modeRaw}"`,
    );
  }

  const capRaw = env.RULE_COLLATERAL_CAP?.trim();
  let collateralCap = DEFAULT_COLLATERAL_CAP;
  if (capRaw) {
    const parsed = Number(capRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_COLLATERAL_CAP) {
      throw new Error(
        `RULE_COLLATERAL_CAP must be a number in [0, ${MAX_COLLATERAL_CAP}], got "${capRaw}"`,
      );
    }
    collateralCap = parsed;
  }

  return {
    mode,
    collateralCap,
    directApple: parseBooleanEnv(env, "RULE_DIRECT_APPLE", true),
    directSteamCache: parseBooleanEnv(env, "RULE_DIRECT_STEAM_CACHE", true),
    maxCompactRoutes: MAX_COMPACT_ROUTES,
  };
};

/**
 * Resolve the feeds to fetch from the environment, in priority order:
 *
 *   1. `RULE_FEEDS` — a JSON array of `{ profile, sources: [{ url, format }] }`.
 *   2. `DEFAULT_RULE_FEEDS` — only when the operator configured nothing, so a
 *      fresh install fetches the built-in blacklist feeds without any
 *      configuration at all.
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
      if (profile === REMOVED_RULE_PROFILE) {
        console.warn(
          `RULE_FEEDS still lists the removed "${REMOVED_RULE_PROFILE}" profile; ignoring that entry. Drop it from RULE_FEEDS to silence this.`,
        );
        continue;
      }
      if (profile !== "ru_blacklist") {
        throw new Error(`RULE_FEEDS has an invalid profile: ${String(profile)}`);
      }
      const rawSources = entry.sources as Array<Record<string, unknown>> | undefined;
      const badExclude = rawSources?.find(
        (source) =>
          source?.exclude !== undefined && typeof source.exclude !== "boolean",
      );
      if (badExclude) {
        throw new Error(
          `RULE_FEEDS entry for ${profile} has a non-boolean "exclude" on ${String(badExclude.url)}`,
        );
      }
      const badMaxPrefix = rawSources?.find(
        (source) =>
          source?.maxIpv4PrefixLength !== undefined &&
          (typeof source.maxIpv4PrefixLength !== "number" ||
            !Number.isInteger(source.maxIpv4PrefixLength) ||
            source.maxIpv4PrefixLength < 0 ||
            source.maxIpv4PrefixLength > 32),
      );
      if (badMaxPrefix) {
        throw new Error(
          `RULE_FEEDS entry for ${profile} has an invalid "maxIpv4PrefixLength" on ${String(badMaxPrefix.url)}`,
        );
      }
      const sources = (rawSources as RuleSource[] | undefined)?.filter(
        (source) =>
          typeof source?.url === "string" &&
          RULE_FEED_FORMATS.includes(source?.format),
      );
      if (!sources?.some((source) => !source.exclude)) {
        throw new Error(`RULE_FEEDS entry for ${profile} has no valid sources`);
      }
      feeds.push({ profile, sources });
    }
  }

  const compaction = resolveRuleCompactionOptions(env, configured);
  const resolved = configured ? feeds : DEFAULT_RULE_FEEDS;
  return resolved.map((feed) => ({
    profile: feed.profile,
    sources: feed.sources.map((source) => ({ ...source })),
    extras: (feed.extras ?? []).map((extra) => ({ ...extra, cidrs: [...extra.cidrs] })),
    compaction: { ...compaction },
    pocApproved: isProfileApproved(feed.profile),
  }));
};

/**
 * Shape a validated payload's CIDRs into the list that gets published:
 *
 *   1. Subtract `exclude` sources (Russian GeoIP) and reject if the exclusion
 *      removes more than 10% of the included address space (`exclusion_too_broad`).
 *   2. Merge hand-picked `extras` after exclusion.
 *   3. Apply the configured compaction mode (`blocked_only`, `compact_world`,
 *      or `lossless`), enforcing hard zero-overlap invariants against RU space
 *      and RFC1918/LAN/bogons plus the compact route ceiling.
 */
export const compactRoutes = (
  validation: ValidRulePayload | InvalidRulePayload,
  excluded: string[],
  extras: string[] = [],
  compaction?: RuleCompactionOptions,
): ValidRulePayload | InvalidRulePayload => {
  if (!validation.ok) return validation;
  const { cidrs: trimmed, touched, removedShare } = subtractCidrs(
    validation.payload.cidrs,
    excluded,
  );
  const losslessCidrs =
    extras.length > 0 ? subtractCidrs([...trimmed, ...extras], []).cidrs : trimmed;
  if (Math.max(removedShare[4], removedShare[6]) > MAX_EXCLUDED_SHARE) {
    return {
      ok: false,
      payload: {
        cidrs: [...losslessCidrs].sort(),
        domains: validation.payload.domains,
      },
      report: {
        invalidEntries: [],
        reason: "exclusion_too_broad",
        excludedShare: Math.max(removedShare[4], removedShare[6]),
      },
    };
  }

  const mode: RuleCompactionMode = compaction?.mode ?? "lossless";
  if (mode === "lossless") {
    const sorted = [...losslessCidrs].sort();
    const byFamily = splitCidrsByFamily(sorted);
    return {
      ok: true,
      payload: { cidrs: sorted, domains: validation.payload.domains },
      report: {
        ...validation.report,
        cidrCount: sorted.length,
        ipv4Count: byFamily[4].length,
        ipv6Count: byFamily[6].length,
        ...(compaction ? { compactionMode: "lossless" as const } : {}),
        ...(touched > 0 ? { excludedPrefixes: touched } : {}),
      },
    };
  }

  const directShieldNames: string[] = [];
  const directShieldCidrs: string[] = [];
  if (compaction?.directApple !== false) {
    directShieldNames.push("apple");
    directShieldCidrs.push(...APPLE_DIRECT_V4_CIDRS);
  }
  if (compaction?.directSteamCache !== false) {
    directShieldNames.push("steam-cache");
    directShieldCidrs.push(...STEAM_CACHE_V4_CIDRS);
  }

  const bogons = [...BOGON_V4_CIDRS, ...BOGON_V6_CIDRS];
  // Hand-picked extras are deliberate inclusions; keep forbidden shields clear
  // of them while still protecting RU space, LAN/bogons, and direct shields.
  const effectiveExcluded =
    extras.length > 0 ? subtractCidrs(excluded, extras).cidrs : excluded;
  const effectiveBogons =
    extras.length > 0 ? subtractCidrs(bogons, extras).cidrs : bogons;
  const effectiveDirectShields =
    extras.length > 0
      ? subtractCidrs(directShieldCidrs, extras).cidrs
      : directShieldCidrs;
  const forbidden = [
    ...effectiveExcluded,
    ...effectiveBogons,
    ...effectiveDirectShields,
  ];

  let finalCidrs: string[];
  let collateralNonRuShare: number;

  if (mode === "blocked_only") {
    const result = supernetCidrsSafely(losslessCidrs, forbidden, {
      maxExtraShare: { 4: compaction?.collateralCap ?? DEFAULT_COLLATERAL_CAP },
    });
    finalCidrs = [...result.cidrs].sort();
    collateralNonRuShare = result.collateralShare[4];
  } else {
    // `compact_world` requires an exclusion feed (e.g. Russian GeoIP), otherwise
    // taking the complement would turn the profile into an unintended full tunnel.
    if (effectiveExcluded.length === 0) {
      return {
        ok: false,
        payload: { cidrs: [], domains: validation.payload.domains },
        report: {
          invalidEntries: [],
          reason: "compact_world_requires_exclusions",
        },
      };
    }
    const protectedCore = subtractCidrs(losslessCidrs, forbidden).cidrs;
    // Cap RU expansion at /8 (IPv4) and /8 (IPv6) so a sparse protected list
    // can never let one Russian prefix swallow half of the address space while
    // still letting IPv6 Regional Registry /12 blocks compact cleanly (~77 v6).
    const expanded = expandExclusionsSafely(effectiveExcluded, protectedCore, {
      minCollapsePrefix: { 4: 8, 6: 8 },
    });
    const expandedByFamily = splitCidrsByFamily(expanded.cidrs);
    const shieldV4 = [
      ...expandedByFamily[4],
      ...splitCidrsByFamily(effectiveBogons)[4],
      ...splitCidrsByFamily(effectiveDirectShields)[4],
    ];
    const worldV4 = complementCidrs(shieldV4, 4);
    const worldV6 =
      expandedByFamily[6].length > 0
        ? complementCidrs(
            [...expandedByFamily[6], ...splitCidrsByFamily(effectiveBogons)[6]],
            6,
          )
        : supernetCidrsSafely(
            splitCidrsByFamily(protectedCore)[6],
            splitCidrsByFamily(effectiveBogons)[6],
          ).cidrs;
    finalCidrs = [...worldV4, ...worldV6].sort();

    const nonRuPubV4 = measureCidrSpace(
      complementCidrs(
        [...splitCidrsByFamily(effectiveExcluded)[4], ...BOGON_V4_CIDRS],
        4,
      ),
    )[4];
    const routedV4 = measureCidrSpace(worldV4)[4];
    const baseV4 = measureCidrSpace(
      splitCidrsByFamily(protectedCore)[4],
    )[4];
    const extraV4 = routedV4 > baseV4 ? routedV4 - baseV4 : 0n;
    collateralNonRuShare =
      nonRuPubV4 === 0n
        ? 0
        : Number((extraV4 * 100_000n) / nonRuPubV4) / 100_000;
  }

  // Hard post-compaction safety invariants: quarantine if any invariant fails.
  const ruOverlap = countCidrOverlap(finalCidrs, effectiveExcluded);
  if (ruOverlap[4] > 0n || ruOverlap[6] > 0n) {
    return {
      ok: false,
      payload: { cidrs: finalCidrs, domains: validation.payload.domains },
      report: { invalidEntries: [], reason: "ru_overlap_violation" },
    };
  }
  const bogonOverlap = countCidrOverlap(finalCidrs, effectiveBogons);
  if (bogonOverlap[4] > 0n || bogonOverlap[6] > 0n) {
    return {
      ok: false,
      payload: { cidrs: finalCidrs, domains: validation.payload.domains },
      report: { invalidEntries: [], reason: "bogon_overlap_violation" },
    };
  }
  if (extras.length > 0) {
    const missed = measureCidrSpace(subtractCidrs(extras, finalCidrs).cidrs);
    if (missed[4] > 0n || missed[6] > 0n) {
      return {
        ok: false,
        payload: { cidrs: finalCidrs, domains: validation.payload.domains },
        report: { invalidEntries: [], reason: "core_coverage_violation" },
      };
    }
  }
  const maxCompactRoutes = compaction?.maxCompactRoutes ?? MAX_COMPACT_ROUTES;
  if (finalCidrs.length > maxCompactRoutes) {
    return {
      ok: false,
      payload: { cidrs: finalCidrs, domains: validation.payload.domains },
      report: {
        invalidEntries: [],
        reason: "route_budget_exceeded",
        cidrCount: finalCidrs.length,
        maxCompactRoutes,
      },
    };
  }

  const byFamily = splitCidrsByFamily(finalCidrs);
  return {
    ok: true,
    payload: { cidrs: finalCidrs, domains: validation.payload.domains },
    report: {
      ...validation.report,
      cidrCount: finalCidrs.length,
      ipv4Count: byFamily[4].length,
      ipv6Count: byFamily[6].length,
      losslessCidrCount: losslessCidrs.length,
      compactionMode: mode,
      collateralNonRuShare,
      ruOverlap: 0,
      bogonOverlap: 0,
      directShields: directShieldNames,
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
  const { profile, sources, extras = [], compaction, pocApproved } = feed;
  const lastKnownGood = await repository.getLastKnownGoodRule(profile);

  // Extras live in code, so a bad prefix is a bug, not feed noise: refuse the
  // tick rather than publish a list that silently lacks the range.
  for (const extra of extras) {
    const invalid = extra.cidrs.find((value) => !isCidr(value));
    if (invalid !== undefined) {
      throw new Error(`Rule extra "${extra.name}" has an invalid CIDR: ${invalid}`);
    }
  }

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
    const rawPayload = parseRuleSource(await readBoundedResponse(response), source.format);
    const payload: RulePayload =
      source.maxIpv4PrefixLength !== undefined
        ? {
            cidrs: filterIpv4PrefixLength(rawPayload.cidrs, source.maxIpv4PrefixLength),
            domains: rawPayload.domains,
          }
        : rawPayload;
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

  const extraCidrs = extras.flatMap((extra) => extra.cidrs);
  const compacted = compactRoutes(
    validateRuleObject(mergeRulePayloads(parsed)),
    excluded,
    extraCidrs,
    compaction,
  );
  const validation =
    compacted.ok && extras.length > 0
      ? {
          ...compacted,
          report: { ...compacted.report, extras: extras.map((extra) => extra.name) },
        }
      : compacted;
  const checksum = stableChecksum(validation.payload);
  if (checksum === lastKnownGood?.version) return;

  const baseInput = {
    profile,
    version: checksum,
    sourceUrl: [
      ...sources.map((source) => source.url),
      ...extras.map((extra) => `extra://${extra.name}`),
    ].join(" "),
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
