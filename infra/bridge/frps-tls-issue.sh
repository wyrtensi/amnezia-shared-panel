#!/bin/sh
# Host-side issuer adapter. The current leaf authenticates to Step CA over
# mTLS. Step requests the replacement using a new locally generated key.
set -eu

fail() {
  code="$1"
  shift
  printf 'FRP TLS issuer: %s\n' "$*" >&2
  exit "$code"
}

[ "$#" -eq 4 ] || fail 2 'expected current certificate, current key, candidate certificate, and candidate key'
current_cert="$1"
current_key="$2"
candidate_cert="$3"
candidate_key="$4"
ca_url="${FRPS_TLS_CA_URL:-}"
ca_file="${FRPS_TLS_CA_FILE:-/etc/amnezia-bridge/frp-trust/ca.crt}"

case "$ca_url" in
  https://?*) ;;
  *) fail 2 'FRPS_TLS_CA_URL must be an HTTPS URL' ;;
esac
case "$ca_url" in
  *[[:space:]@\?\#]*) fail 2 'FRPS_TLS_CA_URL cannot contain credentials, whitespace, query, or fragment' ;;
esac

for file in "$current_cert" "$current_key" "$ca_file"; do
  case "$file" in /*) ;; *) fail 2 'issuer file paths must be absolute' ;; esac
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    fail 2 'current pair and issuer trust bundle must be readable files'
  fi
done
for file in "$candidate_cert" "$candidate_key"; do
  case "$file" in /*) ;; *) fail 2 'issuer file paths must be absolute' ;; esac
  if [ -e "$file" ] || [ -L "$file" ]; then
    fail 2 'candidate paths must not already exist'
  fi
done

cert_path="$(realpath -m -- "$candidate_cert")" || fail 2 'invalid certificate output path'
key_path="$(realpath -m -- "$candidate_key")" || fail 2 'invalid key output path'
[ "$cert_path" != "$key_path" ] || fail 2 'candidate paths must be distinct'
command -v step >/dev/null 2>&1 || fail 2 'install the Smallstep CLI on the bridge host'

umask 077
if ! timeout -k 5s 60s step ca rekey "$current_cert" "$current_key" \
  "--ca-url=$ca_url" "--root=$ca_file" "--out-cert=$candidate_cert" "--out-key=$candidate_key" \
  </dev/null >/dev/null 2>&1; then
  fail 1 'rekey failed; check CA availability and whether the current leaf is enrolled for mTLS rekey'
fi
if [ ! -s "$candidate_cert" ] || [ ! -s "$candidate_key" ]; then
  fail 1 'issuer did not return a complete candidate pair'
fi
