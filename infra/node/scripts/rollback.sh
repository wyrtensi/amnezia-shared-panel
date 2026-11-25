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
# Rollback pulls zero images; allow tight-disk recovery down to 256 MiB while keeping RAM/key/JSON checks.
PREFLIGHT_DISK_MIN_KB=262144 sh "$SCRIPT_DIR/preflight.sh"
acquire_lock
ensure_layout

temporary="$(mktemp -d "$NODE_DIR/.rollback.XXXXXX")"
# This function is invoked through the EXIT/INT/TERM trap.
# shellcheck disable=SC2317,SC2329
cleanup() {
  rm -rf "$temporary"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

tar -xzf "$archive" -C "$temporary" --no-same-owner --no-same-permissions
restored_state="$temporary/state/amnezia-awg2"
restored_state_awg3="$temporary/state/amnezia-awg3"
restored_egress_state="$temporary/egress/state.json"
restored_egress_meta="$temporary/egress/meta.env"

has_awg2=0
has_awg3=0
[ -d "$restored_state" ] && [ -s "$restored_state/awg0.conf" ] && has_awg2=1
[ -d "$restored_state_awg3" ] && [ -s "$restored_state_awg3/awg0.conf" ] && has_awg3=1

if [ "$has_awg2" -eq 0 ] && [ "$has_awg3" -eq 0 ]; then
  fail "backup contains neither AWG2 nor AWG3 state"
fi

for required_file in \
  awg0.conf \
  clientsTable \
  wireguard_server_private_key.key \
  wireguard_server_public_key.key \
  wireguard_psk.key; do
  if [ "$has_awg2" -eq 1 ]; then
    [ -s "$restored_state/$required_file" ] || fail "backup is missing required AWG2 state: $required_file"
    [ ! -L "$restored_state/$required_file" ] || fail "backup AWG2 state contains a symlink"
  fi
  if [ "$has_awg3" -eq 1 ]; then
    [ -s "$restored_state_awg3/$required_file" ] || fail "backup is missing required AWG3 state: $required_file"
    [ ! -L "$restored_state_awg3/$required_file" ] || fail "backup AWG3 state contains a symlink"
  fi
done

if [ "$has_awg2" -eq 1 ]; then
  grep -Eq '^Address[[:space:]]*=[[:space:]]*10\.89\.0\.1/22[[:space:]]*$' "$restored_state/awg0.conf" || \
    fail "backup does not use 10.89.0.0/22"
  grep -Eq '^ListenPort[[:space:]]*=[[:space:]]*51889[[:space:]]*$' "$restored_state/awg0.conf" || \
    fail "backup does not use UDP 51889"
fi

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

[ "$has_awg2" -eq 0 ] || verify_state_keys "$AWG2_IMAGE" "$restored_state"
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
[ "$has_awg2" -eq 0 ] || validate_clients_table "$restored_state"
[ "$has_awg3" -eq 0 ] || validate_clients_table "$restored_state_awg3"

restored_mode=""
if [ -e "$restored_egress_meta" ]; then
  [ -f "$restored_egress_meta" ] && [ ! -L "$restored_egress_meta" ] || \
    fail "backup egress/meta.env must be a regular file"
  restored_mode="$(sed -n 's/^AWG3_EGRESS_MODE=//p' "$restored_egress_meta" | head -n 1)"
  case "$restored_mode" in
    masquerade|routed) ;;
    *) fail "backup egress/meta.env has invalid AWG3_EGRESS_MODE" ;;
  esac
fi

if [ -e "$restored_egress_state" ]; then
  [ -f "$restored_egress_state" ] && [ ! -L "$restored_egress_state" ] || \
    fail "backup egress/state.json must be a regular file"
  egress_size="$(wc -c <"$restored_egress_state" | tr -d ' ')"
  [ "$egress_size" -le 2097152 ] || fail "backup egress/state.json exceeds 2 MiB"
  docker run --rm --platform linux/amd64 \
    --user 0:0 \
    --volume "$temporary/egress:/egress:ro" \
    --entrypoint node \
    "$node_image" \
    -e "JSON.parse(require('fs').readFileSync('/egress/state.json','utf8'))"
fi

safety_backup=''
if [ -s "$STATE_DIR/awg0.conf" ] || [ -s "$STATE_DIR_AWG3/awg0.conf" ]; then
  safety_backup="$(create_backup 0)" || fail "could not create pre-rollback safety backup"
  info "Pre-rollback safety backup created: $safety_backup"
