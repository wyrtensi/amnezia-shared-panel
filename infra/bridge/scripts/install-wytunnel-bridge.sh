#!/usr/bin/env bash
# Idempotent WyTunnel client (FakeTCP bridge-side) installer and route manager.
#
# Installs /usr/local/bin/wytunnel_client (from a verified wyrtensi/wytunnel
# release or --binary-dir), manages comment-tagged iptables rules via
# /usr/local/libexec/amnezia-wytunnel-fw.sh (zero conflict with ufw/Docker),
# writes /etc/amnezia-bridge/wytunnel/<route-id>.env and
# amnezia-wytunnel-client@<route-id>.service, and exposes read-only JSON status
# on /run/amnezia-wytunnel/client-<route-id>.sock for amnezia-bridge-agent.
#
# Optional --disable-frps stops and disables amnezia-frps.service so inactive
# FRP consumes zero RAM/CPU on WyTunnel-only bridges.

set -euo pipefail

WYTUNNEL_REPO="${WYTUNNEL_REPO:-wyrtensi/wytunnel}"
WYTUNNEL_VERSION="${WYTUNNEL_VERSION:-v0.1.0}"
WYTUNNEL_SHA256="${WYTUNNEL_SHA256:-}"
WYTUNNEL_BIN="${WYTUNNEL_BIN:-/usr/local/bin/wytunnel_client}"
ETC_DIR="${WYTUNNEL_ETC_DIR:-/etc/amnezia-bridge/wytunnel}"
RUN_DIR="${WYTUNNEL_RUN_DIR:-/run/amnezia-wytunnel}"
FW_HELPER="${WYTUNNEL_FW_HELPER:-/usr/local/libexec/amnezia-wytunnel-fw.sh}"
SYSTEMD_DIR="${WYTUNNEL_SYSTEMD_DIR:-/etc/systemd/system}"

ROUTE_ID=""
NODE_IP=""
REMOTE_PORT=""
TRANSPORT_PORT=""
UDP_POOL_START=41000
POOL_SIZE=10
POOL_ROTATE_INTERVAL=2700
POOL_ROTATE_DRAIN=5
KEEPALIVE_SEC=25
FEC_SPEC="off"
HANDSHAKE_MODE="none"
EBPF_ENABLED="true"
WAN_IF=""
BINARY_DIR=""
DRY_RUN=0
REMOVE=0
DISABLE_FRPS=0

usage() {
  cat <<'EOF'
Usage: install-wytunnel-bridge.sh --route-id <uuid> [options]

Required (install/update):
  --route-id <uuid>               Route UUID
  --node-ip <ipv4>                Target VPN node primary IPv4
  --remote-port <port>            Public bridge UDP port (e.g. 41004)
  --transport-port <port>         Node FakeTCP port (default: 14100 + slot)

Options:
  --udp-pool-start <port>         Bridge UDP pool start (default: 41000)
  --pool-size <0..64>             Persistent FakeTCP tunnel count (default: 10; 0 = direct)
  --pool-rotate-interval <sec>    Seamless rotation interval (default: 2700; 0 = off)
  --pool-rotate-drain <sec>       Drain window before closing rotated tunnel (default: 5)
  --keepalive <sec>               Keepalive time in seconds (default: 25; 0 = off)
  --fec <K:M|off>                 Optional Reed-Solomon FEC (default: off)
  --handshake-mode <mode>         none | tls_client_hello (default: none)
  --no-ebpf                       Disable eBPF NIC offload in direct mode
  --wan-if <iface>                Override detected outbound WAN interface
  --version <tag>                 WyTunnel release tag (default: v0.1.0)
  --sha256 <hex>                  Expected SHA-256 of release tarball
  --binary-dir <dir>              Install wytunnel_client from local directory
  --disable-frps                  Stop & disable inactive amnezia-frps.service (0 RAM/CPU)
  --remove                        Stop, disable, and clean up this route
  --dry-run                       Print planned actions without mutating host
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --route-id) ROUTE_ID="${2:?}"; shift 2 ;;
    --node-ip) NODE_IP="${2:?}"; shift 2 ;;
    --remote-port) REMOTE_PORT="${2:?}"; shift 2 ;;
    --transport-port) TRANSPORT_PORT="${2:?}"; shift 2 ;;
    --udp-pool-start) UDP_POOL_START="${2:?}"; shift 2 ;;
    --pool-size) POOL_SIZE="${2:?}"; shift 2 ;;
    --pool-rotate-interval) POOL_ROTATE_INTERVAL="${2:?}"; shift 2 ;;
    --pool-rotate-drain) POOL_ROTATE_DRAIN="${2:?}"; shift 2 ;;
    --keepalive) KEEPALIVE_SEC="${2:?}"; shift 2 ;;
    --fec) FEC_SPEC="${2:?}"; shift 2 ;;
    --handshake-mode) HANDSHAKE_MODE="${2:?}"; shift 2 ;;
    --no-ebpf) EBPF_ENABLED="false"; shift ;;
    --wan-if) WAN_IF="${2:?}"; shift 2 ;;
    --version) WYTUNNEL_VERSION="${2:?}"; shift 2 ;;
    --sha256) WYTUNNEL_SHA256="${2:?}"; shift 2 ;;
    --binary-dir) BINARY_DIR="${2:?}"; shift 2 ;;
    --disable-frps) DISABLE_FRPS=1; shift ;;
    --remove) REMOVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
