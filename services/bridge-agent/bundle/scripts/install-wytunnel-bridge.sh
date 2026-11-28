#!/usr/bin/env bash
# Idempotent WyTunnel client (FakeTCP bridge-side) installer and route manager.
#
# Installs versioned /opt/amnezia-wytunnel/<version>/wytunnel_client with atomic
# symlink swap at /usr/local/bin/wytunnel_client (mandatory SHA-256 verification
# via --sha256 or release SHA256SUMS), manages comment-tagged iptables rules via
# /usr/local/libexec/amnezia-wytunnel-bridge-fw.sh (iptables -w 5, zero conflict
# with ufw/Docker/node rules), writes /etc/amnezia-bridge/wytunnel/<route-id>.env
# and amnezia-wytunnel-client@<route-id>.service (Before=docker.service), persists
# /run/amnezia-wytunnel via tmpfiles.d, verifies systemd + Unix socket health with
# automatic rollback on failure, and calls toggle-frps.sh --disable on --disable-frps.

set -euo pipefail

WYTUNNEL_REPO="${WYTUNNEL_REPO:-wyrtensi/wytunnel}"
WYTUNNEL_VERSION="${WYTUNNEL_VERSION:-v0.1.0}"
WYTUNNEL_SHA256="${WYTUNNEL_SHA256:-}"
WYTUNNEL_BIN="${WYTUNNEL_BIN:-/usr/local/bin/wytunnel_client}"
WYTUNNEL_OPT_DIR="${WYTUNNEL_OPT_DIR:-/opt/amnezia-wytunnel}"
ETC_DIR="${WYTUNNEL_ETC_DIR:-/etc/amnezia-bridge/wytunnel}"
RUN_DIR="${WYTUNNEL_RUN_DIR:-/run/amnezia-wytunnel}"
FW_HELPER="${WYTUNNEL_FW_HELPER:-/usr/local/libexec/amnezia-wytunnel-bridge-fw.sh}"
SYSTEMD_DIR="${WYTUNNEL_SYSTEMD_DIR:-/etc/systemd/system}"
TMPFILES_DIR="${WYTUNNEL_TMPFILES_DIR:-/etc/tmpfiles.d}"
TOGGLE_FRPS_SCRIPT="${WYTUNNEL_TOGGLE_FRPS:-$(cd "$(dirname "$0")" && pwd)/toggle-frps.sh}"

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