else
  compose stop --timeout 30 node-agent awg2 awg3 >/dev/null 2>&1 || true
fi

previous_env="$temporary/previous.env"
cp -p "$ENV_FILE" "$previous_env"
previous_egress_state="$temporary/previous-egress-state.json"
if [ -f "$EGRESS_STATE_FILE" ] && [ ! -L "$EGRESS_STATE_FILE" ]; then
  cp -p "$EGRESS_STATE_FILE" "$previous_egress_state"
fi

if [ "$has_awg2" -eq 1 ]; then
  find "$restored_state" -type d -exec chmod 700 {} +
  find "$restored_state" -type f -exec chmod 600 {} +
fi
if [ "$has_awg3" -eq 1 ]; then
  find "$restored_state_awg3" -type d -exec chmod 700 {} +
  find "$restored_state_awg3" -type f -exec chmod 600 {} +
fi

previous_state="$temporary/previous-amnezia-awg2"
previous_state_awg3="$temporary/previous-amnezia-awg3"
if [ "$has_awg2" -eq 1 ]; then
  [ -d "$STATE_DIR" ] && mv "$STATE_DIR" "$previous_state"
  mv "$restored_state" "$STATE_DIR"
fi
if [ "$has_awg3" -eq 1 ]; then
  [ -d "$STATE_DIR_AWG3" ] && mv "$STATE_DIR_AWG3" "$previous_state_awg3"
  mv "$restored_state_awg3" "$STATE_DIR_AWG3"
fi

if [ -n "$restored_mode" ]; then
  set_env_value AWG3_EGRESS_MODE "$restored_mode"
fi
if [ -f "$restored_egress_state" ]; then
  egress_dir="$(dirname -- "$EGRESS_STATE_FILE")"
  mkdir -p "$egress_dir"
  chmod 700 "$egress_dir"
  cp "$restored_egress_state" "$EGRESS_STATE_FILE"
  chmod 600 "$EGRESS_STATE_FILE"
fi

sync_host_egress_after_restore() {
  mode="${1:-masquerade}"
  if ! command -v amnezia-egressd >/dev/null 2>&1; then
    return 0
  fi
  if [ "$mode" = "routed" ]; then
    amnezia-egressd reconcile --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" >/dev/null 2>&1 || true
    if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled amnezia-egressd.service >/dev/null 2>&1; then
      systemctl restart amnezia-egressd.service >/dev/null 2>&1 || true
    fi
  else
    amnezia-egressd teardown --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" >/dev/null 2>&1 || true
  fi
  if command -v conntrack >/dev/null 2>&1; then
    conntrack -D -s 10.90.0.0/22 >/dev/null 2>&1 || true
  fi
}

effective_mode="$(env_value AWG3_EGRESS_MODE)"
case "$effective_mode" in
  masquerade|routed) ;;
  *) effective_mode="masquerade" ;;
esac
sync_host_egress_after_restore "$effective_mode"

rollback_healthy=0
if compose up --detach --no-build && \
   { ! awg2_enabled || [ "$has_awg2" -eq 0 ] || wait_healthy amnezia-awg2; } && \
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
if [ "$has_awg2" -eq 1 ]; then
  failed_state="$temporary/failed-restored-state"
  [ -d "$STATE_DIR" ] && mv "$STATE_DIR" "$failed_state"
  [ -d "$previous_state" ] && mv "$previous_state" "$STATE_DIR"
fi
if [ "$has_awg3" -eq 1 ]; then
  failed_state_awg3="$temporary/failed-restored-state-awg3"
  [ -d "$STATE_DIR_AWG3" ] && mv "$STATE_DIR_AWG3" "$failed_state_awg3"
  [ -d "$previous_state_awg3" ] && mv "$previous_state_awg3" "$STATE_DIR_AWG3"
fi
cp -pf "$previous_env" "$ENV_FILE"
chmod 600 "$ENV_FILE"
if [ -f "$previous_egress_state" ]; then
  cp -pf "$previous_egress_state" "$EGRESS_STATE_FILE"
  chmod 600 "$EGRESS_STATE_FILE"
fi
prev_mode="$(env_value AWG3_EGRESS_MODE)"
sync_host_egress_after_restore "${prev_mode:-masquerade}"

if [ -d "$STATE_DIR" ] || [ -d "$STATE_DIR_AWG3" ]; then
  compose up --detach --no-build >/dev/null 2>&1 || true
fi
fail "rollback health gate failed; the pre-rollback state was restored"
