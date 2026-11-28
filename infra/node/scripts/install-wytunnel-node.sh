#!/usr/bin/env bash
# Idempotent WyTunnel server (FakeTCP node-side) installer and route manager.
#
# Installs /usr/local/bin/wytunnel_server, sets up strict bridge-only DNAT/FORWARD
# rules via /usr/local/libexec/amnezia-wytunnel-fw.sh (accepting FakeTCP ONLY
# from --bridge-ip, preserving dual-IP / Level B routing), writes
# amnezia-wytunnel-server@<route-id>.service, and by default STOPS & DISABLES
# any inactive amnezia-frpc@<route-id>.service so unused FRP consumes 0 RAM/CPU.

set -euo pipefail

WYTUNNEL_REPO="${WYTUNNEL_REPO:-wyrtensi/wytunnel}"
WYTUNNEL_VERSION="${WYTUNNEL_VERSION:-v0.1.0}"
WYTUNNEL_SHA256="${WYTUNNEL_SHA256:-}"
WYTUNNEL_BIN="${WYTUNNEL_BIN:-/usr/local/bin/wytunnel_server}"
ETC_DIR="${WYTUNNEL_ETC_DIR:-/etc/amnezia-node/wytunnel}"
RUN_DIR="${WYTUNNEL_RUN_DIR:-/run/amnezia-wytunnel}"
FW_HELPER="${WYTUNNEL_FW_HELPER:-/usr/local/libexec/amnezia-wytunnel-fw.sh}"
SYSTEMD_DIR="${WYTUNNEL_SYSTEMD_DIR:-/etc/systemd/system}"

ROUTE_ID=""
BRIDGE_IP=""
NODE_PRIMARY_IP=""
REMOTE_PORT=""
TRANSPORT_PORT=""
UDP_POOL_START=41000
LOCAL_IP="127.0.0.1"
LOCAL_UDP_PORT=51890
POOL_MODE=1
KEEPALIVE_SEC=25
FEC_SPEC="off"
HANDSHAKE_MODE="none"
EBPF_ENABLED="true"
WAN_IF=""
BINARY_DIR=""
DISABLE_FRPC=1
DRY_RUN=0
REMOVE=0

