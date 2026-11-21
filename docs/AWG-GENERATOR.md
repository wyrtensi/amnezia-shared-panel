# AWG 3.1 client generator settings

Administrators configure export settings in the node card's generator editor.
The node defines defaults, and each registered IPv4 address can override them.
An address with inherited settings follows its node. A node with inherited
settings retains the existing issued-artifact and saved client-profile behavior.

## Scope and presets

The editor controls client MTU, pre-handshake junk count and size ranges,
signature packet shape/count, ContentPaddingAddition and Interface timing ranges.
S1-S4, H1-H4, header-protection material, RandomTrailers and the live server
interface MTU remain properties of the shared AWG interface. Multiple public
addresses on that interface share those server properties.

| Preset | Export behavior |
| --- | --- |
| Issued profile | Preserve issued and saved client parameters, apply the selected client MTU |
| DNS response | One legacy-shaped 44-byte DNS response, J 4/40/70, unset CPA and Interface timing ranges |
| DNS response with randomized TTL | The DNS-response profile with a key-specific TTL window and a random transaction ID/TTL byte per handshake attempt |
| DNS response (extended randomization) | Valid RFC 1035/2181 DNS A-response with randomized `.com` label length (3-12), TXID, TTL window (256-32767 s + random low byte per handshake), random IPv4 answer and randomized J ranges (3-10 / 40-100 / +30-200), unset CPA and Interface timing ranges |
| DNS query | Single randomized DNS A-query I1 with randomized J ranges, unset CPA and Interface timing ranges |
| STUN request | Single 32-byte STUN Binding Request I1 with randomized J ranges, unset CPA and Interface timing ranges |
| No I-packets | Omit all I1-I5 signature packets (`none`), send only randomized J junk packets, unset CPA and Interface timing ranges |
| Randomized | Node geometry profile: randomized J ranges, shuffled DNS/STUN/noise burst (`mixed`, I1-I3), CPA 1-39 and Interface timing ranges |
| Stock AmneziaVPN (CPA 10-100) | J 4-6 / 10 / 50, DNS response with random TTL, CPA 10-100 and stock timing ranges (`100-120` / `3-7` / `180-210` / `5-15` / `15-20`) |
| Custom | Explicit client ranges and any signature mode (`issued`, `dns_response`, `dns_response_random_ttl`, `dns_response_random`, `dns_query`, `stun`, `mixed`, `noise`, `none`) selected by the administrator |

The conservative randomized DNS-response preset uses adjacent TTL windows 3840-4095,
4096-4351 and 4352-4607. The extended randomized DNS-response preset draws a
key-specific `.com` label length (3-12, total wire size 41-50 bytes) and positive
RFC 2181 TTL window (256-32767 s), while AWG randomizes the TXID, label
characters, low TTL byte and 4-byte IPv4 answer on every handshake attempt.
Advancing a key's configuration revision moves to a different draw.
Non-degenerate numeric ranges also advance between revisions.
Randomization is reproducible for a key, settings and revision, so repeated
downloads remain stable.

Changing settings affects subsequent exports, including exports of existing
keys. Imported profiles on devices need to be imported again. The shared AWG
interface and peer credentials are preserved. AWG 2.0 compatibility artifacts
retain their existing export behavior.

Client MTU is configurable from 1280 to 1420 (per node or per registered IPv4
address). The effective outer packet size also includes the existing S4, AWG
authentication/header overhead and optional padding. Choose an MTU appropriate
for the path and server geometry. FRP bridges do not define a separate tunnel
MTU: the client-to-bridge leg carries plain AWG UDP and the bridge-to-node FRP
leg runs over TCP/TLS, bounded only by FRP's default 1500-byte UDP read buffer
(`udpPacketSize`), which comfortably fits MTU 1280 + S4 <= 64 + 32-byte AWG
framing (at most 1376 bytes UDP payload).

## REST API

The shared request/response fields are defined in
`packages/contracts/src/awgGenerator.ts` and the existing node contracts.
All mutations use the existing administrator-only node PATCH endpoint.

- `PATCH /api/admin/nodes/{nodeId}` accepts `awgGenerator` as a fully resolved
  settings object or `null` to restore inherited behavior.
- The same endpoint accepts
  `publicEndpoint: { action: "update", id: endpointId, awgGenerator: settings }`
  for an address override. Set its `awgGenerator` to `null` to follow the node.
- Node and address read models expose their stored `awgGenerator`. Node PATCH
  responses include the updated node setting.

Use `awgGeneratorPresets()` from `@amnezia/contracts` to obtain complete preset
settings for an API client. Bounds are checked before persistence. Node edits
and address overrides use the existing transaction and audit paths.

Configuration refresh checks the effective exported profile. A fixed preset
that produces the same configuration is ineligible for refresh. A direct
refresh request in that state is rejected without advancing revision or its
update timestamp.

## Reachability checks

Regular checks apply the same AWG 3.1 client settings as config exports, using
the probe's own service key. Each enabled direct address is measured at its
own IP. Addresses using the active bridge share a measurement only when their
effective projected client configurations match. Distinct profiles have
separate per-address results, including on the same bridge. A reply for an
older profile or path cannot update the current measurement. AWG 2.0 retains
the existing direct and diagnostic check rules.

The bridge activation check uses the node's default profile. Scheduled checks
also cover the address overrides and follow each address's bridge mode and
the portal default. Per-user bridge and route overrides, device-specific IPv6
settings, and each user's randomized draw are outside the probe's scope.
The probe samples the current generator with its own saved client profile;
it does not enumerate every active user's J/I draw or every historical profile
still imported on a device. Export hashes do not retain those historical
configurations, so an OK measurement cannot certify all previously issued
variants. AWG 2.0 continues to use the existing node-level direct service key.

## Administrative key metadata

The Users key list exposes creation time and `configUpdatedAt`. The latter is
recorded on successful issuance/reissue, explicit profile refresh, changed rule
version, or generation of a changed exported configuration. Export fingerprints
are stored per format, so repeated identical exports preserve the timestamp.
Historical values that were never recorded remain unknown.

Export metadata is recorded only after the requested output renders
successfully. The transaction locks the key and checks that its source settings
and applicable global routes still match the rendered snapshot. A conflicting
refresh or settings change returns `409 CONFIG_EXPORT_STALE`; request the export
again. Identical concurrent exports keep the existing timestamp, and database
clock updates cannot move it backwards. Refresh tokens also bind the effective
generator settings, so an earlier token cannot refresh a newly selected preset.

Changing a generator or an address's bridge mode clears affected AWG 3.1
reachability evidence until a matching measurement arrives. Other address
overrides and AWG 2.0 evidence retain their existing results.

Administrator exports of another user's key retain authorization checks and
the `vpn_key.private_config_viewed` audit event. The former mandatory confirmation
checkbox and flag requirement have been removed. Older CLI clients may still
send the flag.