TMP_WORK=""
cleanup() {
  if [ -n "$TMP_WORK" ] && [ -e "$TMP_WORK" ]; then
    rm -rf -- "$TMP_WORK"
  fi
}
trap cleanup EXIT

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
  --pool-rotate-interval <sec>    Seamless rotation interval (default: 2700 or 60..86400; 0 = off)
  --pool-rotate-drain <sec>       Drain window before closing rotated tunnel (1..60; default: 5)
  --keepalive <sec>               Keepalive time in seconds (0 or 5..300; default: 25)
  --fec <K:M|off>                 Optional Reed-Solomon FEC (default: off)
  --handshake-mode <mode>         none | tls_client_hello (default: none)
  --no-ebpf                       Disable eBPF NIC offload in direct mode
  --wan-if <iface>                Override detected outbound WAN interface
  --repo <owner/repo>             GitHub repository for releases (default: wyrtensi/wytunnel)
  --version <tag>                 WyTunnel release tag (default: v0.1.0)
  --sha256 <hex>                  Expected SHA-256 of release tarball (else fetched from SHA256SUMS)
  --binary-dir <dir>              Install wytunnel_client from local directory
  --disable-frps                  Stop & disable inactive amnezia-frps.service via toggle-frps.sh
  --remove                        Stop, disable, and clean up this route
  --dry-run                       Print planned actions without mutating host
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
    --node-ip) need_val "$@"; NODE_IP="$2"; shift 2 ;;
    --remote-port) need_val "$@"; REMOTE_PORT="$2"; shift 2 ;;
    --transport-port) need_val "$@"; TRANSPORT_PORT="$2"; shift 2 ;;
    --udp-pool-start) need_val "$@"; UDP_POOL_START="$2"; shift 2 ;;
    --pool-size) need_val "$@"; POOL_SIZE="$2"; shift 2 ;;
    --pool-rotate-interval) need_val "$@"; POOL_ROTATE_INTERVAL="$2"; shift 2 ;;
    --pool-rotate-drain) need_val "$@"; POOL_ROTATE_DRAIN="$2"; shift 2 ;;
    --keepalive) need_val "$@"; KEEPALIVE_SEC="$2"; shift 2 ;;
    --fec) need_val "$@"; FEC_SPEC="$2"; shift 2 ;;
    --handshake-mode) need_val "$@"; HANDSHAKE_MODE="$2"; shift 2 ;;
    --no-ebpf) EBPF_ENABLED="false"; shift ;;
    --wan-if) need_val "$@"; WAN_IF="$2"; shift 2 ;;
    --repo) need_val "$@"; WYTUNNEL_REPO="$2"; shift 2 ;;
    --version) need_val "$@"; WYTUNNEL_VERSION="$2"; shift 2 ;;
    --sha256) need_val "$@"; WYTUNNEL_SHA256="$2"; shift 2 ;;
    --binary-dir) need_val "$@"; BINARY_DIR="$2"; shift 2 ;;
    --disable-frps) DISABLE_FRPS=1; shift ;;
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
    echo "[dry-run] systemctl disable --now amnezia-wytunnel-client@${ROUTE_ID}.service"
    echo "[dry-run] rm -f ${ETC_DIR}/${ROUTE_ID}.env ${RUN_DIR}/client-${ROUTE_ID}.sock ${RUN_DIR}/client-${ROUTE_ID}.meta.json"
    exit 0
  fi
  systemctl disable --now "amnezia-wytunnel-client@${ROUTE_ID}.service" 2>/dev/null || true
  rm -f "${ETC_DIR}/${ROUTE_ID}.env" "${RUN_DIR}/client-${ROUTE_ID}.sock" "${RUN_DIR}/client-${ROUTE_ID}.meta.json"
  echo "Removed WyTunnel bridge route ${ROUTE_ID}."
  exit 0
fi

is_ipv4 "$NODE_IP" || { echo "Error: --node-ip must be a valid IPv4 address" >&2; exit 2; }
is_port "$REMOTE_PORT" || { echo "Error: --remote-port must be 1..65535" >&2; exit 2; }
is_port "$UDP_POOL_START" || { echo "Error: --udp-pool-start must be 1..65535" >&2; exit 2; }
if [ -n "$TRANSPORT_PORT" ] && ! is_port "$TRANSPORT_PORT"; then
  echo "Error: --transport-port must be 1..65535" >&2
  exit 2
fi
if ! [[ "$POOL_SIZE" =~ ^[0-9]+$ ]] || [ "$POOL_SIZE" -gt 64 ]; then
  echo "Error: --pool-size must be 0..64" >&2
  exit 2
fi
if ! [[ "$POOL_ROTATE_INTERVAL" =~ ^[0-9]+$ ]] || { [ "$POOL_ROTATE_INTERVAL" -ne 0 ] && { [ "$POOL_ROTATE_INTERVAL" -lt 60 ] || [ "$POOL_ROTATE_INTERVAL" -gt 86400 ]; }; }; then
  echo "Error: --pool-rotate-interval must be 0 or 60..86400" >&2
  exit 2
fi
if ! [[ "$POOL_ROTATE_DRAIN" =~ ^[0-9]+$ ]] || [ "$POOL_ROTATE_DRAIN" -lt 1 ] || [ "$POOL_ROTATE_DRAIN" -gt 60 ]; then
  echo "Error: --pool-rotate-drain must be 1..60" >&2
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
if [[ ! "$WAN_IF" =~ ^[A-Za-z0-9._:-]{1,32}$ ]]; then
  echo "Error: invalid WAN interface name '$WAN_IF'" >&2
  exit 2
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
  version         = ${WYTUNNEL_VERSION} (SHA-256 verified via ${WYTUNNEL_SHA256:+--sha256}${WYTUNNEL_SHA256:-release SHA256SUMS})
  metrics_socket  = ${RUN_DIR}/client-${ROUTE_ID}.sock
  disable_frps    = ${DISABLE_FRPS}
