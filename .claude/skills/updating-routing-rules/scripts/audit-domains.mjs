#!/usr/bin/env node
/**
 * Audit domains, IPs, or candidate CIDRs against:
 *   1. Multi-resolver DNS (1.1.1.1, 8.8.8.8, 77.88.8.8 Yandex RU, 9.9.9.9) for A + AAAA
 *   2. RIPEstat network-info (ASN + announced BGP prefix) and optional WHOIS summary
 *   3. ipdeny RU GeoIP overlap check (IPv4 + IPv6, cached 1h in OS tmpdir)
 *   4. Optional live `compact_world` simulation using `apps/worker/dist/rules.js`
 *
 * Usage:
 *   node .claude/skills/updating-routing-rules/scripts/audit-domains.mjs [options] <target...>
 *
 * Options:
 *   --live       Fetch DEFAULT_RULE_FEEDS via built worker and report VPN/DIRECT + route budget
 *   --whois      Also query RIPEstat WHOIS (netname/country/descr) for each announced prefix
 *   --no-ripe    Skip RIPEstat lookups
 *   --no-ru      Skip ipdeny RU overlap check
 *   --json       Emit machine-readable JSON instead of human summary
 */
import { Resolver } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESOLVERS = [
  { name: "cf", kind: "doh-json", url: "https://cloudflare-dns.com/dns-query" },
  { name: "google", kind: "doh-json", url: "https://dns.google/resolve" },
  { name: "ru-ecs", kind: "doh-json", url: "https://dns.google/resolve", ecs: "77.88.8.0/24" },
  { name: "yandex-ru", kind: "udp", ip: "77.88.8.8" },
];

const IPDENY_RU_V4 = "https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone";
const IPDENY_RU_V6 = "https://www.ipdeny.com/ipv6/ipaddresses/aggregated/ru-aggregated.zone";
const CACHE_TTL_MS = 60 * 60 * 1000;
const DNS_TIMEOUT_MS = 4000;

// --- IP / CIDR BigInt math (zero dependencies) ---

function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  let n = 0n;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`Invalid IPv4: ${ip}`);
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseIpv6(ip) {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail !== undefined ? tail.split(":").filter(Boolean) : [];
  const expandLastIpv4 = (parts) => {
    if (parts.length > 0 && parts[parts.length - 1].includes(".")) {
      const v4 = parseIpv4(parts.pop());
      parts.push(((v4 >> 16n) & 0xffffn).toString(16));
      parts.push((v4 & 0xffffn).toString(16));
    }
  };
  expandLastIpv4(tail !== undefined ? tailParts : headParts);
  const missing = tail !== undefined ? 8 - (headParts.length + tailParts.length) : 0;
  if (missing < 0 || (tail === undefined && headParts.length !== 8)) {
    throw new Error(`Invalid IPv6: ${ip}`);
  }
  const full = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  let n = 0n;
  for (const group of full) {
    n = (n << 16n) | BigInt(parseInt(group, 16));
  }
  return n;
}

function parseCidr(raw) {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  const ipStr = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const family = isIP(ipStr);
  if (family !== 4 && family !== 6) return null;
  const bits = family === 4 ? 32 : 128;
  const prefix = slash === -1 ? bits : Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const addr = family === 4 ? parseIpv4(ipStr) : parseIpv6(ipStr);
  const hostBits = BigInt(bits - prefix);
  const mask = ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n);
  const start = addr & mask;
  const end = start | ((1n << hostBits) - 1n);
  return { raw: `${ipStr}/${prefix}`, family, prefix, start, end };
}

function overlaps(a, b) {
  return a.family === b.family && a.start <= b.end && b.start <= a.end;
}

function contains(outer, inner) {
  return outer.family === inner.family && outer.start <= inner.start && outer.end >= inner.end;
}

// --- Cached HTTP fetches ---

async function fetchCachedText(url, cacheName) {
  const dir = join(tmpdir(), "amnezia-rules-audit");
  await mkdir(dir, { recursive: true });
  const file = join(dir, cacheName);
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < CACHE_TTL_MS) {
      return await readFile(file, "utf8");
    }
  } catch {
    // Cache miss.
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = await res.text();
  await writeFile(file, text, "utf8");
  return text;
}

