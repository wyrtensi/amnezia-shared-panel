---
name: updating-routing-rules
description: Use when auditing, adding, narrowing, optimizing, or maintaining split-tunnel routing rules (`ru_blacklist`, `RULE_EXTRAS`, `DEFAULT_RULE_FEEDS`, built-in direct shields), checking why a site or service goes DIRECT vs VPN, or verifying IPv4/IPv6 split-routing and route-table budgets.
---

# Updating routing rules (`ru_blacklist` / `compact_world`)

## Overview

Built-in split tunneling (`ru_blacklist`) runs in `compact_world` mode (E-Core): it merges upstream blocklists (`Re-filter-lists`, `itdoginfo/allow-domains`), subtracts Russian GeoIP (`ipdeny` RU IPv4/IPv6) and built-in direct shields, compacts the remaining RU exclusions into a small route table (~1,250–1,350 CIDRs), and finally unions `exact: true` extras.

Because `compact_world` aggressively expands RU exclusions into adjacent non-protected RIPE blocks (`87.*`, `176.*`, `185.*`, `188.*`, `193.*`, `212.*`, `2a00:*`–`2a10:*`), legitimate foreign services sitting next to Russian prefixes can be absorbed into **DIRECT** — or worse, **split-routed** (apex in VPN, login/CDN or IPv6 in DIRECT).

**Core principle:** verify DNS from multiple regions (including Russian DNS) for both IPv4 and IPv6, verify BGP/WHOIS ownership before widening any prefix, guarantee zero overlap with Russian GeoIP, and simulate against the live `compact_world` pipeline before committing.

## First check: is it actually a routing problem?

Do **not** edit routing rules before ruling out these look-alikes:

| Symptom | Real cause | Check first |
|---|---|---|
| DNS resolves and `ping` works, but HTTPS/TLS hangs after ClientHello | **MTU / MSS blackhole** | Verify `TCPMSS --clamp-mss-to-pmtu` on `awg0` and client `MTU = 1280` |
| Panel already published the new rule version, but user still hits DIRECT | **Stale client config** | WireGuard/AWG `AllowedIPs` is static on import; user must refresh/re-import the key |
| Domain resolves to bogus/ISP block-page IP on client only | **DNS leak / ISP poisoning** | Compare client DNS against `1.1.1.1` and `77.88.8.8` |

## Architecture and precedence

| Layer | Location | Behavior in `compact_world` | When to change |
|---|---|---|---|
| Upstream feeds | `DEFAULT_RULE_FEEDS` in `apps/worker/src/rules.ts` | Base includes (`Re-filter` `ipsum.lst` `/0`–`/24`, `itdoginfo` IPv4/IPv6, `domains_all.lst`) minus `ipdeny` RU IPv4/IPv6 | Rarely; only when an upstream feed URL/format changes |
| Built-in direct shields | `packages/vpn-config/src/cidrSet.ts` | Always DIRECT: `APPLE_DIRECT_V4_CIDRS`, `STEAM_CACHE_V4/V6`, `ALIEXPRESS_DIRECT_V4_CIDRS`, `BOGON_*` | When an overly broad shield swallows a foreign service (e.g. narrowing AliExpress `/16` → `/24` for HoYoLAB) |
| Core `RULE_EXTRAS` (`exact` unset) | `apps/worker/src/ruleExtras.ts` | Placed in `protectedCore` **before** RU expansion; blocks surrounding RU compaction | Only for huge foundational providers (`google-youtube`, `anthropic`, `wardogs`) |
| Exact `RULE_EXTRAS` (`exact: true`) | `apps/worker/src/ruleExtras.ts` | Unioned **after** RU expansion; does **not** fragment surrounding RU compaction | **Default choice** for missing foreign services, RIPE-adjacent allocations, and IPv6 fixes |
| Runtime overrides | `global_route_overrides` (admin UI/CLI), `RULE_EXTRA_INCLUDE_URLS`, `RULE_EXTRA_EXCLUDE_URLS` | Applied at runtime without code deploy; admin overrides beat built-ins | Emergency per-panel hotfixes or panel-specific exceptions |

## Step-by-step workflow

### 1. Map the full host graph

Never test only the apex domain. Collect every host involved in a real session:
- Apex + `www.` (e.g. `yahoo.com` AND `www.yahoo.com`)
- Consent / login / auth / API fronts (`consent.*`, `login.*`, `api.*`, `auth.*`)
- Static assets and media CDNs (`s.yimg.com`, `cdn.*`, `static.*`)
- Game/app SDK & matchmaking endpoints (often different ASN/CDN than the marketing site)

### 2. Run the multi-resolver & live compaction audit

Build the worker once so the audit script runs the exact production `compact_world` pipeline:

```bash
pnpm --filter @amnezia/worker build
node .claude/skills/updating-routing-rules/scripts/audit-domains.mjs --live --whois <domain1> <domain2> [candidate-cidr...]
```

The script automatically checks:
- **4 resolver views**: `cf` (Cloudflare DoH), `google` (Google DoH), **`ru-ecs` (Google DoH with Russian EDNS Client Subnet `77.88.8.0/24`)**, and `yandex-ru` (UDP `77.88.8.8`) — catches GeoDNS differences where Russian clients receive different CDN/Alibaba IPs than EU/US resolvers even when running behind a VPN.
- **Both IPv4 (`A`) and IPv6 (`AAAA`)** — prints `WARNING: SPLIT-ROUTED` whenever a domain mixes VPN and DIRECT across families or IPs.
- **RIPEstat** BGP prefix, ASN, and WHOIS (`netname`, `country`, `descr`).
- **`ipdeny` RU overlap** (`ru_overlap=0` is mandatory for every candidate prefix).
- **Live `compact_world` route budget** (`cidrs / 2800`) and whether each IP/CIDR is already `VPN(...)` or `DIRECT`.

