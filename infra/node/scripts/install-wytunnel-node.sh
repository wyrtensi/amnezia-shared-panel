#!/usr/bin/env bash
# Idempotent WyTunnel server (FakeTCP node-side) installer and route manager.
#
# Installs versioned /opt/amnezia-wytunnel/<version>/wytunnel_server with atomic
# symlink swap at /usr/local/bin/wytunnel_server (mandatory SHA-256 verification
# via --sha256 or release SHA256SUMS), derives node TUN slot from --transport-port
# (preventing multi-bridge collisions on the same VPN node), sets up strict
# bridge-only DNAT/FORWARD rules via /usr/local/libexec/amnezia-wytunnel-node-fw.sh
# (iptables -w 5, zero conflict with ufw/Docker/bridge scripts), writes
# amnezia-wytunnel-server@<route-id>.service, verifies systemd + Unix socket health
# with automatic rollback on failure, and stops/disables amnezia-frpc@<route-id>.

set -euo pipefail

WYTUNNEL_REPO="${WYTUNNEL_REPO:-wyrtensi/wytunnel}"
WYTUNNEL_VERSION="${WYTUNNEL_VERSION:-v0.1.0}"
WYTUNNEL_SHA256="${WYTUNNEL_SHA256:-}"
WYTUNNEL_BIN="${WYTUNNEL_BIN:-/usr/local/bin/wytunnel_server}"
WYTUNNEL_OPT_DIR="${WYTUNNEL_OPT_DIR:-/opt/amnezia-wytunnel}"
ETC_DIR="${WYTUNNEL_ETC_DIR:-/etc/amnezia-node/wytunnel}"
RUN_DIR="${WYTUNNEL_RUN_DIR:-/run/amnezia-wytunnel}"
FW_HELPER="${WYTUNNEL_FW_HELPER:-/usr/local/libexec/amnezia-wytunnel-node-fw.sh}"
SYSTEMD_DIR="${WYTUNNEL_SYSTEMD_DIR:-/etc/systemd/system}"
TMPFILES_DIR="${WYTUNNEL_TMPFILES_DIR:-/etc/tmpfiles.d}"

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

TMP_WORK=""
cleanup() {
  if [ -n "$TMP_WORK" ] && [ -e "$TMP_WORK" ]; then
    rm -rf -- "$TMP_WORK"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: install-wytunnel-node.sh --route-id <uuid> [options]

Required (install/update):
  --route-id <uuid>           Route UUID
  --bridge-ip <ipv4>          Bridge public IPv4 (strictly allowlisted on FakeTCP port)
  --remote-port <port>        Bridge public UDP port (derives default transport port)

Options:
  --transport-port <port>     Node FakeTCP listening port (default: 14100 + slot; also derives node TUN slot)
  --node-primary-ip <ipv4>    Override detected node primary IPv4 for DNAT
  --udp-pool-start <port>     Bridge UDP pool start (default: 41000)
  --local-ip <ipv4>           Local AWG3 UDP target IP (default: 127.0.0.1)
  --local-udp-port <port>     Local AWG3 UDP target port (default: 51890)
  --pool-mode                 Run server in persistent pool multiplexing mode (default)
  --direct-mode               Run server in classic per-client mode (no pool mux)
  --keepalive <sec>           Keepalive seconds (0 or 5..300; default: 25)
  --fec <K:M|off>             Optional Reed-Solomon FEC (default: off)
  --handshake-mode <mode>     none | tls_client_hello (default: none)
  --no-ebpf                   Disable eBPF NIC offload in direct mode
  --wan-if <iface>            Override detected WAN interface
  --keep-frpc                 Do not stop/disable amnezia-frpc@<route-id>.service
  --repo <owner/repo>         GitHub repository for releases (default: wyrtensi/wytunnel)
  --version <tag>             WyTunnel release tag (default: v0.1.0)
  --sha256 <hex>              Expected SHA-256 of release tarball (else fetched from SHA256SUMS)
  --binary-dir <dir>          Install wytunnel_server from local directory
  --remove                    Stop, disable, and clean up this route
  --dry-run                   Print planned actions without mutating host
EOF
}

