# AWG 3.1 client generator settings

Administrators configure export settings in the node card's generator editor.
The node defines defaults, and each registered IPv4 address can override them.
An address with inherited settings follows its node. A node with inherited
settings retains the existing issued-artifact and saved client-profile behavior.
The client MTU is a setting of its own next to the profile, and a user, a key
and a device type on an address can carry their own profile and MTU too (see
"Levels" below).

## Levels

A key's export resolves the **profile** and the **client MTU** separately, each
from the nearest level that sets it:

1. the key (set when issuing it or later, by an administrator);
2. its owner (an administrator's per-user settings, for every AWG 3.1 key of
   the user on any server);
3. its address's rule for the key's device type (Android, iOS, macOS,
   Windows, Linux, other; a key with an unspecified device type matches no
   rule);
4. its address (the key's address, or the node's primary one);
5. its node.

With no profile anywhere the issued artifact and saved client profile apply,
as before. With no MTU set anywhere the MTU stored inside the resolved profile
applies (settings saved before the MTU had its own setting), then 1280. So a
node can stay without a profile and still export MTU 1380, and an address can
follow its node's profile with an MTU of its own.

- Only administrators see or change user, key and device-type settings; the
  user API and cabinet never show them. The admin key list shows each AWG 3.1
  key's effective profile and MTU, the level each comes from and a "own
  settings" marker when a key, user or device rule sets something.
- The MTU is applied after the profile and is not part of a randomized
  profile's draw, so changing an MTU at any level never moves a key's Jc, Jmin,
  Jmax or signature packets.
- AWG 2.0 keys have no client profile: settings on an AWG 2.0 key are refused
  and a user's settings do not touch their AWG 2.0 keys. The probe's own
  account cannot get user or key settings.
- The reachability probe measures what an address's ordinary users get: the
  address and node levels only. User, key and device-type settings are not
  measured.
- Like every settings change, a new profile or MTU applies to the next export;
  a device that already imported the config imports it again.

The upgrade that introduced the separate MTU gave every node and address with
a saved profile that profile's MTU as its own MTU, so each exports the MTU it
exported before. Rolling back to an older release is safe: it does not know
the new columns and exports with the profile's own MTU, which the upgrade left
unchanged; user, key, device-type and profile-less MTU settings stop applying
until the newer release is back.

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
| DNS response (extended randomization) / + CPA and timings | Valid RFC 1035/2181 DNS A-response (see "Signature packets"), randomized J ranges (3-10 / 40-100 / +30-200); the base preset leaves CPA and Interface timing ranges unset, the full one (`dns_response_randomized_full`) adds them |
| DNS query | Single randomized DNS A-query I1 with randomized J ranges, unset CPA and Interface timing ranges |
| STUN request | Single STUN Binding Request I1 (20-44 bytes, see "Signature packets") with randomized J ranges, unset CPA and Interface timing ranges |
| No I-packets | Omit all I1-I5 signature packets (`none`), send only randomized J junk packets, unset CPA and Interface timing ranges |
| Randomized | Node geometry profile: randomized J ranges, a shuffled burst of a DNS query, a STUN request, a random DNS response and noise (`mixed`; 1-3 packets per key with randomization on, 3 with it off), CPA 1-39 and Interface timing ranges |
| Stock AmneziaVPN (CPA 10-100) | J 4 / 10 / 50, DNS response with random TTL, CPA 10-100 and stock timing ranges (`100-120` / `3-7` / `180-210` / `5-15` / `15-20`); exact stock with randomization off, J drawn around stock (4-8 / 10-50 / +40-80) and per-key CPA and timing sub-ranges with it on. A stock profile saved before 2026-11-22 keeps its stored Jc 4-6 (one shared value with randomization off); pick the preset again to get exact stock |
| DNS AAAA query / + CPA and timings | One randomized DNS query with QTYPE AAAA (`dns_query_aaaa`), randomized J ranges; the full variant adds CPA 1-39 and the Randomized timing ranges |
| DNS HTTPS query / + CPA and timings | The same with QTYPE HTTPS (65, `dns_query_https`) |
| Three DNS queries / + CPA and timings | Three randomized DNS A queries in I1-I3 (`dns_query`, three slots) |
| DNS query + STUN / + CPA and timings | I1 a randomized DNS A query, I2 a STUN Binding Request (`dns_query_stun`) |
| STUN + DNS response / + CPA and timings | I1 a STUN Binding Request, I2 a random DNS A-response (`stun_dns_response`) |
| Noise / + CPA and timings | Three random-length noise packets (`noise`, three slots) |
| A different I profile for each key / + CPA and timings | Each key draws one shape (`varied`): a DNS query, a random DNS response, a STUN request, or a mix of 1-3 packets; the base preset sends J only (no CPA or timers, for clients that need that branch), the full one (`varied_full`) adds per-key CPA and timing sub-ranges. With randomization off every key gets one shape. The reachability probe checks an address with one shape, its own service key's |
| Custom | Explicit client ranges and any signature mode (`issued`, `dns_response`, `dns_response_random_ttl`, `dns_response_random`, `dns_query`, `dns_query_aaaa`, `dns_query_https`, `dns_query_stun`, `stun_dns_response`, `stun`, `mixed`, `noise`, `varied`, `none`) selected by the administrator |

