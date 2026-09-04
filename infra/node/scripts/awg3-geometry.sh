#!/bin/sh
# Generate the AmneziaWG 3.1 obfuscation geometry for ONE node.
#
# Why this exists: both entrypoints used to write the same constants on every
# node - Jc=4, Jmin=40, Jmax=70, S1=15, S2=20, S3=20, S4=23, and the stock
# icloud.com junk packet. Only H1-H4 and the header-protection key were per
# node. A classifier that learned one node therefore learned the whole fleet,
# and the junk packet was a fixed byte string shared with every default Amnezia
# install.
#
# Usage: awg3-geometry.sh <tunnel-mtu>
# Prints the parameter block on stdout, or fails without printing anything.
#
# The bounds below are not guesses. They come from reading amneziawg-go and
# amneziawg-tools; the ones that are enforced by the protocol are marked, and
# the ones nothing enforces are the reason this script asserts at the end.
set -eu

MTU="${1:-1376}"
case "$MTU" in
  ''|*[!0-9]*) echo "usage: awg3-geometry.sh <tunnel-mtu>" >&2; exit 2 ;;
esac

# Uniform in [lo, hi], from /dev/urandom. Rejection sampling rather than a
# modulo, so the low end of a range is not favoured.
rand_range() {
  lo="$1"; hi="$2"
  span=$(( hi - lo + 1 ))
  [ "$span" -gt 0 ] || { echo "empty range $lo..$hi" >&2; exit 1; }
  limit=$(( 4294967296 - (4294967296 % span) ))
  while :; do
    value="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
    [ -n "$value" ] || continue
    [ "$value" -lt "$limit" ] || continue
    printf '%s\n' $(( lo + (value % span) ))
    return 0
  done
}

rand_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# A `lo-hi` range: lo drawn from [$1,$2], width from [$3,$4]. The 3.1 timing
# keys draw a fresh value on EVERY timer arm, so a range makes the pattern
# genuinely non-periodic rather than a shifted constant - which is the whole
# point, since stock WireGuard's 120 s rekey beat is itself a signature.
rand_span() {
  lo="$(rand_range "$1" "$2")"
  printf '%s-%s\n' "$lo" "$(( lo + $(rand_range "$3" "$4") ))"
}

# --- Magic headers -----------------------------------------------------------
# amneziawg-go refuses a device whose headers overlap, so they must be distinct.
#
# 0 is excluded because a 0-0 range reads back as "unset" and round-trips wrong.
# 1..4 are excluded defensively: with a header-protection key the type field is
# XORed with keystream, so on the wire it does not matter - but the same config
# shape is used where that key might be absent, and there those four values are
# exactly the plain-WireGuard message types. Upper bound stays below 2^31 so
# nothing downstream has to care about sign.
h1=""; h2=""; h3=""; h4=""
for slot in 1 2 3 4; do
  while :; do
    candidate="$(rand_range 16 2147483646)"
    # Distinct across all four.
    for taken in $h1 $h2 $h3 $h4; do
      [ "$candidate" != "$taken" ] || { candidate=""; break; }
    done
    [ -n "$candidate" ] || continue
    case "$slot" in
      1) h1="$candidate" ;;
      2) h2="$candidate" ;;
      3) h3="$candidate" ;;
      4) h4="$candidate" ;;
    esac
    break
  done
done

# --- Junk packet sizes -------------------------------------------------------
# Local to each side and safe to reroll, but the ONE parameter pair that is
# genuinely dangerous: the daemon computes each junk packet as
# `min + fastrandn(max - min)` on uint32 and validates nothing, so Jmax < Jmin
# wraps to a roughly 4 GB allocation per junk packet per handshake. Strictly
# greater, always.
jc="$(rand_range 3 10)"
jmin="$(rand_range 40 100)"
jmax=$(( jmin + $(rand_range 30 200) ))

# --- Handshake junk sizes ----------------------------------------------------
# Hard floor of 12: with a header-protection key set, amneziawg-go rejects any
# S below the 12-byte header cipher nonce. Upper bounds are Amnezia's own
# declared maxima (dead code in the client, but they are the intended shape).
#
# S4 is the only S that costs payload, so it comes out of the MTU budget:
#   S4 + 32 + tunnelMTU + 28 <= 1500
s4_max=$(( 1500 - 32 - MTU - 28 ))
[ "$s4_max" -gt 64 ] && s4_max=64
if [ "$s4_max" -lt 12 ]; then
  echo "Refusing to generate: an MTU of $MTU leaves no room for S4 >= 12" >&2
  exit 1
fi