need_val() {
  if [ "$#" -lt 2 ]; then
    echo "Error: $1 requires a value" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --route-id) need_val "$@"; ROUTE_ID="$2"; shift 2 ;;
    --bridge-ip) need_val "$@"; BRIDGE_IP="$2"; shift 2 ;;
    --node-primary-ip) need_val "$@"; NODE_PRIMARY_IP="$2"; shift 2 ;;
    --remote-port) need_val "$@"; REMOTE_PORT="$2"; shift 2 ;;
    --transport-port) need_val "$@"; TRANSPORT_PORT="$2"; shift 2 ;;
    --udp-pool-start) need_val "$@"; UDP_POOL_START="$2"; shift 2 ;;
    --local-ip) need_val "$@"; LOCAL_IP="$2"; shift 2 ;;
    --local-udp-port) need_val "$@"; LOCAL_UDP_PORT="$2"; shift 2 ;;
    --pool-mode) POOL_MODE=1; shift ;;
    --direct-mode) POOL_MODE=0; shift ;;
    --keepalive) need_val "$@"; KEEPALIVE_SEC="$2"; shift 2 ;;
    --fec) need_val "$@"; FEC_SPEC="$2"; shift 2 ;;
    --handshake-mode) need_val "$@"; HANDSHAKE_MODE="$2"; shift 2 ;;
    --no-ebpf) EBPF_ENABLED="false"; shift ;;
    --wan-if) need_val "$@"; WAN_IF="$2"; shift 2 ;;
    --keep-frpc) DISABLE_FRPC=0; shift ;;
    --repo) need_val "$@"; WYTUNNEL_REPO="$2"; shift 2 ;;
    --version) need_val "$@"; WYTUNNEL_VERSION="$2"; shift 2 ;;
    --sha256) need_val "$@"; WYTUNNEL_SHA256="$2"; shift 2 ;;
    --binary-dir) need_val "$@"; BINARY_DIR="$2"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
is_ipv4() {
  local ip="$1" o1 o2 o3 o4
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  o1="${BASH_REMATCH[1]}" o2="${BASH_REMATCH[2]}" o3="${BASH_REMATCH[3]}" o4="${BASH_REMATCH[4]}"
  [ "$o1" -le 255 ] && [ "$o2" -le 255 ] && [ "$o3" -le 255 ] && [ "$o4" -le 255 ]
}
is_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

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

is_ipv4 "$BRIDGE_IP" || { echo "Error: --bridge-ip must be a valid IPv4 address" >&2; exit 2; }
is_ipv4 "$LOCAL_IP" || { echo "Error: --local-ip must be a valid IPv4 address" >&2; exit 2; }
is_port "$LOCAL_UDP_PORT" || { echo "Error: --local-udp-port must be 1..65535" >&2; exit 2; }
is_port "$UDP_POOL_START" || { echo "Error: --udp-pool-start must be 1..65535" >&2; exit 2; }
if [ -n "$REMOTE_PORT" ] && ! is_port "$REMOTE_PORT"; then
  echo "Error: --remote-port must be 1..65535" >&2
  exit 2
fi
if [ -n "$TRANSPORT_PORT" ] && ! is_port "$TRANSPORT_PORT"; then
  echo "Error: --transport-port must be 1..65535" >&2
  exit 2
fi
if [ -z "$TRANSPORT_PORT" ] && [ -z "$REMOTE_PORT" ]; then
  echo "Error: specify --transport-port or --remote-port" >&2
  exit 2