usage() {
  cat <<'EOF'
Usage: install-wytunnel-node.sh --route-id <uuid> [options]

Required (install/update):
  --route-id <uuid>           Route UUID
  --bridge-ip <ipv4>          Bridge public IPv4 (strictly allowlisted on FakeTCP port)
  --remote-port <port>        Bridge public UDP port (derives slot)

Options:
  --transport-port <port>     Node FakeTCP listening port (default: 14100 + slot)
  --node-primary-ip <ipv4>    Override detected node primary IPv4 for DNAT
  --udp-pool-start <port>     Bridge UDP pool start (default: 41000)
  --local-ip <ipv4>           Local AWG3 UDP target IP (default: 127.0.0.1)
  --local-udp-port <port>     Local AWG3 UDP target port (default: 51890)
  --pool-mode                 Run server in persistent pool multiplexing mode (default)
  --direct-mode               Run server in classic per-client mode (no pool mux)
  --keepalive <sec>           Keepalive seconds (default: 25; 0 = off)
  --fec <K:M|off>             Optional Reed-Solomon FEC (default: off)
  --handshake-mode <mode>     none | tls_client_hello (default: none)
  --no-ebpf                   Disable eBPF NIC offload in direct mode
  --wan-if <iface>            Override detected WAN interface
  --keep-frpc                 Do not stop/disable amnezia-frpc@<route-id>.service
  --version <tag>             WyTunnel release tag (default: v0.1.0)
  --sha256 <hex>              Expected SHA-256 of release tarball
  --binary-dir <dir>          Install wytunnel_server from local directory
  --remove                    Stop, disable, and clean up this route
  --dry-run                   Print planned actions without mutating host
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --route-id) ROUTE_ID="${2:?}"; shift 2 ;;
    --bridge-ip) BRIDGE_IP="${2:?}"; shift 2 ;;
    --node-primary-ip) NODE_PRIMARY_IP="${2:?}"; shift 2 ;;
    --remote-port) REMOTE_PORT="${2:?}"; shift 2 ;;
    --transport-port) TRANSPORT_PORT="${2:?}"; shift 2 ;;
    --udp-pool-start) UDP_POOL_START="${2:?}"; shift 2 ;;
    --local-ip) LOCAL_IP="${2:?}"; shift 2 ;;
    --local-udp-port) LOCAL_UDP_PORT="${2:?}"; shift 2 ;;
    --pool-mode) POOL_MODE=1; shift ;;
    --direct-mode) POOL_MODE=0; shift ;;
    --keepalive) KEEPALIVE_SEC="${2:?}"; shift 2 ;;
    --fec) FEC_SPEC="${2:?}"; shift 2 ;;
    --handshake-mode) HANDSHAKE_MODE="${2:?}"; shift 2 ;;
    --no-ebpf) EBPF_ENABLED="false"; shift ;;
    --wan-if) WAN_IF="${2:?}"; shift 2 ;;
    --keep-frpc) DISABLE_FRPC=0; shift ;;
    --version) WYTUNNEL_VERSION="${2:?}"; shift 2 ;;
    --sha256) WYTUNNEL_SHA256="${2:?}"; shift 2 ;;
    --binary-dir) BINARY_DIR="${2:?}"; shift 2 ;;
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
    echo "[dry-run] systemctl disable --now amnezia-wytunnel-server@${ROUTE_ID}.service"
    echo "[dry-run] rm -f ${ETC_DIR}/${ROUTE_ID}.env ${RUN_DIR}/server-${ROUTE_ID}.sock"
    exit 0
  fi
  systemctl disable --now "amnezia-wytunnel-server@${ROUTE_ID}.service" 2>/dev/null || true
  rm -f "${ETC_DIR}/${ROUTE_ID}.env" "${RUN_DIR}/server-${ROUTE_ID}.sock"
  echo "Removed WyTunnel node route ${ROUTE_ID}."
  exit 0
fi

if [[ ! "$BRIDGE_IP" =~ $IPV4_RE ]]; then
  echo "Error: --bridge-ip must be an IPv4 address" >&2
  exit 2
fi
if ! [[ "$REMOTE_PORT" =~ ^[0-9]+$ ]] || [ "$REMOTE_PORT" -lt 1 ] || [ "$REMOTE_PORT" -gt 65535 ]; then
  echo "Error: --remote-port must be 1..65535" >&2
  exit 2
fi

SLOT=$(( REMOTE_PORT - UDP_POOL_START ))
if [ "$SLOT" -lt 0 ] || [ "$SLOT" -gt 250 ]; then
  SLOT=$(( REMOTE_PORT % 250 ))
fi
if [ -z "$TRANSPORT_PORT" ]; then
  TRANSPORT_PORT=$(( 14100 + SLOT ))
fi

TUN_NAME="pts-${SLOT}"
TUN_LOCAL="10.251.${SLOT}.1"
TUN_PEER="10.251.${SLOT}.2"

if [ -z "$WAN_IF" ]; then
  WAN_IF=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}' || true)
  WAN_IF="${WAN_IF:-eth0}"
fi
if [ -z "$NODE_PRIMARY_IP" ]; then
  NODE_PRIMARY_IP=$(ip -4 route get "$BRIDGE_IP" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)
  NODE_PRIMARY_IP="${NODE_PRIMARY_IP:-0.0.0.0}"
fi

EXTRA_ARGS=""
if [ "$POOL_MODE" -eq 1 ]; then
  EXTRA_ARGS="--pool-mode"
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
  EXTRA_ARGS="${EXTRA_ARGS} --handshake-packet-data FgMBAAUAAAAAAQ== --filter-handshake"