# The four packet classes must not land on the same size. The server tolerates
# it; amnezia-client's settings UI rejects the config, so the operator would
# find out only when a user says the app will not take their key.
attempt=0
while :; do
  attempt=$(( attempt + 1 ))
  if [ "$attempt" -gt 100 ]; then
    echo "Refusing to generate: could not find distinct packet sizes" >&2
    exit 1
  fi
  s1="$(rand_range 12 150)"
  s2="$(rand_range 12 150)"
  s3="$(rand_range 12 64)"
  s4="$(rand_range 12 "$s4_max")"
  c1=$(( s1 + 148 )); c2=$(( s2 + 92 )); c3=$(( s3 + 64 )); c4=$(( s4 + 32 ))
  [ "$c1" != "$c2" ] && [ "$c1" != "$c3" ] && [ "$c1" != "$c4" ] || continue
  [ "$c2" != "$c3" ] && [ "$c2" != "$c4" ] || continue
  [ "$c3" != "$c4" ] || continue
  break
done

# --- Special junk packets ----------------------------------------------------
# I-packets are sent before every handshake, in the fixed order I1..I5, and are
# never parsed by the peer - so a wrong spec cannot break a tunnel, only fail
# `awg setconf`. That makes them the safest thing to vary aggressively.
#
# What is worth varying is the SHAPE of the burst, not only the numbers in it.
# Per-node sizes change the constants; a censor watching two nodes still sees
# the same sequence of the same templates every time. So both the number of
# decoys and their order are drawn per node, and the slots are filled
# contiguously from I1 because the send order is what a watcher sees - which of
# I2..I5 a spec sits in is invisible once the order is fixed.

# A DNS QUERY, which is what a client actually sends to a server. The stock
# Amnezia spec is a DNS *response* travelling towards the server, which no
# resolver ever does; a response also needs a TTL, and a random 32-bit TTL is
# its own oddity (RFC 2181 reads anything above 2^31 as zero).
label_len="$(rand_range 3 12)"
t_dns="<r 2><b 0x0100><b 0x00010000><b 0x00000000>"
t_dns="${t_dns}<b 0x$(printf '%02x' "$label_len")><rc ${label_len}>"
t_dns="${t_dns}<b 0x03636f6d00><b 0x0001><b 0x0001>"

# A STUN Binding Request whose length field matches its contents. A response
# with a length that disagrees with its own attributes is worse than noise: it
# is a packet no real stack produces, so it identifies the fleet.
t_stun="<b 0x0001><b 0x000c><b 0x2112a442><r 12><b 0x8022><b 0x0008><rc 8>"

# No claimed structure at all. Invented structure is a signature; noise is only
# noise, and at a node-specific size it is not even a constant one.
t_noise="<r $(rand_range 48 220)>"

# Draw how many, and in which order. Both are per node.
decoy_count="$(rand_range 1 3)"
order="$(rand_range 1 6)"
case "$order" in
  1) templates="$t_dns|$t_stun|$t_noise" ;;
  2) templates="$t_dns|$t_noise|$t_stun" ;;
  3) templates="$t_stun|$t_dns|$t_noise" ;;
  4) templates="$t_stun|$t_noise|$t_dns" ;;
  5) templates="$t_noise|$t_dns|$t_stun" ;;
  *) templates="$t_noise|$t_stun|$t_dns" ;;
esac

i1=""; i2=""; i3=""; i4=""; i5=""
index=0
rest="$templates"
while [ "$index" -lt "$decoy_count" ]; do
  spec="${rest%%|*}"
  rest="${rest#*|}"
  index=$(( index + 1 ))
  case "$index" in
    1) i1="$spec" ;;
    2) i2="$spec" ;;
    3) i3="$spec" ;;
  esac
done

# --- 3.1 behaviour -----------------------------------------------------------
# ContentPaddingAddition REPLACES WireGuard's pad-to-a-multiple-of-16 on every
# transport packet. That lattice - "all ciphertext lengths are 0 mod 16" - is a
# strong classifier on its own, and this is what removes it. It is stripped by
# the receiver from the IP length field, so it needs no support on the far end.
content_padding="1-$(rand_range 16 64)"

# Timings. RekeyTimeout, KeepaliveTimeout and MaxHandshakeAttempts are redrawn
# on every timer arm, so a range genuinely removes their periodicity.
#
# RekeyAfterTime is weaker than it looks: keyRefreshTimeoutSending draws on
# every sent batch, so under continuous traffic the rekey lands close to the
# range's LOW end. The range still varies the interval per node and softens the
# beat, but it does not make it non-periodic - do not claim that it does.
rekey_after="$(rand_span 95 115 25 55)"
rekey_timeout="$(rand_span 4 6 2 4)"
reject_after="$(rand_span 200 230 30 60)"
keepalive_timeout="$(rand_span 8 12 5 10)"
max_handshakes="$(rand_span 12 16 4 8)"