async function loadRuCidrs() {
  const [v4Text, v6Text] = await Promise.all([
    fetchCachedText(IPDENY_RU_V4, "ru-v4.zone"),
    fetchCachedText(IPDENY_RU_V6, "ru-v6.zone"),
  ]);
  const cidrs = [];
  for (const line of `${v4Text}\n${v6Text}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parsed = parseCidr(trimmed);
    if (parsed) cidrs.push(parsed);
  }
  return cidrs;
}

// --- DNS + RIPEstat ---

async function resolveWithTimeout(fn) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function queryDohJson(baseUrl, domain, type, ecs) {
  const params = new URLSearchParams({ name: domain, type });
  if (ecs) params.set("edns_client_subnet", ecs);
  const res = await fetch(`${baseUrl}?${params.toString()}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const wantType = type === "A" ? 1 : 28;
  return (json?.Answer ?? [])
    .filter((rec) => rec?.type === wantType && typeof rec?.data === "string")
    .map((rec) => rec.data.trim())
    .filter((ip) => isIP(ip) === (type === "A" ? 4 : 6));
}

async function queryDomain(domain) {
  const results = {};
  await Promise.all(
    RESOLVERS.map(async (r) => {
      if (r.kind === "doh-json") {
        const [a, aaaa] = await Promise.all([
          queryDohJson(r.url, domain, "A", r.ecs).catch(() => []),
          queryDohJson(r.url, domain, "AAAA", r.ecs).catch(() => []),
        ]);
        results[r.name] = { a: [...new Set(a)].sort(), aaaa: [...new Set(aaaa)].sort() };
        return;
      }
      const resolver = new Resolver({ timeout: 2500, tries: 1 });
      resolver.setServers([r.ip]);
      try {
        const [a, aaaa] = await Promise.all([
          resolveWithTimeout(() => resolver.resolve4(domain)).catch(() => []),
          resolveWithTimeout(() => resolver.resolve6(domain)).catch(() => []),
        ]);
        results[r.name] = { a: [...new Set(a)].sort(), aaaa: [...new Set(aaaa)].sort() };
      } finally {
        resolver.cancel();
      }
    }),
  );
  return results;
}

async function ripeNetworkInfo(ip) {
  try {
    const res = await fetch(
      `https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(ip)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return {
      prefix: json?.data?.prefix ?? null,
      asns: Array.isArray(json?.data?.asns) ? json.data.asns : [],
    };
  } catch {
    return null;
  }
}

async function ripeWhoisSummary(resource) {
  try {
    const res = await fetch(
      `https://stat.ripe.net/data/whois/data.json?resource=${encodeURIComponent(resource)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const fields = {};
    for (const record of json?.data?.records ?? []) {
      for (const item of record) {
        const k = String(item.key ?? "").toLowerCase();
        if (["netname", "country", "descr", "org-name", "orgname"].includes(k) && !fields[k]) {
          fields[k] = item.value;
        }
      }
    }
    return fields;
  } catch {
    return null;
  }
}

// --- Live compact_world simulation ---

async function loadLiveCompactWorld() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../../..");
  const workerRulesPath = join(repoRoot, "apps/worker/dist/rules.js");
  let mod;
  try {
    mod = await import(pathToFileURL(workerRulesPath).href);
  } catch (err) {
    throw new Error(
      `Could not import ${workerRulesPath}. Run "pnpm --filter @amnezia/worker build" first. (${err.message})`,
    );
  }

  let result = null;
  const feed = {
    ...mod.DEFAULT_RULE_FEEDS[0],
    compaction: mod.resolveRuleCompactionOptions({}),
    pocApproved: true,
  };
  const run = mod.createRuleFetcher({
    feed,
    repository: {
      getLastKnownGoodRule: async () => null,
      getGlobalRouteOverrides: async () => ({ addCidrs: [], excludeCidrs: [] }),
      storeQuarantinedRule: async (input) => {
        result = { status: "quarantined", ...input };
      },
      storeUnpublishedRule: async (input) => {
        result = { status: "unpublished", ...input };
      },
      activateRuleVersion: async (input) => {
        result = { status: "active", ...input };
      },
    },
  });
  await run();
  if (!result) throw new Error("createRuleFetcher did not produce a rule version");
  return {
    status: result.status,
    version: result.version,
    maxCompactRoutes: mod.MAX_COMPACT_ROUTES,
    report: result.validationReport,
    cidrs: result.payload.cidrs.map(parseCidr).filter(Boolean),
  };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    live: args.includes("--live"),
    whois: args.includes("--whois"),
    ripe: !args.includes("--no-ripe"),
    ru: !args.includes("--no-ru"),
    json: args.includes("--json"),
  };
  const targets = args.filter((a) => !a.startsWith("--"));
  if (targets.length === 0 && !flags.live) {
    console.error(
      "Usage: node audit-domains.mjs [--live] [--whois] [--no-ripe] [--no-ru] [--json] <domain|ip|cidr...>",
    );
    process.exit(1);
  }

  const ipTargets = new Set();
  const directIpTargets = [];
  const cidrTargets = [];
  const domainTargets = [];

  for (const target of targets) {
    const asCidr = parseCidr(target);
    if (asCidr) {
      if (target.includes("/")) {
        cidrTargets.push(asCidr);
      } else {
        const ip = target.trim();
        ipTargets.add(ip);
        directIpTargets.push(ip);
      }
      continue;
    }
    domainTargets.push(target);
  }

  const [ruCidrs, live, domainReports] = await Promise.all([
    flags.ru ? loadRuCidrs() : Promise.resolve([]),
    flags.live ? loadLiveCompactWorld() : Promise.resolve(null),
    Promise.all(
      domainTargets.map(async (domain) => {
        const dns = await queryDomain(domain);
        const allV4 = [...new Set(Object.values(dns).flatMap((r) => r.a))].sort();
        const allV6 = [...new Set(Object.values(dns).flatMap((r) => r.aaaa))].sort();
        for (const ip of [...allV4, ...allV6]) ipTargets.add(ip);
        return { domain, dns, allV4, allV6 };
      }),
    ),
  ]);

  const ipMeta = new Map();
  await Promise.all(
    [...ipTargets].map(async (ip) => {
      const parsed = parseCidr(ip);
      const ruHit = ruCidrs.find((ru) => overlaps(ru, parsed))?.raw ?? null;
      const vpnHit = live ? live.cidrs.find((c) => contains(c, parsed))?.raw ?? null : undefined;
      const ripe = flags.ripe ? await ripeNetworkInfo(ip) : null;
      ipMeta.set(ip, { ip, family: parsed.family, ruHit, vpnHit, ripe });
    }),
  );

  const prefixWhois = new Map();
  if (flags.whois && flags.ripe) {
    const prefixes = new Set([
      ...cidrTargets.map((c) => c.raw),
      ...[...ipMeta.values()].map((m) => m.ripe?.prefix).filter(Boolean),
    ]);
    await Promise.all(
      [...prefixes].map(async (p) => {
        prefixWhois.set(p, await ripeWhoisSummary(p));
      }),
    );
  }

  const cidrReports = cidrTargets.map((c) => {
    const ruOverlaps = ruCidrs.filter((ru) => overlaps(ru, c)).map((ru) => ru.raw);
    const fullyInVpn = live ? live.cidrs.some((v) => contains(v, c)) : undefined;
    const partialVpn = live ? live.cidrs.filter((v) => overlaps(v, c)).map((v) => v.raw) : undefined;
    return {
      cidr: c.raw,
      family: c.family,
      ruOverlaps,
      fullyInVpn,
      partialVpn,
      whois: prefixWhois.get(c.raw) ?? null,
    };
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          live: live
            ? {
                status: live.status,
                version: live.version,
                cidrCount: live.cidrs.length,
                maxCompactRoutes: live.maxCompactRoutes,
                report: live.report,
              }
            : null,
          domains: domainReports,
          ips: Object.fromEntries(ipMeta),
          cidrs: cidrReports,
          whois: Object.fromEntries(prefixWhois),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (live) {
    console.log(
      `=== Live compact_world (${live.status}): version=${live.version.slice(0, 16)} cidrs=${live.cidrs.length}/${live.maxCompactRoutes} (v4=${live.report?.ipv4Count ?? "?"}, v6=${live.report?.ipv6Count ?? "?"}) ===`,
    );
  }

  for (const dr of domainReports) {
    console.log(`\n[Domain] ${dr.domain}`);
    const verdicts = new Set();
    for (const ip of [...dr.allV4, ...dr.allV6]) {
      const m = ipMeta.get(ip);
      const seenBy = RESOLVERS.filter(
        ({ name }) => dr.dns[name].a.includes(ip) || dr.dns[name].aaaa.includes(ip),
      ).map((r) => r.name);
      const routeTag =
        m.vpnHit === undefined ? "" : m.vpnHit ? ` VPN(${m.vpnHit})` : " DIRECT";
      if (m.vpnHit !== undefined) verdicts.add(`${m.family}:${m.vpnHit ? "VPN" : "DIRECT"}`);
      const ruTag = m.ruHit ? ` [RU_OVERLAP:${m.ruHit}]` : "";
      const ripeTag = m.ripe?.prefix
        ? ` bgp=${m.ripe.prefix} AS=${m.ripe.asns.join(",")}`
        : "";
      const whois = m.ripe?.prefix ? prefixWhois.get(m.ripe.prefix) : null;
      const whoisTag = whois
        ? ` whois=(${whois.netname ?? ""}/${whois.country ?? ""}${whois.descr ? `: ${whois.descr}` : ""})`
        : "";
      console.log(`  IPv${m.family} ${ip.padEnd(39)} [${seenBy.join(",")}]${routeTag}${ruTag}${ripeTag}${whoisTag}`);
    }
    if (dr.allV4.length === 0 && dr.allV6.length === 0) {
      console.log("  (no A/AAAA records returned)");
    }
    const hasVpn = [...verdicts].some((v) => v.endsWith(":VPN"));
    const hasDirect = [...verdicts].some((v) => v.endsWith(":DIRECT"));
    if (hasVpn && hasDirect) {
      console.log(`  WARNING: SPLIT-ROUTED (${[...verdicts].join(", ")})`);
    }
  }

  for (const ip of directIpTargets) {
    const m = ipMeta.get(ip);
    const routeTag =
      m.vpnHit === undefined ? "" : m.vpnHit ? ` VPN(${m.vpnHit})` : " DIRECT";
    const ruTag = m.ruHit ? ` [RU_OVERLAP:${m.ruHit}]` : " ru_overlap=0";
    const ripeTag = m.ripe?.prefix
      ? ` bgp=${m.ripe.prefix} AS=${m.ripe.asns.join(",")}`
      : "";
    const whois = m.ripe?.prefix ? prefixWhois.get(m.ripe.prefix) : null;
    const whoisTag = whois
      ? ` whois=(${whois.netname ?? ""}/${whois.country ?? ""}${whois.descr ? `: ${whois.descr}` : ""})`
      : "";
    console.log(`\n[IP] IPv${m.family} ${ip}${routeTag}${ruTag}${ripeTag}${whoisTag}`);
  }

  for (const cr of cidrReports) {
    const ruTag =
      cr.ruOverlaps.length > 0
        ? `RU_OVERLAP(${cr.ruOverlaps.length}: ${cr.ruOverlaps.slice(0, 3).join(", ")})`
        : "ru_overlap=0";
    const vpnTag =
      cr.fullyInVpn === undefined
        ? ""
        : cr.fullyInVpn
          ? " ALREADY_COVERED_IN_VPN"
          : cr.partialVpn.length > 0
            ? ` PARTIAL_VPN(${cr.partialVpn.length})`
            : " DIRECT";
    const whoisTag = cr.whois
      ? ` whois=(${cr.whois.netname ?? ""}/${cr.whois.country ?? ""}${cr.whois.descr ? `: ${cr.whois.descr}` : ""})`
      : "";
    console.log(`\n[CIDR] ${cr.cidr} ${ruTag}${vpnTag}${whoisTag}`);
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