IPV4_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}$'

if [[ ! "$ROUTE_ID" =~ $UUID_RE ]]; then
  echo "Error: --route-id must be a lowercase UUID" >&2
  exit 2
fi

if [ "$REMOVE" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] systemctl disable --now amnezia-wytunnel-client@${ROUTE_ID}.service"
    echo "[dry-run] rm -f ${ETC_DIR}/${ROUTE_ID}.env ${RUN_DIR}/client-${ROUTE_ID}.sock ${RUN_DIR}/client-${ROUTE_ID}.meta.json"
    exit 0
  fi
  systemctl disable --now "amnezia-wytunnel-client@${ROUTE_ID}.service" 2>/dev/null || true
  rm -f "${ETC_DIR}/${ROUTE_ID}.env" "${RUN_DIR}/client-${ROUTE_ID}.sock" "${RUN_DIR}/client-${ROUTE_ID}.meta.json"
  echo "Removed WyTunnel bridge route ${ROUTE_ID}."
  exit 0
fi

if [[ ! "$NODE_IP" =~ $IPV4_RE ]]; then
  echo "Error: --node-ip must be an IPv4 address" >&2
  exit 2
fi
if ! [[ "$REMOTE_PORT" =~ ^[0-9]+$ ]] || [ "$REMOTE_PORT" -lt 1 ] || [ "$REMOTE_PORT" -gt 65535 ]; then
  echo "Error: --remote-port must be 1..65535" >&2
  exit 2
fi
if ! [[ "$POOL_SIZE" =~ ^[0-9]+$ ]] || [ "$POOL_SIZE" -gt 64 ]; then
  echo "Error: --pool-size must be 0..64" >&2
  exit 2
fi

SLOT=$(( REMOTE_PORT - UDP_POOL_START ))
if [ "$SLOT" -lt 0 ] || [ "$SLOT" -gt 250 ]; then
  SLOT=$(( REMOTE_PORT % 250 ))
fi
if [ -z "$TRANSPORT_PORT" ]; then
  TRANSPORT_PORT=$(( 14100 + SLOT ))
fi

TUN_NAME="ptc-${SLOT}"
TUN_LOCAL="10.250.${SLOT}.1"
TUN_PEER="10.250.${SLOT}.2"

if [ -z "$WAN_IF" ]; then
  WAN_IF=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}' || true)
  WAN_IF="${WAN_IF:-eth0}"
fi

EXTRA_ARGS=""
if [ "$POOL_SIZE" -gt 0 ]; then
  EXTRA_ARGS="--pool-size ${POOL_SIZE} --pool-rotate-interval ${POOL_ROTATE_INTERVAL} --pool-rotate-drain ${POOL_ROTATE_DRAIN}"
fi
if [ "$KEEPALIVE_SEC" -gt 0 ]; then
  EXTRA_ARGS="${EXTRA_ARGS} --keepalive-time ${KEEPALIVE_SEC} --keepalive-interval 5 --keepalive-retries 3"
