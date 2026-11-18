#!/bin/sh
# Run on the trusted CLI host as an OpenSSH forced command for one bridge.
set -eu

if [ "$#" -ne 1 ] || [ "${#1}" -ne 36 ] || ! printf '%s\n' "$1" | LC_ALL=C grep -Exq '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'; then
  echo 'The forced command requires a fixed bridge UUID' >&2
  exit 2
fi
bridge_id=$1

case "${SSH_ORIGINAL_COMMAND-}" in
  baseline)
    exec amnezia-panel bridge-tls-gate "$bridge_id" baseline </dev/null
    ;;
  'verify '*)
    since=${SSH_ORIGINAL_COMMAND#verify }
    case "$since" in
      ''|*[!0123456789TZ.:-]*) echo 'Invalid verification timestamp' >&2; exit 2 ;;
    esac
    if ! printf '%s\n' "$since" | LC_ALL=C grep -Exq '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z'; then
      echo 'Invalid verification timestamp' >&2
      exit 2
    fi
    exec amnezia-panel bridge-tls-gate "$bridge_id" verify "$since"
    ;;
  *)
    echo 'Unknown forced command' >&2
    exit 2
    ;;
esac
