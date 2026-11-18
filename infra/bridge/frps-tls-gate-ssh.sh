#!/bin/sh
# The bridge key can invoke only the forced-command gate on the verifier host.
set -eu

invalid() {
  printf 'FRP TLS verification SSH: %s\n' "$*" >&2
  exit 2
}

case "$#:${1:-}" in
  1:baseline) ;;
  2:verify)
    case "$2" in *[!0123456789TZ.:-]*) invalid 'invalid UTC verification timestamp' ;; esac
    printf '%s\n' "$2" | LC_ALL=C grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' ||
      invalid 'invalid UTC verification timestamp'
    ;;
  *) invalid 'expected baseline or verify with a UTC timestamp' ;;
esac

remote="${BRIDGE_TLS_GATE_REMOTE:-}"
port="${BRIDGE_TLS_GATE_PORT:-22}"
identity="${BRIDGE_TLS_GATE_IDENTITY:-/etc/amnezia-bridge/frp-verify/id_ed25519}"
known_hosts="${BRIDGE_TLS_GATE_KNOWN_HOSTS:-/etc/amnezia-bridge/frp-verify/known_hosts}"

case "$remote" in
  ''|-*|*[[:space:]]*) invalid 'BRIDGE_TLS_GATE_REMOTE must be an SSH user and host' ;;
esac
case "$remote" in ?*@?*) ;; *) invalid 'BRIDGE_TLS_GATE_REMOTE must include the SSH user' ;; esac
case "$port" in ''|*[!0-9]*) invalid 'invalid SSH port' ;; esac
[ "${#port}" -le 5 ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || invalid 'invalid SSH port'
for file in "$identity" "$known_hosts"; do
  case "$file" in
    /*[[:space:]]*|*'"'*) invalid 'SSH file paths cannot contain whitespace or quotes' ;;
    /*) ;;
    *) invalid 'SSH file paths must be absolute' ;;
  esac
  [ -f "$file" ] && [ -r "$file" ] || invalid 'SSH identity and pinned known_hosts must be readable files'
done

exec ssh -F /dev/null -T -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o GlobalKnownHostsFile=/dev/null \
  -o "UserKnownHostsFile=$known_hosts" -o ClearAllForwardings=yes -o ForwardAgent=no \
  -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  -i "$identity" -p "$port" "$remote" "$@"
