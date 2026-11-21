# Generator variety, independent redraws and MSS clamping

Status: approved in conversation 2026-11-22 (plan plus six amendments from the
administrator). Builds on `docs/AWG-GENERATOR.md`.

## Intent

The per-key client values the panel draws are meant to make keys and servers
look different from each other. Several parts still give every key the same
bytes or move all values together, which is a fingerprint. Separately, a node
that recreates its AWG 3.1 container loses the manual TCP MSS clamp, so
clients with a larger tunnel MTU than the server interface stall on TCP.

## Behaviour

### Independent redraws

- `draw(label)` hashes `[profileSeed, revision, label]`; the revision is part
  of the seed instead of an offset added to every value. Shared draws
  (randomization off) keep revision 0.
- "Refresh config" must still change something: when the next revision draws
  the same config, the refresh takes the following one (bounded search).

### DNS packets (valid RFC 1035 / 2181 / 6891)

- Query name: 1-3 random labels (so 0-2 subdomains) under a top-level domain
  drawn per key from a fixed set; every label 1-63 bytes, the name at most 255.
- Per key, an EDNS0 OPT record (root name, type 41, UDP size drawn from common
  values, DO bit drawn, no options) is present or not; ARCOUNT matches.
- Random DNS response: the same name rules, compression pointer `0xc00c`,
  positive TTL below 2^31, and an IPv4 answer whose first octet comes from a
  set of public unicast first octets (`<b 0x..><r 3>`).
- `stun_dns_response(_full)` uses the random DNS response; `mixed` can include
  it; `dns_response_randomized` gets a `_full` pair. The legacy fixed DNS
  response stays only in the presets named after it.

### STUN packets (valid RFC 5389)

- A Binding Request whose length field matches its attributes, 20-44 bytes,
  drawn per key: no attributes, SOFTWARE (0x8022) of 4/8/12/16 random chars,
  CHANGE-REQUEST (0x0003), PRIORITY (0x0024, `<r 4>`), ICE-CONTROLLING
  (0x802a, `<r 8>`), in valid combinations. No FINGERPRINT: its CRC covers the
  transaction ID AWG redraws on every handshake, so it could never be valid.

### Per-key spread

With randomization on:

- `mixed` and the new per-key preset draw their I count per key, 1 to the
  configured count; narrow presets keep their count (it is part of their name).
- CPA and the five timing ranges become a per-key sub-range of the configured
  range (lower bound from the low half, upper from the high half). Sub-ranges
  of valid ranges keep every invariant (RejectAfterTime above RekeyAfterTime
  and above KeepaliveTimeout + RekeyTimeout, bounds within 1..65535); tests
  pin it.
- `amnezia_default` draws J from a stock-like spread instead of only Jc.

With randomization off every key of the node or address gets one set; for
`amnezia_default` that set is exact stock (J 4 / 10 / 50, CPA 10-100, stock
timings).

Custom may turn randomization on (default off).

### New preset pair: a different I profile per key

`varied` (J only, no CPA or timers: the mobile branch without CPA under
RandomTrailers) and `varied_full` (with per-key CPA and timings). Each key
draws one shape: a DNS query, a random DNS response, a STUN request, or a mix
of 1-3 packets. The reachability probe checks an address with one shape, its
own service key's.

### UI

Turning CPA on starts at 1-39 (0-0 exported as off).

### Node: MSS clamp

`awg3-entrypoint.sh` adds `iptables -t mangle ... TCPMSS --clamp-mss-to-pmtu`
for TCP SYN forwarded into and out of `awg0`, in the runtime block (and
removes it in `cleanup_interface`), and in the generated `PostUp`/`PostDown`
for completeness (`awg-quick strip` ignores them). Rolling it out to nodes
recreates their AWG 3.1 container and is left to the administrator.

### Docs

The rollback SQL in `docs/AWG-GENERATOR.md` covers the new presets and I modes.

## Constraints

Existing stored profiles stay valid. No real names or addresses in code,
tests or docs; English comments; commits to `main` by wyrtensi.
