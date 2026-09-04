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

# --- Magic headers -----------------------------------------------------------
# amneziawg-go refuses a device whose headers overlap, so they must be distinct.
# 0..4 are the literal WireGuard message types: picking one puts the type field
# back where a plain-WireGuard classifier expects it. 0 is worse still - it
# reads back as "unset". Upper bound stays below 2^31 so nothing downstream has
# to care about sign.
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

# --- Special junk packet -----------------------------------------------------
# A DNS-response shape: static bytes carry the structure a censor would expect,
# the random tags carry the entropy. The stock spec everybody ships is a fixed
# DNS answer for icloud.com and is itself a fingerprint the moment two nodes are
# compared - this one differs per node in both its constants and its length.
#
# I-packets are never parsed by the peer, so a wrong spec cannot break a tunnel;
# it can only fail `awg setconf`. That makes this the safest thing to vary.
label_len="$(rand_range 3 12)"
ttl_hex="$(rand_hex 4)"
i1="<r 2><b 0x8180><b 0x00010001><b 0x00000000>"
i1="${i1}<b 0x$(printf '%02x' "$label_len")><rc ${label_len}>"
i1="${i1}<b 0x03636f6d00><b 0x00010001><b 0xc00c><b 0x00010001>"
i1="${i1}<b 0x${ttl_hex}><b 0x0004><r 4>"

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
