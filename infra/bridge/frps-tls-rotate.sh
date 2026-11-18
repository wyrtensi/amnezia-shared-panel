#!/bin/bash
# Host-only TLS rotation. The timer and manual apply share one transaction.
set -euo pipefail
umask 077
export LC_ALL=C

ETC="${AMNEZIA_ETC:-/etc}/amnezia-bridge"
FRP_DIR="$ETC/frp"
TRUST="$ETC/frp-trust"
STATE="$FRP_DIR/.tls-rotation"
PENDING="$FRP_DIR/.tls-pending"
TXN="$STATE/transaction"
CERT="$FRP_DIR/server.crt"
KEY="$FRP_DIR/server.key"
CA="$TRUST/ca.crt"
CONF="$FRP_DIR/frps.toml"
UNIT=amnezia-frps.service
BOOT_GUARD=amnezia-frps-tls-boot-restore.service
GATE="${BRIDGE_TLS_GATE:-}"
DEFAULT_ISSUER=/opt/amnezia-bridge/frps-tls-issue.sh
ISSUER="${BRIDGE_TLS_ISSUER:-$DEFAULT_ISSUER}"
RENEW_BEFORE="${BRIDGE_TLS_RENEW_BEFORE_SEC:-1209600}"
GATE_TIMEOUT="${BRIDGE_TLS_GATE_TIMEOUT_SEC:-210}"

fail() { printf '%s\n' "FRP TLS rotation: $*" >&2; exit 1; }