### 3. Pick prefix granularity from verified ownership

Never guess a `/16` or `/24` from a single IP. Decide strictly from RIPEstat / RDAP WHOIS:

| Ownership result | What to add to `RULE_EXTRAS` | Slug convention |
|---|---|---|
| Dedicated foreign org / CDN allocation (`netname`/`org-name` belongs exclusively to the service or foreign CDN, `ru_overlap=0`) | The verified BGP allocation(s) (`/19`–`/24` IPv4, `/29`–`/32` IPv6) with **`exact: true`** | Permanent slug, e.g. `yahoo-eu`, `proton`, `fastly`, `wikimedia` |
| Shared hosting, ISP, or transit provider (e.g. Arelion transit, small hoster) | **Exact `/32` (or minimal observed CIDR) only** with **`exact: true`** | Date-stamped snapshot, e.g. `riot-eu-dns-2026-11-22` |
| Blocked by a built-in direct shield in `cidrSet.ts` | Narrow the shield in `packages/vpn-config/src/cidrSet.ts` to the verified direct subnet | Update `cidrSet.test.ts` |

Also check if a sibling IPv6 block exists when IPv4 is already tunneled (`major-cdn-v6`, `yahoo-eu`, `fastly`, `wikimedia`, `tuta`, `mega`). On dual-stack devices, Happy Eyeballs will prefer DIRECT IPv6 over VPN IPv4 and break the service.

### 4. Optimize and verify budgets

Before committing any rule change, verify all five invariants:

1. **Zero RU overlap:** Re-run `audit-domains.mjs <candidate-cidrs...>` and confirm `ru_overlap=0` for every added prefix.
2. **Zero redundant extras:** Never add a CIDR reported as `ALREADY_COVERED_IN_VPN` by `--live`.
3. **Minimal route-table impact:** Always use `exact: true` unless blocking RU expansion is explicitly required. Keep total `compact_world` routes comfortably under **`MAX_COMPACT_ROUTES = 2800`** (iOS `NEPacketTunnelProvider` fails near ~3,100 routes; Android Binder near ~6,800).
4. **Clipboard ceiling:** Keep the resulting `vpn://` payload comfortably under **`VPN_CLIPBOARD_MAX_CHARS = 32_767`** (~1,300 routes is ~4–5 KB).
5. **Document provenance in English:** Every `RULE_EXTRAS` entry in `apps/worker/src/ruleExtras.ts` must carry a short English comment stating the affected hosts, ASN/RIPE allocation or observation date, and why `compact_world` missed it.

### 5. Update tests and re-verify live

1. Edit `apps/worker/src/ruleExtras.ts` (and `packages/vpn-config/src/cidrSet.ts` if narrowing a shield).
2. Update `apps/worker/src/ruleExtras.test.ts` (and `packages/vpn-config/src/cidrSet.test.ts` if touched).
3. Rebuild and re-run the live audit to confirm every target domain now resolves cleanly to `VPN(...)` with zero `SPLIT-ROUTED` warnings and check the exact before/after route count:
   ```bash
   pnpm --filter @amnezia/worker build
   node .claude/skills/updating-routing-rules/scripts/audit-domains.mjs --live <domains...>
   ```
4. Run unit tests, typecheck, and build:
   ```bash
   pnpm --filter @amnezia/worker test
   pnpm --filter @amnezia/worker typecheck
   pnpm --filter @amnezia/vpn-config test
   ```
   *(Note: on Windows, `apps/worker/src/concurrency.test.ts` can occasionally flake by 1–5 ms under parallel load due to the 15.6 ms system timer; re-run it individually if it triggers.)*
5. When deploying to production panels, follow `operating-amnezia-fleet` and verify that panels auto-publish the expected new `ru_blacklist` version hash and CIDR count (and clear any temporary `global_route_overrides` that the built-in change replaces).

### 6. Periodic maintenance & pruning

When reviewing existing rules for cleanup:
- Run `audit-domains.mjs --live --whois` against all date-stamped `*-dns-YYYY-MM-DD` entries to check whether the observed IPs are still live or have rotated.
- Check whether any `RULE_EXTRAS` entry is now already covered by upstream `Re-filter` / `itdoginfo` (temporarily comment it out or check raw feeds) — remove redundant extras to keep the route table lean.
- Merge adjacent verified prefixes of the same organization into minimal supernets when safe (`ru_overlap=0`).

## Common mistakes

| Mistake | Why it fails | Instead |
|---|---|---|
| Testing only `1.1.1.1` / `8.8.8.8` | Misses RU GeoDNS responses (e.g. Alibaba Cloud `47.246.*` for HoYoLAB) | Always include `77.88.8.8` (Yandex RU) via `audit-domains.mjs` |
| Checking IPv4 only | Dual-stack clients take DIRECT IPv6 via Happy Eyeballs and fail | Always audit both `A` and `AAAA` and watch for `SPLIT-ROUTED` |
| Adding a RIPE `/24` without `exact: true` | Lands in `protectedCore`, shatters `compact_world` RU compaction, inflates route count | Set `exact: true` by default |
| Widening shared hosting or transit to `/24` or `/16` | Routes unrelated sites (or Russian neighbors) through the VPN | Check RIPEstat WHOIS; use `/32` + `*-dns-YYYY-MM-DD` on shared/transit space |
| Leaving temporary `global_route_overrides` after shipping a built-in fix | Overrides silently mask future built-in updates or cause divergence between panels | Clear the temporary override once the built-in rule is live |
| Assuming users get new rules immediately after panel deploy | Existing WireGuard/AWG configs embed `AllowedIPs` statically | New keys get it automatically; existing keys need a refresh/re-import |
