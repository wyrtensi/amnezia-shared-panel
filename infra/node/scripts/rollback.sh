#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" -eq 1 ] || fail "usage: $0 /absolute/path/to/amnezia-node-*.tar.gz"
archive="$1"
case "$archive" in
  /*) ;;
  *) archive="$(CDPATH='' cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")" ;;
esac

validate_backup_archive "$archive"
sh "$SCRIPT_DIR/preflight.sh"
acquire_lock
ensure_layout

temporary="$(mktemp -d "$NODE_DIR/.rollback.XXXXXX")"
# This function is invoked through the EXIT/INT/TERM trap.
# shellcheck disable=SC2317
cleanup() {
  rm -rf "$temporary"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

tar -xzf "$archive" -C "$temporary" --no-same-owner --no-same-permissions
restored_state="$temporary/state/amnezia-awg2"
restored_state_awg3="$temporary/state/amnezia-awg3"

# AWG3 state is only present in backups taken after the AWG3 rollout
has_awg3=0
[ -d "$restored_state_awg3" ] && has_awg3=1

for required_file in \
  awg0.conf \
  clientsTable \
  wireguard_server_private_key.key \
  wireguard_server_public_key.key \
  wireguard_psk.key; do
  [ -s "$restored_state/$required_file" ] || fail "backup is missing required state: $required_file"
  [ ! -L "$restored_state/$required_file" ] || fail "backup state contains a symlink"
  if [ "$has_awg3" -eq 1 ]; then
    [ -s "$restored_state_awg3/$required_file" ] || fail "backup is missing required AWG3 state: $required_file"
    [ ! -L "$restored_state_awg3/$required_file" ] || fail "backup AWG3 state contains a symlink"
  fi
done

grep -Eq '^Address[[:space:]]*=[[:space:]]*10\.89\.0\.1/22[[:space:]]*$' "$restored_state/awg0.conf" || \
  fail "backup does not use 10.89.0.0/22"
grep -Eq '^ListenPort[[:space:]]*=[[:space:]]*51889[[:space:]]*$' "$restored_state/awg0.conf" || \
  fail "backup does not use UDP 51889"

if [ "$has_awg3" -eq 1 ]; then
  grep -Eq '^Address[[:space:]]*=[[:space:]]*10\.90\.0\.1/22[[:space:]]*$' "$restored_state_awg3/awg0.conf" || \
    fail "AWG3 backup does not use 10.90.0.0/22"
  grep -Eq '^ListenPort[[:space:]]*=[[:space:]]*51890[[:space:]]*$' "$restored_state_awg3/awg0.conf" || \
    fail "AWG3 backup does not use UDP 51890"
  grep -Eq '^HeaderProtectionKey[[:space:]]*=[[:space:]]*.+$' "$restored_state_awg3/awg0.conf" || \
    fail "AWG3 backup does not define HeaderProtectionKey"
fi

verify_state_keys() {
  image="$1"
  state="$2"
  docker run --rm --platform linux/amd64 \
    --volume "$state:/opt/amnezia/awg:ro" \
    --entrypoint /bin/sh \
    "$image" \
    -ec '
      private_key="$(cat /opt/amnezia/awg/wireguard_server_private_key.key)"
      public_key="$(cat /opt/amnezia/awg/wireguard_server_public_key.key)"
      psk="$(cat /opt/amnezia/awg/wireguard_psk.key)"
      config_private="$(sed -n "s/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p" /opt/amnezia/awg/awg0.conf | head -n 1)"
      [ "$private_key" = "$config_private" ]
      [ "$(printf "%s" "$private_key" | awg pubkey)" = "$public_key" ]
      printf "%s" "$psk" | awg pubkey >/dev/null
      awg-quick strip /opt/amnezia/awg/awg0.conf >/dev/null
    '
}

verify_state_keys "$AWG2_IMAGE" "$restored_state"
[ "$has_awg3" -eq 0 ] || verify_state_keys "$AWG3_IMAGE" "$restored_state_awg3"

node_image="$(env_value NODE_AGENT_IMAGE)"
validate_clients_table() {
  docker run --rm --platform linux/amd64 \
    --user 0:0 \
    --volume "$1:/state:ro" \
    --entrypoint node \
    "$node_image" \
    -e "JSON.parse(require('fs').readFileSync('/state/clientsTable','utf8'))"
}
validate_clients_table "$restored_state"
[ "$has_awg3" -eq 0 ] || validate_clients_table "$restored_state_awg3"

safety_backup=''
if [ -s "$STATE_DIR/awg0.conf" ]; then
  safety_backup="$(create_backup 0)" || fail "could not create pre-rollback safety backup"
  info "Pre-rollback safety backup created: $safety_backup"
else
  compose stop --timeout 30 node-agent awg2 awg3 >/dev/null 2>&1 || true
fi

find "$restored_state" -type d -exec chmod 700 {} +
find "$restored_state" -type f -exec chmod 600 {} +
if [ "$has_awg3" -eq 1 ]; then
  find "$restored_state_awg3" -type d -exec chmod 700 {} +
  find "$restored_state_awg3" -type f -exec chmod 600 {} +
fi

previous_state="$temporary/previous-amnezia-awg2"
previous_state_awg3="$temporary/previous-amnezia-awg3"
if [ -d "$STATE_DIR" ]; then
  mv "$STATE_DIR" "$previous_state"
fi
mv "$restored_state" "$STATE_DIR"
if [ "$has_awg3" -eq 1 ]; then
  if [ -d "$STATE_DIR_AWG3" ]; then
    mv "$STATE_DIR_AWG3" "$previous_state_awg3"
  fi
  mv "$restored_state_awg3" "$STATE_DIR_AWG3"
fi

rollback_healthy=0
if compose up --detach --no-build && \
   wait_healthy amnezia-awg2 && \
   { [ "$has_awg3" -eq 0 ] || wait_healthy amnezia-awg3; } && \
   wait_healthy amnezia-node-agent; then
  agent_binding="$(docker port amnezia-node-agent 4001/tcp)"
  [ "$agent_binding" = "127.0.0.1:4001" ] && rollback_healthy=1
fi

if [ "$rollback_healthy" -eq 1 ]; then
  info "Rollback completed and all health gates passed."
  exit 0
fi

compose stop --timeout 30 node-agent awg2 awg3 >/dev/null 2>&1 || true
failed_state="$temporary/failed-restored-state"
mv "$STATE_DIR" "$failed_state"
if [ -d "$previous_state" ]; then
  mv "$previous_state" "$STATE_DIR"
fi
if [ "$has_awg3" -eq 1 ]; then
  failed_state_awg3="$temporary/failed-restored-state-awg3"
  [ -d "$STATE_DIR_AWG3" ] && mv "$STATE_DIR_AWG3" "$failed_state_awg3"
  if [ -d "$previous_state_awg3" ]; then
    mv "$previous_state_awg3" "$STATE_DIR_AWG3"
  fi
fi
if [ -d "$STATE_DIR" ]; then
  compose up --detach --no-build >/dev/null 2>&1 || true
fi
fail "rollback health gate failed; the pre-rollback state was restored"