else
  EXTRA_ARGS="${EXTRA_ARGS} --keepalive-time 0"
fi
if [ "$FEC_SPEC" != "off" ] && [ -n "$FEC_SPEC" ]; then
  EXTRA_ARGS="${EXTRA_ARGS} --fec ${FEC_SPEC}"
fi
if [ "$EBPF_ENABLED" = "false" ]; then
  EXTRA_ARGS="${EXTRA_ARGS} --no-ebpf"
fi
if [ "$HANDSHAKE_MODE" = "tls_client_hello" ]; then
  # Synthetic compact TLS 1.3-style ClientHello banner (Base64); filtered on server.
  EXTRA_ARGS="${EXTRA_ARGS} --handshake-packet-data FgMBAAUAAAAAAQ== --filter-handshake"
fi
EXTRA_ARGS="${EXTRA_ARGS# }"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
[dry-run] WyTunnel bridge install plan
  route_id        = ${ROUTE_ID}
  listen_udp      = 0.0.0.0:${REMOTE_PORT}
  target_faketcp  = ${NODE_IP}:${TRANSPORT_PORT}
  tun             = ${TUN_NAME} (${TUN_LOCAL} <-> ${TUN_PEER})
  wan_if          = ${WAN_IF}
  pool_size       = ${POOL_SIZE}
  rotate_interval = ${POOL_ROTATE_INTERVAL}s (drain ${POOL_ROTATE_DRAIN}s)
  keepalive       = ${KEEPALIVE_SEC}s
  fec             = ${FEC_SPEC}
  handshake_mode  = ${HANDSHAKE_MODE}
  ebpf            = ${EBPF_ENABLED}
  extra_args      = ${EXTRA_ARGS}
  metrics_socket  = ${RUN_DIR}/client-${ROUTE_ID}.sock
  disable_frps    = ${DISABLE_FRPS}
EOF
  exit 0
fi

install_binary() {
  if [ -n "$BINARY_DIR" ]; then
    install -m 0755 "${BINARY_DIR}/wytunnel_client" "$WYTUNNEL_BIN"
    return
  fi
  if [ -x "$WYTUNNEL_BIN" ]; then
    return
  fi
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  local tarball="wytunnel-linux-${arch}-musl.tar.gz"
  local url="https://github.com/${WYTUNNEL_REPO}/releases/download/${WYTUNNEL_VERSION}/${tarball}"
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$url" -o "${tmp}/${tarball}"
  if [ -n "$WYTUNNEL_SHA256" ]; then
    echo "${WYTUNNEL_SHA256}  ${tmp}/${tarball}" | sha256sum -c -
  fi
  tar -xzf "${tmp}/${tarball}" -C "$tmp" wytunnel_client
  install -m 0755 "${tmp}/wytunnel_client" "$WYTUNNEL_BIN"
}

install_binary

mkdir -p "$ETC_DIR" "$RUN_DIR" "$(dirname "$FW_HELPER")"
chmod 0755 "$RUN_DIR"

cat > "$FW_HELPER" <<'FWEOF'
#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:?up|down}"
ROLE="${2:?bridge|node}"
ROUTE_ID="${3:?}"
TUN_IF="${4:?}"
TUN_PEER="${5:?}"
PEER_IP="${6:?}"
TRANSPORT_PORT="${7:?}"
WAN_IF="${8:?}"
NODE_PRIMARY_IP="${9:-}"
COMMENT="amnezia-wt-${ROUTE_ID}"

del_rule() {
  local table="$1"; shift
  while iptables -t "$table" -D "$@" 2>/dev/null; do :; done
}

if [ "$ROLE" = "bridge" ]; then
  del_rule nat POSTROUTING -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -o "$WAN_IF" -j MASQUERADE -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  if [ "$ACTION" = "up" ]; then
    iptables -t nat -I POSTROUTING 1 -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -o "$WAN_IF" -j MASQUERADE -m comment --comment "$COMMENT"
    iptables -I FORWARD 1 -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
    iptables -I FORWARD 1 -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  fi