fi
if ! [[ "$KEEPALIVE_SEC" =~ ^[0-9]+$ ]] || { [ "$KEEPALIVE_SEC" -ne 0 ] && { [ "$KEEPALIVE_SEC" -lt 5 ] || [ "$KEEPALIVE_SEC" -gt 300 ]; }; }; then
  echo "Error: --keepalive must be 0 or 5..300" >&2
  exit 2
fi
if [[ ! "$FEC_SPEC" =~ ^(off|[1-9][0-9]*:[1-9][0-9]*)$ ]]; then
  echo "Error: --fec must be 'off' or '<K>:<M>'" >&2
  exit 2
fi
if [ "$FEC_SPEC" != "off" ]; then
  fec_k="${FEC_SPEC%%:*}" fec_m="${FEC_SPEC##*:}"
  if [ "$fec_k" -lt 1 ] || [ "$fec_k" -gt 64 ] || [ "$fec_m" -lt 1 ] || [ "$fec_m" -gt 16 ]; then
    echo "Error: --fec bounds must be 1..64:1..16" >&2
    exit 2
  fi
fi
if [ "$HANDSHAKE_MODE" != "none" ] && [ "$HANDSHAKE_MODE" != "tls_client_hello" ]; then
  echo "Error: --handshake-mode must be 'none' or 'tls_client_hello'" >&2
  exit 2