trusted() {
  local path="$1" type="$2" mode
  [[ ! -L "$path" ]] || return 1
  case "$type" in
    dir) [[ -d "$path" ]] || return 1 ;;
    *) [[ -f "$path" ]] || return 1 ;;
  esac
  [[ "$(stat -c %u -- "$path")" == "$EUID" ]] || return 1
  mode="$(stat -c %a -- "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  case "$type" in
    private) (( (8#$mode & 077) == 0 )) ;;
    *) (( (8#$mode & 022) == 0 )) ;;
  esac
}

trusted_program() {
  local path="$1" parent
  [[ "$path" == /* && -x "$path" ]] && trusted "$path" file || return 1
  [[ "$(realpath -es -- "$path")" == "$(realpath -e -- "$path")" ]] || return 1
  parent="$(dirname -- "$path")"
  while [[ "$parent" != / ]]; do
    # Tests use a private working directory below /tmp.
    [[ "$parent" != /tmp || "${AMNEZIA_ALLOW_NONROOT:-0}" != 1 ]] || break
    trusted "$parent" dir || return 1
    parent="$(dirname -- "$parent")"
  done
}

strict_number() {
  [[ "$1" =~ ^(0|[1-9][0-9]{0,8})$ ]] && (( $1 >= $2 && $1 <= $3 ))
}

ipv4() {
  local part
  local -a parts
  [[ "$1" =~ ^[0-9]+([.][0-9]+){3}$ ]] || return 1
  IFS=. read -r -a parts <<< "$1"
  for part in "${parts[@]}"; do strict_number "$part" 0 255 || return 1; done
}

pair_dir() { [[ "$1" =~ ^pair\.[A-Za-z0-9]{8}$ ]] && trusted "$STATE/$1" dir; }
fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f'; }
expiry() {
  local end
  end="$(openssl x509 -in "$1" -noout -enddate)" || return 1
  date -u -d "${end#notAfter=}" +%s
}

valid_pair() {
  local cert="$1" key="$2" at="$3" cert_pub key_pub
  trusted "$cert" file && trusted "$key" private || return 1
  # The bundled intermediates are untrusted. Only the CA file is authoritative.
  openssl verify -trusted "$CA" -untrusted "$cert" -purpose sslserver -verify_ip "$IP" -attime "$at" "$cert" || return 1
  cert_pub="$(openssl x509 -in "$cert" -pubkey -noout)" || return 1
  key_pub="$(openssl pkey -in "$key" -passin pass: -pubout)" || return 1
  [[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]]
}

valid_client_certificate() {
  # The built-in Step adapter uses the active leaf for mTLS on the next rekey.
  if [[ "$ISSUER" == "$DEFAULT_ISSUER" && -n "${FRPS_TLS_CA_URL:-}" ]]; then
    openssl verify -trusted "$CA" -untrusted "$1" -purpose sslclient "$1" >/dev/null 2>&1
  fi
}

current_id() {
  local chosen
  chosen="$(readlink -- "$STATE/current")" && pair_dir "$chosen" || return 1
  printf '%s\n' "$chosen"
}

live_fingerprint() {
  local peer
  peer="$(timeout -k 1s 5s openssl s_client -connect "127.0.0.1:$PORT" \
    -verifyCAfile "$CA" -verify_ip "$IP" -verify_return_error \
    -showcerts -no_ign_eof 9>&- </dev/null 2>/dev/null)" || return 1
  printf '%s\n' "$peer" | fingerprint /dev/stdin 2>/dev/null
}

publish_fingerprint() {
  local digest tmp
  digest="$(fingerprint "$CERT" 2>/dev/null)" && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  tmp="$(mktemp "$TRUST/.deployed.XXXXXXXX")" || return 1
  if printf '%s\n' "$digest" > "$tmp" && chmod 0644 "$tmp" && mv -fT -- "$tmp" "$TRUST/deployed-sha256" &&
    sync -f "$TRUST"; then
    return 0
  fi
  rm -f -- "$tmp"
  return 1
}

atomic_link() {
  local target="$1" path="$2" tmp
  tmp="$(mktemp -d "$STATE/.link.XXXXXXXX")" || return 1
  if ln -s -- "$target" "$tmp/link" && mv -fT -- "$tmp/link" "$path"; then
    rmdir -- "$tmp"
    return
  fi
  rm -f -- "$tmp/link"
  rmdir -- "$tmp"
  return 1
}

initial_pair() {
  local current name path wanted
  if [[ -e "$STATE/current" || -L "$STATE/current" ]]; then
    current="$(current_id)" || return 1
  else
    current="$(mktemp -d "$STATE/pair.XXXXXXXX")" || return 1
    install -m 0644 -- "$CERT" "$current/server.crt" && install -m 0600 -- "$KEY" "$current/server.key" || return 1
    current="${current##*/}"
    # Persist the copy before any legacy name can point to it.
    sync -f "$STATE" && atomic_link "$current" "$STATE/current" && sync -f "$STATE" || return 1
  fi
  for name in server.crt server.key; do
    path="$FRP_DIR/$name"
    wanted=".tls-rotation/current/$name"
    if [[ -L "$path" ]]; then
      [[ "$(readlink -- "$path")" == "$wanted" ]] || return 1
    else
      # Resume a partial migration only when the saved bytes still match.
      cmp -s -- "$path" "$STATE/$current/$name" && atomic_link "$wanted" "$path" || return 1
    fi
  done
  sync -f "$STATE" && publish_fingerprint || return 1
  printf '%s\n' "$current"
}

verify_routes() {
  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
  timeout -k 5s "$GATE_TIMEOUT" "$GATE" verify "$since" 9>&- < "$TXN/baseline" >/dev/null 2>&1
}

unit_active() {
  timeout -k 1s 5s systemctl is-active --quiet "$1" 9>&- >/dev/null 2>&1
}

switch_pair() {
  local chosen="$1" expected="$2" deadline published=0
  # frps opens the certificate and key separately, so stop it before
  # switching the common pointer, including any automatic restart job.
  timeout -k 5s 60s systemctl stop "$UNIT" 9>&- >/dev/null 2>&1 || return 1
  atomic_link "$chosen" "$STATE/current" && sync -f "$STATE" || return 1
  publish_fingerprint && published=1
  timeout -k 5s 60s systemctl start "$UNIT" 9>&- >/dev/null 2>&1 || return 1
  deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if unit_active "$UNIT" && [[ "$(live_fingerprint)" == "$expected" ]]; then
      (( published == 1 ))
      return
    fi
    sleep 1
  done
  return 1
}

close_transaction() {
  local unused="$1" completed selected
  selected="$(current_id)" && pair_dir "$unused" && [[ "$selected" != "$unused" ]] || return 1
  completed="$(mktemp -d "$STATE/.finished.XXXXXXXX")" || return 1
  # Publish completion in one rename. Partial cleanup cannot resurrect it.
  mv -T -- "$TXN" "$completed" && sync -f "$STATE" || return 1
  rm -rf -- "$completed" "${STATE:?}/${unused:?}"
}

load_transaction() {
  trusted "$TXN" dir && trusted "$TXN/previous" private && trusted "$TXN/candidate" private &&
    trusted "$TXN/baseline" private || return 1
  previous_pair="$(<"$TXN/previous")"
  candidate_pair="$(<"$TXN/candidate")"
  selected_pair="$(current_id)" || return 1
  pair_dir "$previous_pair" && pair_dir "$candidate_pair" && [[ "$previous_pair" != "$candidate_pair" ]] &&
    [[ "$selected_pair" == "$previous_pair" || "$selected_pair" == "$candidate_pair" ]] || return 1
  [[ "$(readlink -- "$CERT")" == .tls-rotation/current/server.crt &&
    "$(readlink -- "$KEY")" == .tls-rotation/current/server.key ]] || return 1
  valid_pair "$STATE/$previous_pair/server.crt" "$STATE/$previous_pair/server.key" "$(date -u +%s)" >/dev/null 2>&1
}

restore_before_boot() {
  load_transaction || return 1
  # The ordered boot service runs before frps opens either PEM file.
  # A later, separate recovery run checks the live routes and clears the journal.
  if unit_active "$UNIT"; then return 1; fi
  atomic_link "$previous_pair" "$STATE/current" && sync -f "$STATE" || return 1
  if ! publish_fingerprint; then
    printf '%s\n' "FRP TLS rotation: boot restored the previous pair but could not write monitoring metadata" >&2
  fi
}

restore() {
  local expected
  load_transaction || return 1
  expected="$(fingerprint "$STATE/$previous_pair/server.crt" 2>/dev/null)" || return 1
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  if [[ "$selected_pair" == "$previous_pair" ]] && unit_active "$UNIT" && [[ "$(live_fingerprint)" == "$expected" ]]; then
    publish_fingerprint || return 1
  else
    switch_pair "$previous_pair" "$expected" || return 1
  fi
  verify_routes && close_transaction "$candidate_pair"
}

mode=rotate
case "$#:$*" in
  0:) ;;
  1:--apply-pending) mode=pending ;;
  1:--recover) mode=recover ;;
  1:--restore-pair) mode=boot ;;
  *) fail "usage: frps-tls-rotate.sh [--apply-pending | --recover | --restore-pair]" ;;