elif [ "$ROLE" = "node" ]; then
  del_rule nat PREROUTING -i "$WAN_IF" -s "${PEER_IP}/32" -d "${NODE_PRIMARY_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j DNAT --to-destination "${TUN_PEER}:${TRANSPORT_PORT}" -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  if [ "$ACTION" = "up" ]; then
    iptables -t nat -I PREROUTING 1 -i "$WAN_IF" -s "${PEER_IP}/32" -d "${NODE_PRIMARY_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j DNAT --to-destination "${TUN_PEER}:${TRANSPORT_PORT}" -m comment --comment "$COMMENT"
    iptables -I FORWARD 1 -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
    iptables -I FORWARD 1 -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  fi
fi
FWEOF
chmod 0755 "$FW_HELPER"

cat > "${SYSTEMD_DIR}/amnezia-wytunnel-client@.service" <<EOF
[Unit]
Description=Amnezia WyTunnel Bridge Client (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ETC_DIR}/%i.env
RuntimeDirectory=amnezia-wytunnel
RuntimeDirectoryPreserve=yes
ExecStartPre=${FW_HELPER} up bridge %i \${TUN_NAME} \${TUN_PEER} \${NODE_IP} \${TRANSPORT_PORT} \${WAN_IF}
ExecStartPre=/bin/sh -c 'printf "{\"remotePort\":%s,\"transportPort\":%s,\"startedAt\":\"%s\"}\n" "\${REMOTE_PORT}" "\${TRANSPORT_PORT}" "\$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)" > ${RUN_DIR}/client-%i.meta.json'
ExecStart=${WYTUNNEL_BIN} --local 0.0.0.0:\${REMOTE_PORT} --remote \${NODE_IP}:\${TRANSPORT_PORT} --tun \${TUN_NAME} --tun-local \${TUN_LOCAL} --tun-peer \${TUN_PEER} --ipv4-only --metrics-listen ${RUN_DIR}/client-%i.sock \${EXTRA_ARGS}
ExecStopPost=-${FW_HELPER} down bridge %i \${TUN_NAME} \${TUN_PEER} \${NODE_IP} \${TRANSPORT_PORT} \${WAN_IF}
ExecStopPost=-/bin/rm -f ${RUN_DIR}/client-%i.sock ${RUN_DIR}/client-%i.meta.json
Restart=always
RestartSec=2
LimitNOFILE=65536
MemoryMax=64M

[Install]
WantedBy=multi-user.target
EOF

cat > "${ETC_DIR}/${ROUTE_ID}.env" <<EOF
ROUTE_ID=${ROUTE_ID}
NODE_IP=${NODE_IP}
REMOTE_PORT=${REMOTE_PORT}
TRANSPORT_PORT=${TRANSPORT_PORT}
TUN_NAME=${TUN_NAME}
TUN_LOCAL=${TUN_LOCAL}
TUN_PEER=${TUN_PEER}
WAN_IF=${WAN_IF}
EXTRA_ARGS=${EXTRA_ARGS}
EOF
chmod 0640 "${ETC_DIR}/${ROUTE_ID}.env"

systemctl daemon-reload
systemctl enable --now "amnezia-wytunnel-client@${ROUTE_ID}.service"
systemctl restart "amnezia-wytunnel-client@${ROUTE_ID}.service"

if [ "$DISABLE_FRPS" -eq 1 ]; then
  systemctl disable --now amnezia-frps.service 2>/dev/null || true
  if [ -f /etc/amnezia-bridge/agent/agent.env ]; then
    if grep -q '^BRIDGE_FRPS_ENABLED=' /etc/amnezia-bridge/agent/agent.env; then
      sed -i 's/^BRIDGE_FRPS_ENABLED=.*/BRIDGE_FRPS_ENABLED=false/' /etc/amnezia-bridge/agent/agent.env
    else
      echo "BRIDGE_FRPS_ENABLED=false" >> /etc/amnezia-bridge/agent/agent.env
    fi
  fi
  echo "Stopped and disabled amnezia-frps.service (0 RAM/CPU)."
fi

echo "WyTunnel bridge route ${ROUTE_ID} active on 0.0.0.0:${REMOTE_PORT}/udp -> ${NODE_IP}:${TRANSPORT_PORT}/tcp (pool=${POOL_SIZE})."