EOF
  exit 0
fi

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
    [ -x "${BINARY_DIR}/wytunnel_client" ] || { echo "Error: missing executable ${BINARY_DIR}/wytunnel_client" >&2; exit 1; }
    version_dir="${WYTUNNEL_OPT_DIR}/local"
    mkdir -p "$version_dir"
    target_bin="${version_dir}/wytunnel_client"
    if [ ! -f "$target_bin" ] || ! cmp -s "${BINARY_DIR}/wytunnel_client" "$target_bin"; then
      tmp_bin="$(mktemp "${version_dir}/.wytunnel_client.XXXXXX")"
      install -m 0755 "${BINARY_DIR}/wytunnel_client" "$tmp_bin"
      mv -f "$tmp_bin" "$target_bin"
      BINARY_CHANGED=1
    fi
    if [ "$PREV_BIN_TARGET" != "$target_bin" ]; then
      tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_client.link.XXXXXX")"
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
  target_bin="${version_dir}/wytunnel_client"
  if [ -x "$target_bin" ] && [ -f "${target_bin}.sha256" ]; then
    if [ -z "$WYTUNNEL_SHA256" ] || [ "$(tr 'A-F' 'a-f' <"${target_bin}.sha256")" = "$(printf '%s' "$WYTUNNEL_SHA256" | tr 'A-F' 'a-f')" ]; then
      if [ "$PREV_BIN_TARGET" != "$target_bin" ]; then
        tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_client.link.XXXXXX")"
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

  tar -xzf "${TMP_WORK}/${tarball}" -C "$TMP_WORK" wytunnel_client
  mkdir -p "$version_dir"
  tmp_bin="$(mktemp "${version_dir}/.wytunnel_client.XXXXXX")"
  install -m 0755 "${TMP_WORK}/wytunnel_client" "$tmp_bin"
  mv -f "$tmp_bin" "$target_bin"
  printf '%s\n' "$expected_sha" | atomic_write "${target_bin}.sha256" 0644

  tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_client.link.XXXXXX")"
  ln -sf "$target_bin" "$tmp_link"
  mv -Tf "$tmp_link" "$WYTUNNEL_BIN"
  BINARY_CHANGED=1
}

install_binary

mkdir -p "$ETC_DIR" "$RUN_DIR" "$(dirname "$FW_HELPER")" "$SYSTEMD_DIR" "$TMPFILES_DIR"
chmod 0755 "$RUN_DIR"

printf 'd %s 0755 root root -\n' "$RUN_DIR" | atomic_write "${TMPFILES_DIR}/amnezia-wytunnel.conf" 0644

SERVICE_NAME="amnezia-wytunnel-client@${ROUTE_ID}.service"
ENV_FILE="${ETC_DIR}/${ROUTE_ID}.env"
UNIT_FILE="${SYSTEMD_DIR}/amnezia-wytunnel-client@.service"

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
ROLE="${2:?bridge}"
ROUTE_ID="${3:?}"
TUN_IF="${4:?}"
TUN_PEER="${5:?}"
PEER_IP="${6:?}"
TRANSPORT_PORT="${7:?}"
WAN_IF="${8:?}"
COMMENT="amnezia-wt-${ROUTE_ID}"

del_rule() {
  local table="$1"; shift
  while iptables -w 5 -t "$table" -D "$@" 2>/dev/null; do :; done
}