esac
[[ "$EUID" == 0 || "${AMNEZIA_ALLOW_NONROOT:-0}" == 1 ]] || fail "run as root"
# ExecStopPost can run after an error that happened before a transaction existed.
if [[ ( "$mode" == recover || "$mode" == boot ) && ! -e "$TXN" && ! -L "$TXN" ]]; then exit 0; fi
if ! { trusted "$ETC" dir && trusted "$FRP_DIR" dir && trusted "$TRUST" dir &&
  trusted "$CONF" file && trusted "$CA" file && trusted "$TRUST/public-ip" file; }; then
  fail "missing or unsafe FRP configuration or trust files"
fi
IP="$(<"$TRUST/public-ip")"
ipv4 "$IP" || fail "frp-trust/public-ip must contain the bridge IPv4 address"
PORT="$(sed -n 's/^bindPort = //p' "$CONF")"
if ! { strict_number "$PORT" 1 65535 && grep -Fxq 'bindAddr = "0.0.0.0"' "$CONF" &&
  grep -Fxq 'transport.tls.force = true' "$CONF" &&
  grep -Fxq "transport.tls.certFile = \"$CERT\"" "$CONF" &&
  grep -Fxq "transport.tls.keyFile = \"$KEY\"" "$CONF"; }; then
  fail "frps.toml does not use the managed TLS listener and pair paths"