### Randomize user keys

Every profile except Issued has a **Randomize user keys** switch
(`randomizeKeys`):

- **On** (the default for every preset): each key draws its own Jc, Jmin, Jmax
  and signature-packet variant, reproducible from the key id, the settings and
  the key's configuration revision, so downloads stay stable and **Refresh
  config** moves the key to another draw. Presets with ranges draw from them;
  the two fixed DNS-response presets keep their packet and draw J from the
  standard ranges (Jc 3-10, Jmin 40-100, gap 30-200). The mixed and per-key
  shapes send 1 to their I count per key (narrow presets keep their count,
  which is part of their name), and CPA and every timing range become a
  per-key part of the configured range (lower bound from its low half, upper
  from its high half), which keeps RejectAfterTime above RekeyAfterTime and
  above KeepaliveTimeout + RekeyTimeout.
- **Off:** every key of the node or address gets the same values: the
  preset's numbers, and for ranges one draw from the settings alone; CPA and
  timing ranges are exported exactly as configured. Refresh config then has
  nothing to change and is offered as unavailable.
- **Custom** starts with it off (every key gets the administrator's values)
  and may turn it on; editing a custom profile keeps its switch.
- Settings saved before the switch existed keep their behaviour: ranged
  presets, the random-TTL DNS response and a ranged Custom draw per key, the
  plain DNS response is the same for every key. The editor shows them that way;
  an old Custom shows the switch on with a note that any edit gives
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
UPDATE nodes SET awg_generator = NULL WHERE awg_generator->>'preset' ~ '^(dns_query_(aaaa|https|burst|stun)|stun_dns_response|noise|dns_response_randomized_full|varied)' OR awg_generator->>'iMode' IN ('dns_query_aaaa', 'dns_query_https', 'dns_query_stun', 'stun_dns_response', 'varied');
UPDATE node_vpn_endpoints SET awg_generator = NULL WHERE awg_generator->>'preset' ~ '^(dns_query_(aaaa|https|burst|stun)|stun_dns_response|noise|dns_response_randomized_full|varied)' OR awg_generator->>'iMode' IN ('dns_query_aaaa', 'dns_query_https', 'dns_query_stun', 'stun_dns_response', 'varied');
```

Rolling back to a release that has the switch but not the newer presets
(`dns_response_randomized_full`, `varied`, `varied_full`, I mode `varied`) or
that refuses randomization on Custom: reset those the same way and turn the
switch off on Custom profiles. User and key settings (`users.awg_generator`,
`vpn_keys.awg_generator`) and device-type rules (`node_vpn_endpoints.awg_device_rules`)
need the same treatment when the target release reads them:

```sql
UPDATE nodes SET awg_generator = NULL WHERE awg_generator->>'preset' IN ('dns_response_randomized_full', 'varied', 'varied_full') OR awg_generator->>'iMode' = 'varied';
UPDATE node_vpn_endpoints SET awg_generator = NULL WHERE awg_generator->>'preset' IN ('dns_response_randomized_full', 'varied', 'varied_full') OR awg_generator->>'iMode' = 'varied';
UPDATE users SET awg_generator = NULL WHERE awg_generator->>'preset' IN ('dns_response_randomized_full', 'varied', 'varied_full') OR awg_generator->>'iMode' = 'varied';
UPDATE vpn_keys SET awg_generator = NULL WHERE awg_generator->>'preset' IN ('dns_response_randomized_full', 'varied', 'varied_full') OR awg_generator->>'iMode' = 'varied';
UPDATE nodes SET awg_generator = awg_generator || '{"randomizeKeys": false}' WHERE awg_generator->>'preset' = 'custom' AND awg_generator->>'randomizeKeys' = 'true';
UPDATE node_vpn_endpoints SET awg_generator = awg_generator || '{"randomizeKeys": false}' WHERE awg_generator->>'preset' = 'custom' AND awg_generator->>'randomizeKeys' = 'true';
UPDATE users SET awg_generator = awg_generator || '{"randomizeKeys": false}' WHERE awg_generator->>'preset' = 'custom' AND awg_generator->>'randomizeKeys' = 'true';
UPDATE vpn_keys SET awg_generator = awg_generator || '{"randomizeKeys": false}' WHERE awg_generator->>'preset' = 'custom' AND awg_generator->>'randomizeKeys' = 'true';
-- Device rules carry profiles inside a JSON object: drop the rules that hold one of these.
UPDATE node_vpn_endpoints SET awg_device_rules = NULL WHERE jsonb_path_exists(awg_device_rules,
  '$.*.awgGenerator ? (@.preset == "dns_response_randomized_full" || @.preset == "varied" || @.preset == "varied_full" || @.iMode == "varied" || (@.preset == "custom" && @.randomizeKeys == true))');
```

Changing the switch keeps the selected preset (the client MTU is a separate
field and never changes the preset); editing any other field
turns it into Custom with randomization off (range edits on Randomized stay
Randomized). The reachability probe draws through the same rules with its own
key.

### Signature packets

Every packet is one a real stack could send; tests expand each template and
parse it as DNS or STUN.

- **DNS queries and the random DNS response** (RFC 1035 / 2181 / 6891): a
  name of 1-3 random labels (0-2 subdomains, each label 1-63 bytes, the name
  at most 255) under a top-level domain drawn per key (`com`, `net`, `org`,
  `io`, `info`, `ru`, `de`, `app`, `dev`, `co`), and per key an EDNS0 OPT
  record or not (root name, type 41, a common UDP size, DO bit drawn, no
  options; ARCOUNT matches). The response points back with `0xc00c`, carries a
  positive TTL in [256, 32767] whose low byte AWG redraws per handshake, and an
  IPv4 answer under a public unicast first octet (`<b 0x..><r 3>`). AWG
  redraws the transaction ID, the label letters and the answer's last three
  bytes on every handshake; the shape is the key's.
- **STUN** (RFC 5389): a Binding Request whose length field matches its
  attributes, 20-44 bytes, drawn per key: no attributes, SOFTWARE of 4/8/12/16
  letters, CHANGE-REQUEST, or both when they fit. No FINGERPRINT: it is a CRC
  over the transaction ID AWG redraws on every handshake, so it could never be
  valid. No PRIORITY or ICE-CONTROLLING: without USERNAME and
  MESSAGE-INTEGRITY no ICE agent sends them.
- A `varied` key that draws the single DNS query also draws its query type:
  A, AAAA or HTTPS.
- The two fixed DNS-response presets keep the legacy 44-byte response they are
  named after; the conservative TTL variant uses adjacent TTL windows
  3840-4095, 4096-4351 and 4352-4607.

### Redraws

Each value is drawn on its own from the key id, the settings and the key's
configuration revision, so **Refresh config** redraws every value
independently (it used to move them all by one). When the next revision
happens to draw the same config, the refresh moves on to the following
revision, so it always changes something. Randomization is reproducible for a
key, settings and revision, so repeated downloads remain stable.

Changing settings affects subsequent exports, including exports of existing
keys. Imported profiles on devices need to be imported again. The shared AWG
interface and peer credentials are preserved. AWG 2.0 compatibility artifacts
retain their existing export behavior.

Client MTU is configurable from 1280 to 1420 at every level above. The
effective outer packet size also includes the existing S4, AWG
authentication/header overhead and optional padding. Choose an MTU appropriate
for the path and server geometry; on a bridged path keep MTU + S4 + 32 within
FRP's 1500-byte UDP buffer described below (for example MTU 1404 at most with
S4 64). FRP bridges do not define a separate tunnel
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
- Both also accept `awgMtu` (1280-1420, or `null` to inherit): the node's or
  the address's client MTU, apart from its profile.
- The address update accepts `awgDeviceRules`: an object keyed by device type
  (`android`, `ios`, `macos`, `windows`, `linux`, `other`), each
  `{ awgGenerator, awgMtu }` with at least one set; it replaces every rule of
  the address, `null` removes them.
- Node and address read models expose their stored `awgGenerator`, `awgMtu`
  and (addresses) `awgDeviceRules`. Node PATCH responses include them.
- `POST /api/admin/users/{userId}/set-config` and
  `POST /api/admin/keys/{keyId}/set-config` take `{ awgGenerator?, awgMtu? }`
  (at least one; `null` inherits; an omitted field is kept). Audited as
  `admin.users.set-config` and `vpn_key.config_set` with the preset id and
  MTU only.
- Key creation (`POST /api/keys` for an administrator,
  `POST /api/admin/users/{userId}/create-key`) accepts `awgGenerator` and
  `awgMtu` like the bridge fields: administrators only (403 otherwise), AWG 3.1
  only (409 `AWG_GENERATOR_UNSUPPORTED`).
- `GET /api/admin/keys` returns each key's `awgGenerator`, `awgMtu` and, for
  AWG 3.1, `config`: the resolved `awgGenerator`, `profileFrom`, `mtu`,
  `mtuFrom`, `probeChecked` and `inherited` (the same without the key's own
  settings).

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
the probe's own service key: every address is measured with its own effective
profile on its own route, and the address the service key was issued for is
not used. Each enabled direct address is measured at its own IP. Addresses
using the active bridge share a measurement only when their effective
projected client configurations match. Distinct profiles have
separate per-address results, including on the same bridge. A reply for an
older profile or path cannot update the current measurement. AWG 2.0 retains
the existing direct and diagnostic check rules.

The bridge activation check uses the node's default profile and MTU. Scheduled checks
also cover the address overrides and follow each address's bridge mode and
the portal default. Per-user bridge and route overrides, device-specific IPv6
settings, user, key and device-type client settings, and each user's
randomized draw are outside the probe's scope.
The probe samples the current generator with its own saved client profile;
it does not enumerate every active user's J/I draw or every historical profile
still imported on a device. Export hashes do not retain those historical
configurations, so an OK measurement cannot certify all previously issued
variants. AWG 2.0 continues to use the existing node-level direct service key.

Saving a changed profile or MTU on a node or an enabled address with checks on
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

Changing a generator, a node or address MTU or an address's bridge mode clears
affected AWG 3.1 reachability evidence until a matching measurement arrives.
User, key and device-type settings leave it untouched. Other address
overrides and AWG 2.0 evidence retain their existing results.

Administrator exports of another user's key retain authorization checks and
the `vpn_key.private_config_viewed` audit event. The former mandatory confirmation
checkbox and flag requirement have been removed. Older CLI clients may still
send the flag.