# Deliberately NOT randomised. RandomTrailers must be identical on both ends,
# and a boolean carries one bit of per-node entropy - randomising it would buy
# nothing and cost a compatibility break. DisableCookies is an availability
# posture, not obfuscation entropy: on means the node stays silent to
# unauthenticated probes (a cookie reply is a distinctive artefact an active
# prober can elicit), at the cost of WireGuard's own DoS rate limiter. `on`
# matches upstream's own client default; override per host if a node is exposed
# and availability matters more than silence.
random_trailers=on
disable_cookies="${AWG3_DISABLE_COOKIES:-on}"

# --- Assertions --------------------------------------------------------------
# Everything above is generated; this is what refuses to emit a broken node.
fail_assert() { echo "Refusing to generate: $1" >&2; exit 1; }

[ "$jmin" -lt "$jmax" ] || fail_assert "Jmin ($jmin) must be below Jmax ($jmax)"
[ "$jmax" -le 1000 ] || fail_assert "Jmax ($jmax) is unreasonably large"
for s in "$s1" "$s2" "$s3" "$s4"; do
  [ "$s" -ge 12 ] || fail_assert "S value $s is below the 12-byte nonce floor"
  [ "$s" -le 65535 ] || fail_assert "S value $s does not fit a uint16"
done
[ $(( s4 + 32 + MTU + 28 )) -le 1500 ] || fail_assert "S4 ($s4) overflows the MTU budget"

# Every range must fit a uint16: the tools validate against UINT32_MAX but store
# into a uint16, so a larger value is silently truncated - RekeyAfterTime =
# 70000 quietly becomes 4464, and nothing anywhere says so.
range_lo() { printf '%s' "${1%%-*}"; }
range_hi() { printf '%s' "${1##*-}"; }
for r in "$content_padding" "$rekey_after" "$rekey_timeout" "$reject_after" \
         "$keepalive_timeout" "$max_handshakes"; do
  lo="$(range_lo "$r")"; hi="$(range_hi "$r")"
  [ "$lo" -le "$hi" ] || fail_assert "range $r is inverted"
  [ "$hi" -le 65535 ] || fail_assert "range $r would be truncated to a uint16"
done

# Timing coherence. Getting this wrong stalls a tunnel rather than failing it
# loudly: a keypair rejected before it can be rekeyed, or a keepalive that never
# fires within the session's life.
[ "$(range_hi "$rekey_after")" -lt "$(range_lo "$reject_after")" ] \
  || fail_assert "RekeyAfterTime must finish below RejectAfterTime"
[ "$(range_lo "$reject_after")" -gt \
  $(( $(range_hi "$keepalive_timeout") + $(range_hi "$rekey_timeout") )) ] \
  || fail_assert "RejectAfterTime must exceed KeepaliveTimeout + RekeyTimeout"
# A client that does not parse RejectAfterTime runs the stock 180 s; going below
# it would drop that client's traffic early.
[ "$(range_lo "$reject_after")" -ge 180 ] \
  || fail_assert "RejectAfterTime must not go below the stock 180s floor"

printf 'Jc = %s\n' "$jc"
printf 'Jmin = %s\n' "$jmin"
printf 'Jmax = %s\n' "$jmax"
printf 'S1 = %s\n' "$s1"
printf 'S2 = %s\n' "$s2"
printf 'S3 = %s\n' "$s3"
printf 'S4 = %s\n' "$s4"
printf 'H1 = %s\n' "$h1"
printf 'H2 = %s\n' "$h2"
printf 'H3 = %s\n' "$h3"
printf 'H4 = %s\n' "$h4"
printf 'I1 = %s\n' "$i1"
[ -z "$i2" ] || printf 'I2 = %s\n' "$i2"
[ -z "$i3" ] || printf 'I3 = %s\n' "$i3"
[ -z "$i4" ] || printf 'I4 = %s\n' "$i4"
[ -z "$i5" ] || printf 'I5 = %s\n' "$i5"
printf 'ContentPaddingAddition = %s\n' "$content_padding"
printf 'RekeyAfterTime = %s\n' "$rekey_after"
printf 'RekeyTimeout = %s\n' "$rekey_timeout"
printf 'RejectAfterTime = %s\n' "$reject_after"
printf 'KeepaliveTimeout = %s\n' "$keepalive_timeout"
printf 'MaxHandshakeAttempts = %s\n' "$max_handshakes"
printf 'RandomTrailers = %s\n' "$random_trailers"
printf 'DisableCookies = %s\n' "$disable_cookies"