fi

[[ ! -L "$FRP_DIR/.tls-lock" ]] || fail "unsafe FRP lock"
exec 9>>"$FRP_DIR/.tls-lock"
trusted "$FRP_DIR/.tls-lock" private || fail "unsafe FRP lock"
flock -n 9 || fail "another FRP operation holds the lock"
if [[ -e "$STATE" || -L "$STATE" ]]; then
  if ! trusted "$STATE" dir || [[ "$(stat -c %a -- "$STATE")" != 700 ]]; then
    fail "unsafe TLS state directory"
  fi
fi
if [[ "$mode" == boot ]]; then
  if [[ -e "$TXN" || -L "$TXN" ]]; then
    restore_before_boot || fail "could not restore the previous pair before frps startup"
    printf '%s\n' "Previous pair selected for boot. Route verification remains pending."
  fi
  exit 0
fi
trusted_program "$GATE" || fail "BRIDGE_TLS_GATE must name a protected, absolute executable path"
strict_number "$GATE_TIMEOUT" 30 330 || fail "BRIDGE_TLS_GATE_TIMEOUT_SEC must be 30-330"
if [[ -e "$TXN" || -L "$TXN" ]]; then
  restore || fail "interrupted rotation could not be verified after rollback; transaction retained"
  printf '%s\n' "Previous certificate and routes restored after an interrupted rotation."
  exit 0
fi
[[ "$mode" != recover ]] || exit 0
strict_number "$RENEW_BEFORE" 300 31536000 || fail "BRIDGE_TLS_RENEW_BEFORE_SEC must be 300-31536000"

in_window() {
  local now
  now="$(date -u +%H:%M)" || return 1
  [[ ! "$now" < "${window%-*}" && "$now" < "${window#*-}" ]]
}
if [[ "$mode" == rotate ]]; then
  window="${BRIDGE_TLS_WINDOW_UTC:-}"
  if [[ ! "$window" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$ ]] ||
    [[ ! "${window%-*}" < "${window#*-}" ]]; then
    fail "BRIDGE_TLS_WINDOW_UTC must be HH:MM-HH:MM within the same UTC day"
  fi
  in_window || exit 0
  if [[ -f "$STATE/last-attempt" && "$(<"$STATE/last-attempt")" == "$(date -u +%F)" ]]; then exit 0; fi
fi

for name in server.crt server.key; do
  if [[ -L "$FRP_DIR/$name" ]]; then
    if [[ "$(readlink -- "$FRP_DIR/$name")" != ".tls-rotation/current/$name" ]] || ! current_id >/dev/null; then
      fail "unsafe managed certificate paths"
    fi
  fi
done
live_cert="$(realpath -e -- "$CERT")" || fail "current certificate is missing"
live_key="$(realpath -e -- "$KEY")" || fail "current key is missing"
valid_pair "$live_cert" "$live_key" "$(date -u +%s)" >/dev/null 2>&1 || fail "current pair must be valid for a safe rollback"
expires="$(expiry "$live_cert" 2>/dev/null)" || fail "cannot read the current expiry"
now="$(date -u +%s)"
if [[ "$mode" == rotate ]] && (( expires - now > RENEW_BEFORE )); then exit 0; fi
expected="$(fingerprint "$live_cert" 2>/dev/null)"
unit_active "$BOOT_GUARD" || fail "enable and start the FRP TLS boot restore guard before rotating"
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]] || ! unit_active "$UNIT" ||
  [[ "$(live_fingerprint)" != "$expected" ]]; then
  fail "active frps does not present the expected current certificate"
