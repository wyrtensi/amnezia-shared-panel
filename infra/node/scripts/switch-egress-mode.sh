#!/bin/sh
# Atomically switch AWG3 egress mode between `masquerade` and `routed`.
#   - Uses a lightweight 256 MiB free-disk gate (all images are local).
#   - Writes a secret-free pre-switch snapshot (backups/egress-state-<ts>.json).
#   - Achieves 0ms drop whenever amnezia-awg3 is already attached to br-awg-egress
#     by toggling container MASQUERADE live alongside amnezia-egressd.
#   - Recreates only awg3 and checks cotenants.sh when migrating off the legacy network.
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

target_mode="${1:-}"
case "$target_mode" in
  masquerade|routed) ;;
  *) fail "usage: $0 masquerade|routed" ;;
esac

available_kb="$(df -Pk "$NODE_DIR" | awk 'NR==2 { print $4 }')"
min_kb="${PREFLIGHT_DISK_MIN_KB:-262144}"
[ "$available_kb" -ge "$min_kb" ] || \
  fail "at least $(( min_kb / 1024 )) MiB of free disk is required to switch egress mode (have $(( available_kb / 1024 )) MiB)"

acquire_lock
ensure_layout

previous_mode="$(env_value AWG3_EGRESS_MODE)"
case "$previous_mode" in
  masquerade|routed) ;;
  *) previous_mode="masquerade" ;;
esac

ts="$(date -u '+%Y%m%dT%H%M%SZ')"
snapshot_file="$BACKUP_DIR/egress-state-$ts.json"
[ ! -e "$snapshot_file" ] || snapshot_file="$BACKUP_DIR/egress-state-$ts-$$.json"
if [ -f "$EGRESS_STATE_FILE" ] && [ ! -L "$EGRESS_STATE_FILE" ]; then
  cp "$EGRESS_STATE_FILE" "$snapshot_file"
  chmod 600 "$snapshot_file"
else
  printf '{"schemaVersion":1,"previousMode":"%s","exits":[],"peers":[]}\n' "$previous_mode" >"$snapshot_file"
  chmod 600 "$snapshot_file"
fi

cotenants_snap="${TMPDIR:-/tmp}/amnezia-switch-cotenants.$$"
# shellcheck disable=SC2317
cleanup_switch() {
  rm -f "$cotenants_snap"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_switch EXIT INT TERM

if [ -f "$SCRIPT_DIR/cotenants.sh" ]; then
  sh "$SCRIPT_DIR/cotenants.sh" snapshot "$cotenants_snap"
fi

awg3_on_bridge=0
if container_is_running amnezia-awg3; then
  if docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' amnezia-awg3 2>/dev/null | grep -q 'awg_egress$'; then
    awg3_on_bridge=1
  fi
fi

revert_on_error() {
  reason="$1"
  set_env_value AWG3_EGRESS_MODE "$previous_mode" || true
  if [ "$previous_mode" = "routed" ]; then
    amnezia-egressd reconcile --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" >/dev/null 2>&1 || true
  else
    amnezia-egressd teardown --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" >/dev/null 2>&1 || true
  fi
  if [ "$awg3_on_bridge" -eq 0 ]; then
    compose up --detach --no-deps --no-build awg3 >/dev/null 2>&1 || true
  elif container_is_running amnezia-awg3 && [ "$previous_mode" = "masquerade" ]; then
    docker exec amnezia-awg3 /bin/sh -ec 'iptables -t nat -C POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE' >/dev/null 2>&1 || true
  fi
  fail "$reason"
}

if ! set_env_value AWG3_EGRESS_MODE "$target_mode"; then
  fail "failed to write AWG3_EGRESS_MODE=$target_mode to $ENV_FILE"
fi

if [ "$awg3_on_bridge" -eq 1 ]; then
  # 0ms live transition: container stays up on br-awg-egress while rules flip safely.
  if [ "$target_mode" = "routed" ]; then
    if ! amnezia-egressd reconcile --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE"; then
      revert_on_error "amnezia-egressd reconcile failed before removing container MASQUERADE"
    fi
    if ! docker exec amnezia-awg3 /bin/sh -ec 'while iptables -t nat -D POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE 2>/dev/null; do :; done'; then
      revert_on_error "failed to remove live container MASQUERADE rule in amnezia-awg3"
    fi
  else
    if ! docker exec amnezia-awg3 /bin/sh -ec 'iptables -t nat -C POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE'; then
      revert_on_error "failed to restore live container MASQUERADE rule in amnezia-awg3"
    fi
    if command -v amnezia-egressd >/dev/null 2>&1; then
      amnezia-egressd teardown --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" || \
        revert_on_error "amnezia-egressd teardown failed"
    fi
  fi
else
  # Legacy node migration: recreate only awg3 so it attaches to br-awg-egress.
  if [ "$target_mode" = "routed" ]; then
    if ! amnezia-egressd reconcile --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE"; then
      revert_on_error "amnezia-egressd pre-reconcile failed before migrating awg3 onto br-awg-egress"
    fi
  fi
  if ! compose up --detach --no-deps --no-build awg3; then
    revert_on_error "failed to recreate awg3 on br-awg-egress"
  fi
  if ! wait_healthy amnezia-awg3; then
    revert_on_error "amnezia-awg3 failed its health gate after switching to $target_mode"
  fi
  if [ "$target_mode" = "routed" ]; then
    amnezia-egressd reconcile --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" || \
      revert_on_error "amnezia-egressd reconcile failed after migrating awg3"
  elif command -v amnezia-egressd >/dev/null 2>&1; then
    amnezia-egressd teardown --node-dir "$NODE_DIR" --state "$EGRESS_STATE_FILE" || \
      revert_on_error "amnezia-egressd teardown failed"
  fi
fi

if [ -f "$cotenants_snap" ] && [ -f "$SCRIPT_DIR/cotenants.sh" ]; then
  if ! sh "$SCRIPT_DIR/cotenants.sh" verify "$cotenants_snap"; then
    revert_on_error "switching egress mode disturbed another tenant on this host"
  fi
fi

if command -v conntrack >/dev/null 2>&1; then
  conntrack -D -s 10.90.0.0/22 >/dev/null 2>&1 || true
fi

prune_node_backups
release_lock
info "Egress mode switched to $target_mode (snapshot: $snapshot_file)."