if [ "$ROLE" = "bridge" ]; then
  del_rule nat POSTROUTING -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -o "$WAN_IF" -j MASQUERADE -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  del_rule filter FORWARD -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  if [ "$ACTION" = "up" ]; then
    iptables -w 5 -t nat -I POSTROUTING 1 -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -o "$WAN_IF" -j MASQUERADE -m comment --comment "$COMMENT"
    iptables -w 5 -I FORWARD 1 -i "$TUN_IF" -o "$WAN_IF" -s "${TUN_PEER}/32" -d "${PEER_IP}/32" -p tcp --dport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
    iptables -w 5 -I FORWARD 1 -i "$WAN_IF" -o "$TUN_IF" -s "${PEER_IP}/32" -d "${TUN_PEER}/32" -p tcp --sport "$TRANSPORT_PORT" -j ACCEPT -m comment --comment "$COMMENT"
  fi
fi
FWEOF

NEW_UNIT="${TMP_BACKUP}/unit.new"
cat >"$NEW_UNIT" <<EOF
[Unit]
Description=Amnezia WyTunnel Bridge Client (%i)
After=network-online.target
Before=docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ETC_DIR}/%i.env
RuntimeDirectory=amnezia-wytunnel
RuntimeDirectoryPreserve=yes
ExecStartPre=${FW_HELPER} up bridge %i \${TUN_NAME} \${TUN_PEER} \${NODE_IP} \${TRANSPORT_PORT} \${WAN_IF}
ExecStartPre=/bin/sh -c 'tmp="\$(mktemp ${RUN_DIR}/.client-%i.meta.json.XXXXXX)"; printf "{\"remotePort\":%s,\"transportPort\":%s,\"startedAt\":\"%s\"}\n" "\${REMOTE_PORT}" "\${TRANSPORT_PORT}" "\$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)" >"\$tmp" && chmod 0644 "\$tmp" && mv -f "\$tmp" ${RUN_DIR}/client-%i.meta.json'
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

NEW_ENV="${TMP_BACKUP}/env.new"
cat >"$NEW_ENV" <<EOF
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

rollback_bridge_route() {
  echo "Error: WyTunnel route ${ROUTE_ID} failed health verification; rolling back..." >&2
  [ -f "$OLD_ENV_BAK" ] && atomic_write "$ENV_FILE" 0640 <"$OLD_ENV_BAK" || true
  [ -f "$OLD_UNIT_BAK" ] && atomic_write "$UNIT_FILE" 0644 <"$OLD_UNIT_BAK" || true
  if [ "$BINARY_CHANGED" -eq 1 ] && [ -n "$PREV_BIN_TARGET" ] && [ -e "$PREV_BIN_TARGET" ]; then
    tmp_link="$(mktemp "$(dirname -- "$WYTUNNEL_BIN")/.wytunnel_client.link.XXXXXX")"
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

if [ "$CONFIG_CHANGED" -eq 1 ] || [ "$BINARY_CHANGED" -eq 1 ] || ! systemctl is-active --quiet "$SERVICE_NAME"; then
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  sock_path="${RUN_DIR}/client-${ROUTE_ID}.sock"
  healthy=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "$SERVICE_NAME" && [ -S "$sock_path" ]; then
      if curl -fsS --max-time 2 --unix-socket "$sock_path" http://localhost/status 2>/dev/null | grep -Fq '"role":"client"'; then
        healthy=1
        break
      fi
    fi
    sleep 1
  done
  [ "$healthy" -eq 1 ] || rollback_bridge_route
fi
rm -rf -- "$TMP_BACKUP"

if [ "$DISABLE_FRPS" -eq 1 ]; then
  if [ -x "$TOGGLE_FRPS_SCRIPT" ] || [ -f "$TOGGLE_FRPS_SCRIPT" ]; then
    bash "$TOGGLE_FRPS_SCRIPT" --disable
  else
    systemctl disable --now amnezia-frps.service 2>/dev/null || true
  fi
fi

echo "WyTunnel bridge route ${ROUTE_ID} active on 0.0.0.0:${REMOTE_PORT}/udp -> ${NODE_IP}:${TRANSPORT_PORT}/tcp (pool=${POOL_SIZE})."
