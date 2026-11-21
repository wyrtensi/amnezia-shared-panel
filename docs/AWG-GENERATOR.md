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
| DNS response | One legacy-shaped 44-byte DNS response, unset CPA and Interface timing ranges; J 4/40/70 with randomization off, per-key J from the standard ranges with it on |
| DNS response with randomized TTL | The DNS-response profile with a random transaction ID/TTL byte per handshake attempt; the TTL window (and, with randomization on, J) is drawn per key, or shared when it is off |
| DNS response (extended randomization) | Valid RFC 1035/2181 DNS A-response with randomized `.com` label length (3-12), TXID, TTL window (256-32767 s + random low byte per handshake), random IPv4 answer and randomized J ranges (3-10 / 40-100 / +30-200), unset CPA and Interface timing ranges |
| DNS query | Single randomized DNS A-query I1 with randomized J ranges, unset CPA and Interface timing ranges |
| STUN request | Single 32-byte STUN Binding Request I1 with randomized J ranges, unset CPA and Interface timing ranges |
| No I-packets | Omit all I1-I5 signature packets (`none`), send only randomized J junk packets, unset CPA and Interface timing ranges |
| Randomized | Node geometry profile: randomized J ranges, shuffled DNS/STUN/noise burst (`mixed`, I1-I3), CPA 1-39 and Interface timing ranges |
| Stock AmneziaVPN (CPA 10-100) | J 4-6 / 10 / 50, DNS response with random TTL, CPA 10-100 and stock timing ranges (`100-120` / `3-7` / `180-210` / `5-15` / `15-20`) |
| DNS AAAA query / + CPA and timings | One randomized DNS query with QTYPE AAAA (`dns_query_aaaa`), randomized J ranges; the full variant adds CPA 1-39 and the Randomized timing ranges |
| DNS HTTPS query / + CPA and timings | The same with QTYPE HTTPS (65, `dns_query_https`) |
| Three DNS queries / + CPA and timings | Three randomized DNS A queries in I1-I3 (`dns_query`, three slots) |
| DNS query + STUN / + CPA and timings | I1 a randomized DNS A query, I2 a STUN Binding Request (`dns_query_stun`) |
| STUN + DNS response with random TTL / + CPA and timings | I1 a STUN Binding Request, I2 the DNS response with a randomized TTL (`stun_dns_response`) |
| Noise / + CPA and timings | Three random-length noise packets (`noise`, three slots) |
| Custom | Explicit client ranges and any signature mode (`issued`, `dns_response`, `dns_response_random_ttl`, `dns_response_random`, `dns_query`, `dns_query_aaaa`, `dns_query_https`, `dns_query_stun`, `stun_dns_response`, `stun`, `mixed`, `noise`, `none`) selected by the administrator |

### Randomize user keys

Every profile except Issued has a **Randomize user keys** switch
(`randomizeKeys`):

- **On** (the default for every preset): each key draws its own Jc, Jmin, Jmax
  and signature-packet variant, reproducible from the key id, the settings and
  the key's configuration revision, so downloads stay stable and **Refresh
  config** moves the key to another draw. Presets with ranges draw from them;
  the two fixed DNS-response presets keep their packet and draw J from the
  standard ranges (Jc 3-10, Jmin 40-100, gap 30-200).
- **Off:** every key of the node or address gets the same values: the
  preset's numbers, and for ranges one draw from the settings alone. Refresh
  config then has nothing to change and is offered as unavailable.
- **Custom** keeps it off: every key gets the administrator's values.
- Settings saved before the switch existed keep their behaviour: ranged
  presets, the random-TTL DNS response and a ranged Custom draw per key, the
  plain DNS response is the same for every key. The editor shows them that way;
  an old Custom shows the switch on (locked) with a note that any edit gives
  every key the same values. The switch is not part of the draw, so turning it
  on for such settings does not move existing keys.

**Rolling the panel back** to a release before this switch: those releases
reject `randomizeKeys` and the newer preset ids, so exports and probe checks
for every node or address saved with them fail as invalid settings. Before
starting the older image, strip the flag and reset newer presets, for example:

```sql
UPDATE nodes SET awg_generator = awg_generator - 'randomizeKeys' WHERE awg_generator ? 'randomizeKeys';
UPDATE node_vpn_endpoints SET awg_generator = awg_generator - 'randomizeKeys' WHERE awg_generator ? 'randomizeKeys';
-- Presets and signature modes the older release does not know: inherit again (or pick an older preset first).
UPDATE nodes SET awg_generator = NULL WHERE awg_generator->>'preset' ~ '^(dns_query_(aaaa|https|burst|stun)|stun_dns_response|noise)' OR awg_generator->>'iMode' IN ('dns_query_aaaa', 'dns_query_https', 'dns_query_stun', 'stun_dns_response');
UPDATE node_vpn_endpoints SET awg_generator = NULL WHERE awg_generator->>'preset' ~ '^(dns_query_(aaaa|https|burst|stun)|stun_dns_response|noise)' OR awg_generator->>'iMode' IN ('dns_query_aaaa', 'dns_query_https', 'dns_query_stun', 'stun_dns_response');
```

Changing MTU or the switch keeps the selected preset; editing any other field
turns it into Custom with randomization off (range edits on Randomized stay
Randomized). The reachability probe draws through the same rules with its own
key.

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

Configuration refresh checks the effective exported profile. A profile that
produces the same configuration for every revision (randomization off, Custom,
or the plain DNS response saved before the switch) is ineligible for refresh. A direct
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

Saving a changed profile on a node or an enabled address with checks on
queues a probe run (while the probe is enabled), so the new profile is
measured right away instead of at the next scheduled run; until that run
finishes the address reads unknown (see "After a configuration change" in
[REACHABILITY-PROBE.md](REACHABILITY-PROBE.md)).

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
