/**
 * One hand-picked addition to a route profile: address space no community
 * feed carries, added because a real service broke without it.
 */
export type RuleExtra = {
  /** Short slug; the version records it as `extra://<name>`. */
  name: string;
  cidrs: string[];
  /**
   * Union these exact prefixes after `compact_world` RU expansion (and after
   * `blocked_only` supernetting) instead of placing them in `protectedCore`, so
   * narrow DNS observations never block surrounding RU exclusion compaction or
   * widen routed address space.
   */
  exact?: true;
};

/**
 * Extras for the built-in `ru_blacklist` feed, one entry per service. Each
 * entry says where its ranges came from, so the next person can tell whether
 * it is still needed. They ride along with `DEFAULT_RULE_FEEDS` only: a host
 * with its own `RULE_FEEDS` owns its whole list and gets none of these.
 *
 * Document the evidence and scope for each entry. Exact DNS observations are
 * time-limited snapshots and do not establish provider ownership or cover
 * changing endpoints.
 */
export const RULE_EXTRAS: RuleExtra[] = [
  {
    // Genshin Impact CN SDK host `hk4e-sdk-s.mihoyo.com`: four missing prefixes
    // covering eight observed IPv4 addresses returned by Google DoH on
    // 2026-11-21 (TTL 60). Exact DNS observation only — not a claim of
    // exclusive provider-subnet ownership or permanent coverage. Marked
    // `exact: true` so `compact_world` unions only these four prefixes without
    // blocking surrounding RU exclusion expansion.
    name: "genshin-sdk-dns-2026-11-21",
    exact: true,
    cidrs: [
      "171.43.164.91/32",
      "171.43.164.92/30",
      "171.43.164.96/31",
      "171.43.164.98/32",
    ],
  },
  {
    // Wardogs. Match servers sit on AWS, UDP 4192/4194: six servers across
    // three regions in one capture, every one inside the single 54.115.0.0/16
    // Amazon publishes (region GLOBAL). The Unity Multiplay/Relay hosts it also
    // talks to are AS35028's whole announcement. All of it went direct and
    // stalled after ~15 replies. Captured with pktmon on 2026-10-19.
    name: "wardogs",
    cidrs: ["54.115.0.0/16", "85.236.96.0/21", "85.236.104.0/23"],
  },
  {
    // Google / YouTube (AS15169) core IPv4 & IPv6 blocks. itdoginfo/allow-domains
    // publishes provider subnets for Cloudflare/Meta/etc. but not a Subnets/
    // file for YouTube/Google; carrying these explicitly ensures YouTube,
    // Gemini, and Google Web/API stay routed even when dropping noisy /32 tails.
    name: "google-youtube",
    cidrs: [
      "64.233.160.0/19",
      "74.125.0.0/16",
      "108.177.0.0/17",
      "142.250.0.0/15",
      "172.217.0.0/16",
      "172.253.0.0/16",
      "173.194.0.0/16",
      "192.178.0.0/15",
      "209.85.128.0/17",
      "216.58.192.0/19",
      "216.239.32.0/19",
      "2404:6800::/32",
      "2607:f8b0::/32",
      "2800:3f0::/32",
      "2a00:1450::/32",
      "2c0f:fb50::/32",
    ],
  },
  {
    // Anthropic / Claude API & web ingress (AS399358). Not covered by
    // itdoginfo's Cloudflare/provider lists.
    name: "anthropic",
    cidrs: ["160.79.104.0/23"],
  },
  {
    // Yahoo Europe (`www.yahoo.com`, `mail.yahoo.com`, `login.yahoo.com`,
    // `api.login.yahoo.com`, `s.yimg.com`, `finance.yahoo.com`). These RIPE
    // allocations (`UK-YAHOO-*`, AS10310/AS34010/AS203219/AS203220) sit next
    // to Russian blocks and were absorbed by `compact_world` RU expansion,
    // splitting Yahoo between VPN (`yahoo.com`/`consent.yahoo.com`) and DIRECT.
    name: "yahoo-eu",
    exact: true,
    cidrs: [
      "87.248.96.0/19",
      "188.125.64.0/19",
      "212.82.96.0/19",
      "2a00:1288::/32",
    ],
  },
  {
    // `expertizeme.org` (AS216139 IRONHOST). Observed single IPv4 host on
    // 2026-11-22 across 1.1.1.1, 8.8.8.8, 77.88.8.8, and 9.9.9.9; absorbed by
    // neighboring `176.*` RU expansion in `compact_world`.
    name: "expertizeme",
    exact: true,
    cidrs: ["176.98.186.130/32"],
  },
  {
    // Proton (`proton.me`, `mail.proton.me`, etc.) RIPE allocation
    // `CH-PROTONMAIL-20140915` (AS62371), absorbed by `185.*` RU expansion.
    name: "proton",
    exact: true,
    cidrs: ["185.70.40.0/22"],
  },
  {
    // Tuta (`tuta.com`, `app.tuta.com`) RIPE allocations (`AS210909`,
    // `DE-TUTA-20201009`), absorbed by `185.*` / `2a10:*` RU expansion.
    name: "tuta",
    exact: true,
    cidrs: ["185.205.69.0/24", "2a10:e000::/29"],
  },
  {
    // MEGA (`mega.nz`) Luxembourg allocations (`AS203055`, `MEGA-LU`).
    name: "mega",
    exact: true,
    cidrs: ["31.216.144.0/23", "2a0b:e46::/32"],
  },
  {
    // Fastly (AS54113) IPv4 (`open.spotify.com`) and IPv6 (`reddit.com`,
    // `bbc.com`, `pypi.org`, `mastodon.social`, `speedtest.net`, Spotify).
    name: "fastly",
    exact: true,
    cidrs: ["146.75.0.0/17", "2a04:4e42::/32"],
  },
  {
    // Google Cloud LB (`AS396982`) covering `linkedin.com` fronts (`130.211.*`)
    // that fell outside `compact_world`.
    name: "gcp-linkedin",
    exact: true,
    cidrs: ["130.211.0.0/16"],
  },
  {
    // Wikimedia Foundation (`wikipedia.org`, `ru.wikipedia.org`) RIPE NL
    // allocations (`US-WMF-20130110`, `US-WMF-20121130`, AS14907).
    name: "wikimedia",
    exact: true,
    cidrs: ["185.15.56.0/22", "2a02:ec80::/29"],
  },
  {
    // Atlassian Bitbucket (`bitbucket.org`) ingress subnet.
    name: "bitbucket",
    exact: true,
    cidrs: ["185.166.143.0/24"],
  },
  {
    // FACEIT (`faceit.com`, AS59835 DreamHack EFG).
    name: "faceit",
    exact: true,
    cidrs: ["193.41.200.0/24"],
  },
  {
    // MangaDex (`mangadex.org`, AS24482 SG.GS).
    name: "mangadex",
    exact: true,
    cidrs: ["45.129.229.0/24"],
  },
  {
    // Riot Games EU web fronts observed on Arelion transit (2026-11-22); kept
    // as exact `/32`s rather than routing transit space.
    name: "riot-eu-dns-2026-11-22",
    exact: true,
    cidrs: ["62.115.252.11/32", "62.115.252.26/32"],
  },
  {
    // Major foreign IPv6 blocks (Netflix AS2906, Akamai AS20940, AWS EU) whose
    // IPv4 endpoints were already tunneled while IPv6 fell into DIRECT.
    name: "major-cdn-v6",
    exact: true,
    cidrs: ["2a00:86c0::/32", "2a02:26f0::/32", "2a05:d014::/32"],
  },
];
