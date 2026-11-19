/**
 * One hand-picked addition to a route profile: address space no community
 * feed carries, added because a real service broke without it.
 */
export type RuleExtra = {
  /** Short slug; the version records it as `extra://<name>`. */
  name: string;
  cidrs: string[];
};

/**
 * Extras for the built-in `ru_blacklist` feed, one entry per service. Each
 * entry says where its ranges came from, so the next person can tell whether
 * it is still needed. They ride along with `DEFAULT_RULE_FEEDS` only: a host
 * with its own `RULE_FEEDS` owns its whole list and gets none of these.
 *
 * Add whole provider prefixes rather than the addresses one capture happened
 * to see: matchmaking hands out a different server every session.
 */
export const RULE_EXTRAS: RuleExtra[] = [
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
];
