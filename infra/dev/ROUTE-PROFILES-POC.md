# Route profiles PoC checklist

Routing profiles stay behind PoC gates until an operator confirms the official
AmneziaVPN client accepts the rule-shaped configs and routes correctly. Rule
versions are stored **quarantined** until the matching gate is opened.

## Profiles

- `full_tunnel` — all traffic through the VPN (always available).
- `ru_blacklist` — only RKN-blocked resources through the VPN, everything else direct.

> An earlier `ru_whitelist` profile (foreign resources through the VPN, RU
> destinations direct) was never confirmed through this checklist and has since
> been removed entirely — see migration `0035_drop_whitelist_profile`.

`ru_blacklist` applies its active rule set to `AllowedIPs` at **export time**
(`applyRouteProfileToVpnLink`). The official client cannot refresh routing on an
already-imported config, so a rules change flags the key as `rulesOutdated` and
the user re-downloads (the config then carries current rules).

## Gates

- The worker fetcher **activates fetched versions by default**. To hold the
  profile's auto-fetched versions in quarantine for review, set
  `RU_BLACKLIST_POC_APPROVED=false`.
- There is no bundled starter list. Every rule version comes from a configured
  feed, or from an explicit `POST /api/admin/rules/:id/import` payload.

## Checklist

1. Fetch (or import) a rule version for the profile and activate it (admin → Маршрутизация).
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

The profile ships with working default sources, so nothing has to be configured
for the fetcher to run. `RULE_FEEDS` (see `apps/worker/.env.example`) overrides
them, and `RULE_FEEDS=[]` turns feeds off. Community lists such as
antifilter.download are supported via the `cidr-lines` / `domain-lines` formats;
multiple sources per profile are merged and de-duplicated before validation.
