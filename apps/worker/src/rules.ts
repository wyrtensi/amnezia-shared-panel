import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 250_000;
// Fraction of entries allowed to be invalid before the whole feed is rejected.
// Community lists (Re:filter etc.) always carry a little noise, so drop the bad
// entries rather than quarantining a 100k-entry feed over a few stragglers.
const MAX_INVALID_RATIO = 0.15;
// TLD may be alphabetic OR a punycode IDN label (e.g. `.рф` → `xn--p1ai`).
const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

export type RulePayload = { cidrs: string[]; domains: string[] };
export type RuleValidationReport = Record<string, unknown>;
export type RuleProfile = "ru_whitelist" | "ru_blacklist";
export type RuleFeedFormat = "json" | "cidr-lines" | "domain-lines";
export type RuleSource = { url: string; format: RuleFeedFormat };

export type ValidRulePayload = {
  ok: true;
  payload: RulePayload;
  report: { cidrCount: number; domainCount: number; droppedInvalid?: number };
};

export type InvalidRulePayload = {
  ok: false;
  payload: RulePayload;
  report: { invalidEntries: string[]; reason?: string };
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
  } | null>;
  storeQuarantinedRule: (input: StoredRuleInput) => Promise<void>;
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
    parsed.push(parseRuleSource(await readBoundedResponse(response), source.format));
  }

  const merged = mergeRulePayloads(parsed);
  const validation = validateRuleObject(merged);
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
  await repository.activateRuleVersion({
    ...baseInput,
    validationReport: validation.report,
  });
};
