# AWG generator: per-key randomization switch and more presets

Status: approved 2026-11-21. Builds on `docs/AWG-GENERATOR.md` (#175, #176).

## Intent

Every registered IPv4 is a separate server for users, and the generator
settings of a node or address decide how its keys' client configs are built.
Administrators want to choose, per node or address, whether each user key gets
its own values in the style of the selected preset (so devices do not share one
fingerprint) or every key gets the same values. They also want more signature
packet shapes to choose from.

## Behaviour

A new setting `randomizeKeys` ("Randomize user keys") on the generator
settings of a node or address:

- **On:** every key draws its own Jc, Jmin, Jmax and signature-packet variant,
  reproducible from the key id, the settings and the key's profile revision
  (as today), so a key's downloads are stable and "Refresh config" moves it.
  Presets with ranges draw from their ranges. The fixed DNS-response presets
  keep their signature packet and draw J from the standard ranges
  (Jc 3-10, Jmin 40-100, gap 30-200).
- **Off:** every key of that node or address gets the same set: the preset's
  values, and for ranges a single draw seeded by the settings alone (the key id
  and revision are ignored). "Refresh config" then has nothing to change and
  is offered as unavailable, which the existing eligibility check already does.
- **Custom** turns the switch off and keeps it off: every key gets the custom
  values (exactly the numbers when min = max).
- **Issued** keeps the node's issued values; the switch does not apply.
- **Absent** (settings saved before this change): unchanged behaviour, i.e.
  ranges drawn per key and the fixed presets identical for every key.
- MTU is independent: changing it no longer turns a preset into Custom.

The reachability probe needs no change: it projects its own service key
through the same function, so it follows the same rules with its own key id.

## New presets

Each new signature shape in two levels, like the existing ones: "J only"
(randomized J ranges, no CPA, no custom timers; like DNS query / STUN) and
"full" (J + CPA 1-39 + Interface timing ranges; like Randomized).

| Shape | I packets | J only | Full |
| --- | --- | --- | --- |
| DNS AAAA query | 1 randomized query with QTYPE AAAA | `dns_query_aaaa` | `dns_query_aaaa_full` |
| DNS HTTPS query | QTYPE HTTPS (65) | `dns_query_https` | `dns_query_https_full` |
| DNS query burst | 3 randomized A queries | `dns_query_burst` | `dns_query_burst_full` |
| DNS query + STUN | I1 query, I2 STUN | `dns_query_stun` | `dns_query_stun_full` |
| STUN + DNS response | I1 STUN, I2 DNS response with random TTL | `stun_dns_response` | `stun_dns_response_full` |
| Noise | 3 random-length noise packets | `noise` | `noise_full` |

New signature modes: `dns_query_aaaa`, `dns_query_https`, `dns_query_stun`,
`stun_dns_response` (the burst uses `dns_query` with three slots, noise uses
`noise`). "DNS query with a random TTL" is not a thing (queries carry no TTL);
the TTL-randomized response with randomized J is the existing "DNS response
with randomized TTL" with the switch on.

## Approaches considered

1. **Setting on the generator profile** (chosen): one boolean next to the
   preset, applied where configs are projected. One place for exports and the
   probe, no migration (jsonb), old settings keep their behaviour.
2. Per-key flag on each user key: finer, but the request is per node/address
   and it would need key-level UI, API and migration.
3. Separate preset per randomization level ("dns_response_random_j"...):
   doubles every preset and mixes two independent choices into one list.

## Out of scope

Server-side AWG properties (S1-S4, H1-H4), per-key overrides, notifying users
that a new config is available.