fi
EXTRA_ARGS="${EXTRA_ARGS# }"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
[dry-run] WyTunnel node install plan
  route_id        = ${ROUTE_ID}
  allow_bridge_ip = ${BRIDGE_IP}
  listen_faketcp  = ${NODE_PRIMARY_IP}:${TRANSPORT_PORT}/tcp
  forward_udp     = ${LOCAL_IP}:${LOCAL_UDP_PORT}
  tun             = ${TUN_NAME} (${TUN_LOCAL} <-> ${TUN_PEER})
  wan_if          = ${WAN_IF}
  pool_mode       = ${POOL_MODE}
  keepalive       = ${KEEPALIVE_SEC}s
  fec             = ${FEC_SPEC}
  handshake_mode  = ${HANDSHAKE_MODE}
  ebpf            = ${EBPF_ENABLED}
  extra_args      = ${EXTRA_ARGS}
  disable_frpc    = ${DISABLE_FRPC}
EOF
  exit 0
fi

install_binary() {
  if [ -n "$BINARY_DIR" ]; then
    install -m 0755 "${BINARY_DIR}/wytunnel_server" "$WYTUNNEL_BIN"
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
  tar -xzf "${tmp}/${tarball}" -C "$tmp" wytunnel_server
  install -m 0755 "${tmp}/wytunnel_server" "$WYTUNNEL_BIN"
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

if [ "$ROLE" = "node" ]; then
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

cat > "${SYSTEMD_DIR}/amnezia-wytunnel-server@.service" <<EOF
[Unit]
Description=Amnezia WyTunnel Node Server (%i)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ETC_DIR}/%i.env
RuntimeDirectory=amnezia-wytunnel
RuntimeDirectoryPreserve=yes
ExecStartPre=${FW_HELPER} up node %i \${TUN_NAME} \${TUN_PEER} \${BRIDGE_IP} \${TRANSPORT_PORT} \${WAN_IF} \${NODE_PRIMARY_IP}
ExecStart=${WYTUNNEL_BIN} --local \${TRANSPORT_PORT} --remote \${LOCAL_IP}:\${LOCAL_UDP_PORT} --tun \${TUN_NAME} --tun-local \${TUN_LOCAL} --tun-peer \${TUN_PEER} --ipv4-only --metrics-listen ${RUN_DIR}/server-%i.sock \${EXTRA_ARGS}
ExecStopPost=-${FW_HELPER} down node %i \${TUN_NAME} \${TUN_PEER} \${BRIDGE_IP} \${TRANSPORT_PORT} \${WAN_IF} \${NODE_PRIMARY_IP}
ExecStopPost=-/bin/rm -f ${RUN_DIR}/server-%i.sock
Restart=always
RestartSec=2
LimitNOFILE=65536
MemoryMax=48M

[Install]
WantedBy=multi-user.target
EOF

cat > "${ETC_DIR}/${ROUTE_ID}.env" <<EOF
ROUTE_ID=${ROUTE_ID}
BRIDGE_IP=${BRIDGE_IP}
NODE_PRIMARY_IP=${NODE_PRIMARY_IP}
TRANSPORT_PORT=${TRANSPORT_PORT}
LOCAL_IP=${LOCAL_IP}
LOCAL_UDP_PORT=${LOCAL_UDP_PORT}
TUN_NAME=${TUN_NAME}
TUN_LOCAL=${TUN_LOCAL}
TUN_PEER=${TUN_PEER}
WAN_IF=${WAN_IF}
EXTRA_ARGS=${EXTRA_ARGS}
EOF
chmod 0640 "${ETC_DIR}/${ROUTE_ID}.env"

# Ensure inactive frpc for this route consumes zero RAM/CPU unless --keep-frpc was passed.
if [ "$DISABLE_FRPC" -eq 1 ]; then
  systemctl disable --now "amnezia-frpc@${ROUTE_ID}.service" 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable --now "amnezia-wytunnel-server@${ROUTE_ID}.service"
systemctl restart "amnezia-wytunnel-server@${ROUTE_ID}.service"

echo "WyTunnel node route ${ROUTE_ID} active on :${TRANSPORT_PORT}/tcp (bridge=${BRIDGE_IP} only) -> ${LOCAL_IP}:${LOCAL_UDP_PORT}."
