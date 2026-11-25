#!/bin/sh
# Idempotent setup of all host-side systemd services and kernel tuning for a node:
#   1. amnezia-egressd (host multi-exit SNAT / fail-closed nftables)
#   2. amnezia-node-capacity.path (in-panel SERVER_MAX_PEERS changes)
#   3. amnezia-node-agent-update.path (when NODE_AGENT_UPDATE_REPO is configured)
#   4. BBR + fq + UDP/TCP buffer sysctl tuning
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

UPDATE_REPO="${NODE_AGENT_UPDATE_REPO:-$(env_value NODE_AGENT_UPDATE_REPO)}"
SKIP_TUNING="${AMNEZIA_SKIP_NETWORK_TUNING:-0}"
ETC="${AMNEZIA_ETC:-/etc}"
SYSCTL_FILE="$ETC/sysctl.d/99-amnezia-network-tuning.conf"
BBR_MODULE_FILE="$ETC/modules-load.d/amnezia-bbr.conf"

[ "$(id -u)" -eq 0 ] || [ "${AMNEZIA_ALLOW_NONROOT:-0}" = "1" ] || fail "must run as root"

sh "$SCRIPT_DIR/install-egressd.sh"

if [ -f "$SCRIPT_DIR/install-capacity-applier.sh" ] && command -v bash >/dev/null 2>&1; then
  bash "$SCRIPT_DIR/install-capacity-applier.sh"
fi

if [ -n "$UPDATE_REPO" ] && [ -f "$SCRIPT_DIR/install-agent-updater.sh" ] && command -v bash >/dev/null 2>&1; then
  NODE_AGENT_UPDATE_REPO="$UPDATE_REPO" bash "$SCRIPT_DIR/install-agent-updater.sh"
fi

if [ "$SKIP_TUNING" != "1" ]; then
  mkdir -p "$(dirname -- "$SYSCTL_FILE")" "$(dirname -- "$BBR_MODULE_FILE")"
  printf 'tcp_bbr\n' >"$BBR_MODULE_FILE"
  chmod 0644 "$BBR_MODULE_FILE"
  cat >"$SYSCTL_FILE" <<'SYSCTL_EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 2097152
net.core.wmem_default = 2097152
net.ipv4.tcp_rmem = 4096 131072 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.core.netdev_max_backlog = 4096
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_no_metrics_save = 1
SYSCTL_EOF
  chmod 0644 "$SYSCTL_FILE"

  if [ "$ETC" = "/etc" ] && [ "$(id -u)" -eq 0 ]; then
    command -v modprobe >/dev/null 2>&1 && { modprobe tcp_bbr 2>/dev/null || true; }
    command -v sysctl >/dev/null 2>&1 && { sysctl -p "$SYSCTL_FILE" >/dev/null 2>&1 || true; }
    if command -v ip >/dev/null 2>&1 && command -v tc >/dev/null 2>&1; then
      default_nic="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
      [ -n "$default_nic" ] && { tc qdisc replace dev "$default_nic" root fq 2>/dev/null || true; }
    fi
  fi
fi

info "Host services installation complete."
