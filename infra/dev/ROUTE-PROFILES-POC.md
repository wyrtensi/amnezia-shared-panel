# Route profiles PoC checklist (RoscomVPN)

Routing profiles stay behind PoC gates until an operator confirms the official
AmneziaVPN client accepts the rule-shaped configs and routes correctly. Rule
versions are stored **quarantined** until the matching gate is opened.

## Profiles

- `full_tunnel` — all traffic through the VPN (always available).
- `ru_whitelist` — foreign resources through the VPN, RU destinations direct.
- `ru_blacklist` — only RKN-blocked resources through the VPN, everything else direct.

Both non-full-tunnel profiles apply their active rule set to `AllowedIPs` at
**export time** (`applyRouteProfileToVpnLink`). The official client cannot refresh
routing on an already-imported config, so a rules change flags the key as
`rulesOutdated` and the user re-downloads (the config then carries current rules).

## Gates

- The worker fetcher **activates fetched versions by default**. To hold a
  profile's auto-fetched versions in quarantine for review, set
  `RU_WHITELIST_POC_APPROVED=false` / `RU_BLACKLIST_POC_APPROVED=false`.
- The admin "Load base list" seed activates a bundled starter set immediately
  (manual operator action, already reviewed), independent of the fetcher gate.

## Checklist per profile

1. Seed or fetch a rule version for the profile and activate it (admin → Маршрутизация).
2. Confirm `GET /api/route-profiles` reports the profile `available: true`.
3. Create a key with the profile against a real node and export the `vpn://` link.
4. Import into the official AmneziaVPN client (Windows / Android / iOS, 5.0.1.5+).
5. Verify split routing in both directions:
   - a resource in the rule set is reachable and exits via the VPN IP;
   - a resource outside the rule set exits via the local/direct IP;
   - DNS still resolves.
6. Re-run for AWG 2.0 and AWG 3.1 keys.
7. On success, set the profile's gate env to `true` in `infra/dev/.env` and the
   production worker env, and confirm the fetcher activates fetched versions
   (visible in admin → Маршрутизация, with an audit entry).

## Feed sources

Configure `RULE_FEEDS` (see `apps/worker/.env.example`). Community lists such as
antifilter.download are supported via the `cidr-lines` / `domain-lines` formats;
multiple sources per profile are merged and de-duplicated before validation.