fi

if [[ ! -d "$STATE" ]]; then mkdir -m 0700 -- "$STATE"; fi
candidate="$(mktemp -d "$STATE/pair.XXXXXXXX")"
draft="$(mktemp -d "$STATE/.transaction.XXXXXXXX")"
cleanup() {
  rm -rf -- "$draft"
  if [[ ! -d "$TXN" && "$(current_id 2>/dev/null || true)" != "${candidate##*/}" ]]; then
    rm -rf -- "$candidate"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$mode" == pending ]]; then
  if ! { trusted "$PENDING" dir && trusted "$PENDING/server.crt" file && trusted "$PENDING/server.key" private; }; then
    fail "missing or unsafe staged pair in .tls-pending"
  fi
  install -m 0644 -- "$PENDING/server.crt" "$candidate/server.crt"
  install -m 0600 -- "$PENDING/server.key" "$candidate/server.key"
else
  valid_client_certificate "$live_cert" ||
    fail "current leaf lacks TLS client authentication; apply a Step bootstrap pair first"
  trusted_program "$ISSUER" || fail "BRIDGE_TLS_ISSUER must name a protected, absolute executable path"
  timeout -k 5s 90s "$ISSUER" "$live_cert" "$live_key" "$candidate/server.crt" "$candidate/server.key" \
    9>&- </dev/null >/dev/null 2>&1 || fail "certificate issuer failed"
fi

now="$(date -u +%s)"
valid_pair "$candidate/server.crt" "$candidate/server.key" "$now" >/dev/null 2>&1 ||
  fail "candidate chain, IPv4, validity or key mismatch"
valid_client_certificate "$candidate/server.crt" ||
  fail "candidate lacks TLS client authentication for the next Step rekey"
next_expiry="$(expiry "$candidate/server.crt" 2>/dev/null)" || fail "cannot read the candidate expiry"
(( next_expiry > expires && next_expiry - now > RENEW_BEFORE )) ||
  fail "candidate must extend expiry beyond the renewal threshold"
next_fingerprint="$(fingerprint "$candidate/server.crt" 2>/dev/null)"
[[ "$next_fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "cannot fingerprint the candidate"

(
  ulimit -f 64
  timeout -k 5s "$GATE_TIMEOUT" "$GATE" baseline 9>&- </dev/null
) > "$draft/baseline" 2>/dev/null || fail "could not capture the route verification baseline"
[[ -s "$draft/baseline" && "$(stat -c %s -- "$draft/baseline")" -le 65536 ]] ||
  fail "route verification baseline is empty or too large"

now="$(date -u +%s)"
rollback_until=$((now + 2 * GATE_TIMEOUT + 320))
valid_pair "$live_cert" "$live_key" "$rollback_until" >/dev/null 2>&1 ||
  fail "current chain expires before the rollback budget"
valid_pair "$candidate/server.crt" "$candidate/server.key" "$now" >/dev/null 2>&1 ||
  fail "candidate ceased to be valid before activation"
if [[ "$mode" == rotate ]]; then in_window || exit 0; fi
previous="$(initial_pair)" || fail "could not initialize the managed certificate paths"
printf '%s\n' "$previous" > "$draft/previous"
printf '%s\n' "${candidate##*/}" > "$draft/candidate"
printf '%s\n' "$(date -u +%F)" > "$STATE/last-attempt"
sync -f "$STATE"
mv -T -- "$draft" "$TXN"
sync -f "$STATE"

if switch_pair "${candidate##*/}" "$next_fingerprint" && verify_routes; then
  close_transaction "$previous" || fail "certificate changed but could not record completion"
  printf '%s\n' "FRP certificate and routes verified."
else
  if restore; then fail "new certificate or routes failed verification; previous certificate and routes restored"; fi
  fail "new certificate or routes failed verification; rollback could not be verified, transaction retained"
fi