fi
if [[ ! "$WYTUNNEL_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "Error: --repo must be '<owner>/<repo>'" >&2
  exit 2
fi
if [[ ! "$WYTUNNEL_VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Error: --version contains unsupported characters" >&2
  exit 2
fi
if [ -n "$WYTUNNEL_SHA256" ] && [[ ! "$WYTUNNEL_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "Error: --sha256 must be a 64-character hex digest" >&2
  exit 2
fi

if [ -z "$TRANSPORT_PORT" ]; then
  DEFAULT_SLOT=$(( REMOTE_PORT - UDP_POOL_START ))
  if [ "$DEFAULT_SLOT" -lt 0 ] || [ "$DEFAULT_SLOT" -gt 250 ]; then
    DEFAULT_SLOT=$(( REMOTE_PORT % 250 ))
  fi
  TRANSPORT_PORT=$(( 14100 + DEFAULT_SLOT ))
fi

# Derive node TUN slot directly from TRANSPORT_PORT so multiple bridges targeting
# this node on distinct transport ports never collide on pts-<slot> / 10.251.<slot>.0/30.
if [ "$TRANSPORT_PORT" -ge 14100 ] && [ "$TRANSPORT_PORT" -lt 14350 ]; then
  SLOT=$(( TRANSPORT_PORT - 14100 ))
else
  SLOT=$(( TRANSPORT_PORT % 250 ))
fi

TUN_NAME="pts-${SLOT}"
TUN_LOCAL="10.251.${SLOT}.1"
TUN_PEER="10.251.${SLOT}.2"

if [ -z "$WAN_IF" ]; then
  WAN_IF=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}' || true)
  WAN_IF="${WAN_IF:-eth0}"
fi
if [[ ! "$WAN_IF" =~ ^[A-Za-z0-9._:-]{1,32}$ ]]; then
  echo "Error: invalid WAN interface name '$WAN_IF'" >&2
  exit 2
fi

if [ -z "$NODE_PRIMARY_IP" ]; then
  NODE_PRIMARY_IP=$(ip -4 route get "$BRIDGE_IP" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)
fi
if [ -n "$NODE_PRIMARY_IP" ] && ! is_ipv4 "$NODE_PRIMARY_IP"; then
  echo "Error: --node-primary-ip must be a valid IPv4 address" >&2
  exit 2
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
  listen_faketcp  = ${NODE_PRIMARY_IP:-<auto-detect>}:${TRANSPORT_PORT}/tcp
  forward_udp     = ${LOCAL_IP}:${LOCAL_UDP_PORT}
  tun             = ${TUN_NAME} (${TUN_LOCAL} <-> ${TUN_PEER})
  wan_if          = ${WAN_IF}
  pool_mode       = ${POOL_MODE}
  keepalive       = ${KEEPALIVE_SEC}s
  fec             = ${FEC_SPEC}
  handshake_mode  = ${HANDSHAKE_MODE}
  ebpf            = ${EBPF_ENABLED}
  extra_args      = ${EXTRA_ARGS}
  version         = ${WYTUNNEL_VERSION} (SHA-256 verified via ${WYTUNNEL_SHA256:+--sha256}${WYTUNNEL_SHA256:-release SHA256SUMS})
  disable_frpc    = ${DISABLE_FRPC}
EOF
  exit 0
fi

is_ipv4 "$NODE_PRIMARY_IP" || {
  echo "Error: could not detect node primary IPv4 for bridge ${BRIDGE_IP}; pass --node-primary-ip <ipv4>" >&2
  exit 1
}

atomic_write() {
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp "$(dirname -- "$dest")/.$(basename -- "$dest").XXXXXX")" || return 1
  if ! cat >"$tmp" || ! chmod "$mode" "$tmp" || ! mv -f "$tmp" "$dest"; then
    rm -f -- "$tmp"
    return 1
  fi
}

BINARY_CHANGED=0
PREV_BIN_TARGET=""
if [ -L "$WYTUNNEL_BIN" ]; then
  PREV_BIN_TARGET="$(readlink -f -- "$WYTUNNEL_BIN" || true)"
elif [ -e "$WYTUNNEL_BIN" ]; then
  PREV_BIN_TARGET="$WYTUNNEL_BIN"
fi

install_binary() {
  local version_dir target_bin expected_sha actual_sha arch tarball base_url tmp_bin tmp_link
  mkdir -p "$(dirname -- "$WYTUNNEL_BIN")" "$WYTUNNEL_OPT_DIR"

  if [ -n "$BINARY_DIR" ]; then
    [ -x "${BINARY_DIR}/wytunnel_server" ] || { echo "Error: missing executable ${BINARY_DIR}/wytunnel_server" >&2; exit 1; }
    version_dir="${WYTUNNEL_OPT_DIR}/local"
    mkdir -p "$version_dir"
    target_bin="${version_dir}/wytunnel_server"
    if [ ! -f "$target_bin" ] || ! cmp -s "${BINARY_DIR}/wytunnel_server" "$target_bin"; then
      tmp_bin="$(mktemp "${version_dir}/.wytunnel_server.XXXXXX")"
      install -m 0755 "${BINARY_DIR}/wytunnel_server" "$tmp_bin"
      mv -f "$tmp_bin" "$target_bin"
      BINARY_CHANGED=1
    fi
    if [ "$PREV_BIN_TARGET" != "$target_bin" ]; then
      tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_server.link.XXXXXX")"
      ln -sf "$target_bin" "$tmp_link"
      mv -Tf "$tmp_link" "$WYTUNNEL_BIN"
      BINARY_CHANGED=1
    fi
    return
  fi

  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  version_dir="${WYTUNNEL_OPT_DIR}/${WYTUNNEL_VERSION}"
  target_bin="${version_dir}/wytunnel_server"
  if [ -x "$target_bin" ] && [ -f "${target_bin}.sha256" ]; then
    if [ -z "$WYTUNNEL_SHA256" ] || [ "$(tr 'A-F' 'a-f' <"${target_bin}.sha256")" = "$(printf '%s' "$WYTUNNEL_SHA256" | tr 'A-F' 'a-f')" ]; then
      if [ "$PREV_BIN_TARGET" != "$target_bin" ]; then
        tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_server.link.XXXXXX")"
        ln -sf "$target_bin" "$tmp_link"
        mv -Tf "$tmp_link" "$WYTUNNEL_BIN"
        BINARY_CHANGED=1
      fi
      return
    fi
  fi

  tarball="wytunnel-linux-${arch}-musl.tar.gz"
  base_url="https://github.com/${WYTUNNEL_REPO}/releases/download/${WYTUNNEL_VERSION}"
  TMP_WORK="$(mktemp -d)"

  curl --proto '=https' --tlsv1.2 --max-time 180 -fsSL "${base_url}/${tarball}" -o "${TMP_WORK}/${tarball}"
  if [ -n "$WYTUNNEL_SHA256" ]; then
    expected_sha="$(printf '%s' "$WYTUNNEL_SHA256" | tr 'A-F' 'a-f')"
  else
    curl --proto '=https' --tlsv1.2 --max-time 60 -fsSL "${base_url}/SHA256SUMS" -o "${TMP_WORK}/SHA256SUMS"
    expected_sha="$(awk -v f="$tarball" '$2 == f || $2 == ("*" f) { print tolower($1); exit }' "${TMP_WORK}/SHA256SUMS")"
  fi
  if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Error: missing valid 64-hex SHA-256 checksum for ${tarball}; refusing unverified download" >&2
    exit 1
  fi
  actual_sha="$(sha256sum "${TMP_WORK}/${tarball}" | awk '{print tolower($1)}')"
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "Error: SHA-256 mismatch for ${tarball} (expected ${expected_sha}, got ${actual_sha})" >&2
    exit 1
  fi

  tar -xzf "${TMP_WORK}/${tarball}" -C "$TMP_WORK" wytunnel_server
  mkdir -p "$version_dir"
  tmp_bin="$(mktemp "${version_dir}/.wytunnel_server.XXXXXX")"
  install -m 0755 "${TMP_WORK}/wytunnel_server" "$tmp_bin"
  mv -f "$tmp_bin" "$target_bin"
  printf '%s\n' "$expected_sha" | atomic_write "${target_bin}.sha256" 0644

  tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_server.link.XXXXXX")"
  ln -sf "$target_bin" "$tmp_link"
  mv -Tf "$tmp_link" "$WYTUNNEL_BIN"
  BINARY_CHANGED=1
}

install_binary

mkdir -p "$ETC_DIR" "$RUN_DIR" "$(dirname "$FW_HELPER")" "$SYSTEMD_DIR" "$TMPFILES_DIR"
chmod 0755 "$RUN_DIR"

printf 'd %s 0755 root root -\n' "$RUN_DIR" | atomic_write "${TMPFILES_DIR}/amnezia-wytunnel.conf" 0644

SERVICE_NAME="amnezia-wytunnel-server@${ROUTE_ID}.service"
ENV_FILE="${ETC_DIR}/${ROUTE_ID}.env"
UNIT_FILE="${SYSTEMD_DIR}/amnezia-wytunnel-server@.service"

TMP_BACKUP="$(mktemp -d)"
OLD_ENV_BAK="${TMP_BACKUP}/env"
OLD_UNIT_BAK="${TMP_BACKUP}/unit"
[ -f "$ENV_FILE" ] && cp -f "$ENV_FILE" "$OLD_ENV_BAK" || true
[ -f "$UNIT_FILE" ] && cp -f "$UNIT_FILE" "$OLD_UNIT_BAK" || true

NEW_FW="${TMP_BACKUP}/fw.sh"
cat >"$NEW_FW" <<'FWEOF'
#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:?up|down}"
ROLE="${2:?node}"
ROUTE_ID="${3:?}"
TUN_IF="${4:?}"
TUN_PEER="${5:?}"
PEER_IP="${6:?}"
TRANSPORT_PORT="${7:?}"
WAN_IF="${8:?}"
NODE_PRIMARY_IP="${9:?}"
COMMENT="amnezia-wt-${ROUTE_ID}"

del_rule() {
  local table="$1"; shift
  while iptables -w 5 -t "$table" -D "$@" 2>/dev/null; do :; done
}

if [ "$ROLE" = "node" ]; then
  del_rule nat PREROUTING -i "$WAN_IF" -s "${PEER_IP}/32" -d "${NODE_PRIMARY_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j DNAT --to-destination "${TUN_PEER}:${TRANSPORT_PORT}" -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  if [ "$ACTION" = "up" ]; then
    iptables -w 5 -t nat -I PREROUTING 1 -i "$WAN_IF" -s "${PEER_IP}/32" -d "${NODE_PRIMARY_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j DNAT --to-destination "${TUN_PEER}:${TRANSPORT_PORT}" -m comment --comment "$COMMENT"
    iptables -w 5 -I FORWARD 1 -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
    iptables -w 5 -I FORWARD 1 -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  fi
fi
FWEOF

NEW_UNIT="${TMP_BACKUP}/unit.new"
cat >"$NEW_UNIT" <<EOF
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

NEW_ENV="${TMP_BACKUP}/env.new"
cat >"$NEW_ENV" <<EOF
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

CONFIG_CHANGED=0
if [ ! -f "$FW_HELPER" ] || ! cmp -s "$NEW_FW" "$FW_HELPER"; then
  atomic_write "$FW_HELPER" 0755 <"$NEW_FW"
  CONFIG_CHANGED=1
fi
if [ ! -f "$UNIT_FILE" ] || ! cmp -s "$NEW_UNIT" "$UNIT_FILE"; then
  atomic_write "$UNIT_FILE" 0644 <"$NEW_UNIT"
  CONFIG_CHANGED=1
fi
if [ ! -f "$ENV_FILE" ] || ! cmp -s "$NEW_ENV" "$ENV_FILE"; then
  atomic_write "$ENV_FILE" 0640 <"$NEW_ENV"
  CONFIG_CHANGED=1
fi

rollback_node_route() {
  echo "Error: WyTunnel node route ${ROUTE_ID} failed health verification; rolling back..." >&2
  [ -f "$OLD_ENV_BAK" ] && atomic_write "$ENV_FILE" 0640 <"$OLD_ENV_BAK" || true
  [ -f "$OLD_UNIT_BAK" ] && atomic_write "$UNIT_FILE" 0644 <"$OLD_UNIT_BAK" || true
  if [ "$BINARY_CHANGED" -eq 1 ] && [ -n "$PREV_BIN_TARGET" ] && [ -e "$PREV_BIN_TARGET" ]; then
    tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_server.link.XXXXXX")"
    ln -sf "$PREV_BIN_TARGET" "$tmp_link" && mv -Tf "$tmp_link" "$WYTUNNEL_BIN" || true
  fi
  systemctl daemon-reload || true
  if [ -f "$OLD_ENV_BAK" ]; then
    systemctl restart "$SERVICE_NAME" || true
  else
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  fi
  rm -rf -- "$TMP_BACKUP"
  exit 1
}

# Ensure inactive frpc for this route consumes zero RAM/CPU unless --keep-frpc was passed.
if [ "$DISABLE_FRPC" -eq 1 ]; then
  systemctl disable --now "amnezia-frpc@${ROUTE_ID}.service" 2>/dev/null || true
fi

if [ "$CONFIG_CHANGED" -eq 1 ] || [ "$BINARY_CHANGED" -eq 1 ] || ! systemctl is-active --quiet "$SERVICE_NAME"; then
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  sock_path="${RUN_DIR}/server-${ROUTE_ID}.sock"
  healthy=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "$SERVICE_NAME" && [ -S "$sock_path" ]; then
      if curl -fsS --max-time 2 --unix-socket "$sock_path" http://localhost/status 2>/dev/null | grep -Fq '"role":"server"'; then
        healthy=1
        break
      fi
    fi
    sleep 1
  done
  [ "$healthy" -eq 1 ] || rollback_node_route
fi
rm -rf -- "$TMP_BACKUP"

echo "WyTunnel node route ${ROUTE_ID} active on :${TRANSPORT_PORT}/tcp (bridge=${BRIDGE_IP} only) -> ${LOCAL_IP}:${LOCAL_UDP_PORT}."
