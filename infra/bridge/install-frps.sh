#!/bin/sh
# Install the single frps (frp server) on a bridge host.
#
#   install-frps.sh --bridge-id <uuid> --control-port <tcp> --udp-start <first>
#       --udp-end <last> [--dry-run]
#
# Writes one frps config and one unit, amnezia-frps.service. Secrets stay out of
# arguments and out of the config: the operator places these protected files
# through a trusted channel before running the script:
#   /etc/amnezia-bridge/frp/token       shared bridge token, mode 0600
#   /etc/amnezia-bridge/frp/server.crt  frps certificate (SAN = bridge IPv4), mode 0644
#   /etc/amnezia-bridge/frp/server.key  its private key, mode 0600
# The installer creates /etc/amnezia-bridge/frp/dashboard.env (mode 0600) once:
# FRPS_DASHBOARD_USER / FRPS_DASHBOARD_PASSWORD for the frps dashboard API, which
# listens on 127.0.0.1:7500 only. The bridge-agent reads /api/serverinfo and
# /api/proxy/udp there with basic auth. The config references those values
# through systemd environment templates, so it holds no secret itself.
#
# frps enforces token auth and TLS, and its allowPorts is exactly the UDP pool.
# The script does not configure firewalls; it prints the rules to apply.
#
# A dry run reads real listeners and unit state and prints PLAN: lines; it
# writes, downloads, generates and starts nothing. Without --dry-run the config
# is rendered to a temp file, checked with `frps verify`, and only then moved
# into place atomically before the unit is enabled. A failure restores the
# previous config.
#
# Exit codes (the message names the field or observed value):
#    0  success, or a repeat with the same inputs
#    2  invalid arguments
#   11  token/certificate file missing or has unsafe mode/owner
#   12  frp download or SHA-256 check failed (nothing installed)
#   13  frps verify rejected the generated config (previous config untouched)
#   20  conflict with an existing config/unit (the conflicting field is named)
#   21  a needed local port is already bound by another process
#   50  frps did not start or does not listen where configured
# Pool exhaustion is reported by the panel API (BRIDGE_POOL_EXHAUSTED).
#
# Test seams (not for operators): AMNEZIA_ETC, AMNEZIA_SYSTEMD_DIR,
# AMNEZIA_FRP_PREFIX, AMNEZIA_ALLOW_NONROOT.
set -eu

ETC="${AMNEZIA_ETC:-/etc}"
SYSTEMD_DIR="${AMNEZIA_SYSTEMD_DIR:-/etc/systemd/system}"
FRP_PREFIX="${AMNEZIA_FRP_PREFIX:-/opt/amnezia-frp}"
FRP_DIR="$ETC/amnezia-bridge/frp"
TOKEN_FILE="$FRP_DIR/token"
CERT_FILE="$FRP_DIR/server.crt"
KEY_FILE="$FRP_DIR/server.key"
DASH_ENV_FILE="$FRP_DIR/dashboard.env"
BRIDGE_ID_FILE="$FRP_DIR/bridge-id"
CONF="$FRP_DIR/frps.toml"
UNIT=amnezia-frps.service
UNIT_FILE="$SYSTEMD_DIR/$UNIT"
DASH_PORT=7500

# BEGIN frp-pin (keep identical in infra/bridge/install-frps.sh)
FRP_VERSION=0.72.0
FRP_RELEASE_URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}"
# SHA-256 from the official frp_sha256_checksums.txt of release v0.72.0.
FRP_SHA256_AMD64=daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804
FRP_SHA256_ARM64=02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf
# END frp-pin
FRPS_BIN="$FRP_PREFIX/$FRP_VERSION/frps"

info() { printf '%s\n' "$*"; }
plan() { printf 'PLAN: %s\n' "$*"; }
die() {
  code="$1"
  name="$2"
  shift 2
  printf 'ERROR[%s]: %s\n' "$name" "$*" >&2
  exit "$code"
}
usage_error() { die 2 E_USAGE "$*"; }

BRIDGE_ID=""
CONTROL_PORT=""
UDP_START=""
UDP_END=""
DRY_RUN=0

need_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bridge-id) need_value "$@"; BRIDGE_ID="$2"; shift 2 ;;
    --control-port) need_value "$@"; CONTROL_PORT="$2"; shift 2 ;;
    --udp-start) need_value "$@"; UDP_START="$2"; shift 2 ;;
    --udp-end) need_value "$@"; UDP_END="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

is_uuid() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}
is_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_uuid "$BRIDGE_ID" || usage_error "--bridge-id must be a lowercase UUID"
is_port "$CONTROL_PORT" || usage_error "--control-port must be a TCP port (1-65535)"
is_port "$UDP_START" || usage_error "--udp-start must be a UDP port (1-65535)"
is_port "$UDP_END" || usage_error "--udp-end must be a UDP port (1-65535)"
[ "$UDP_START" -le "$UDP_END" ] || usage_error "--udp-start must not exceed --udp-end"
[ "$CONTROL_PORT" -ne "$DASH_PORT" ] || usage_error "--control-port must not be $DASH_PORT (frps dashboard, loopback only)"

if [ "$DRY_RUN" -eq 0 ] && [ "${AMNEZIA_ALLOW_NONROOT:-0}" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  die 2 E_USAGE "run as root (or use --dry-run to only read state)"
fi

# ---- protected files -------------------------------------------------------
file_mode() { stat -c %a "$1"; }
check_secret_file() {
  [ -f "$1" ] || die 11 E_FILE "missing protected file $1 (place it through a trusted channel)"
  mode="$(file_mode "$1")"
  case "$mode" in
    400|600) ;;
    *) die 11 E_FILE "$1 has mode $mode, expected 0600" ;;
  esac
  [ "$(stat -c %u "$1")" = "$(id -u)" ] || die 11 E_FILE "$1 must be owned by the user running this script"
}
check_public_file() {
  [ -f "$1" ] || die 11 E_FILE "missing file $1 (the frps certificate)"
  mode="$(file_mode "$1")"
  [ "$((0$mode & 022))" -eq 0 ] || die 11 E_FILE "$1 has mode $mode, expected 0644"
}
check_secret_file "$TOKEN_FILE"
check_secret_file "$KEY_FILE"
check_public_file "$CERT_FILE"

# ---- state -----------------------------------------------------------------
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
unit_enabled() { systemctl is-enabled --quiet "$1" 2>/dev/null; }
conf_field() { sed -n "s/^$1 = \"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$2" | head -n 1; }

active=0
unit_active "$UNIT" && active=1
enabled=0
unit_enabled "$UNIT" && enabled=1

if [ -f "$BRIDGE_ID_FILE" ]; then
  existing_id="$(cat "$BRIDGE_ID_FILE")"
  [ "$existing_id" = "$BRIDGE_ID" ] ||
    die 20 E_CONFLICT "this host already runs bridge $existing_id, requested --bridge-id $BRIDGE_ID"
fi
if [ -f "$CONF" ]; then
  # The pool and the control port of a running frps are not changed in place:
  # registered routes depend on them.
  for pair in "bindPort:control-port:$CONTROL_PORT" "start:udp-start:$UDP_START" "end:udp-end:$UDP_END"; do
    key="${pair%%:*}"
    rest="${pair#*:}"
    flag="${rest%%:*}"
    want="${rest#*:}"
    have="$(conf_field "$key" "$CONF")"
    [ "$have" = "$want" ] ||
      die 20 E_CONFLICT "existing $CONF has $key=$have, requested --$flag $want"
  done
fi

tcp_listeners="$(ss -H -ltn 2>/dev/null || true)"
udp_listeners="$(ss -H -lun 2>/dev/null || true)"
local_port_of() { awk '{n=split($4,a,":"); print a[n]}'; }
tcp_bound() { printf '%s\n' "$tcp_listeners" | local_port_of | grep -qx "$1"; }

if [ "$active" -eq 0 ]; then
  tcp_bound "$CONTROL_PORT" && die 21 E_PORT_BOUND "control TCP port $CONTROL_PORT (--control-port) is already bound by another process"
  tcp_bound "$DASH_PORT" && die 21 E_PORT_BOUND "dashboard port $DASH_PORT is already bound by another process"
  busy="$(printf '%s\n' "$udp_listeners" | local_port_of | awk -v s="$UDP_START" -v e="$UDP_END" '$1+0>=s && $1+0<=e {print $1}' | head -n 3 | tr '\n' ' ')"
  [ -z "$busy" ] || die 21 E_PORT_BOUND "UDP ports in the pool $UDP_START-$UDP_END (--udp-start/--udp-end) are already bound: $busy"
fi

render_config() {
  cat <<CONF_EOF
# Managed by install-frps.sh for bridge $BRIDGE_ID. Holds no secrets: the token
# is read from a file and the dashboard credentials come from the unit's
# environment file.
bindAddr = "0.0.0.0"
bindPort = $CONTROL_PORT
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "$TOKEN_FILE"
transport.tls.force = true
transport.tls.certFile = "$CERT_FILE"
transport.tls.keyFile = "$KEY_FILE"
webServer.addr = "127.0.0.1"
webServer.port = $DASH_PORT
webServer.user = "{{ .Envs.FRPS_DASHBOARD_USER }}"
webServer.password = "{{ .Envs.FRPS_DASHBOARD_PASSWORD }}"

[[allowPorts]]
start = $UDP_START
end = $UDP_END
CONF_EOF
}
unit_body() {
  cat <<UNIT_EOF
[Unit]
Description=Amnezia frps bridge server
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$DASH_ENV_FILE
ExecStart=$FRPS_BIN -c $CONF
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT_EOF
}

TMP_CONF_RENDER="$(mktemp)"
TMP_UNIT_RENDER="$(mktemp)"
trap 'rm -f "$TMP_CONF_RENDER" "$TMP_UNIT_RENDER"' EXIT INT TERM
render_config >"$TMP_CONF_RENDER"
unit_body >"$TMP_UNIT_RENDER"

conf_same=0
[ -f "$CONF" ] && cmp -s "$TMP_CONF_RENDER" "$CONF" && conf_same=1
unit_same=0
[ -f "$UNIT_FILE" ] && cmp -s "$TMP_UNIT_RENDER" "$UNIT_FILE" && unit_same=1

print_firewall() {
  info "firewall rules to apply yourself (this script changes none):"
  info "  TCP $CONTROL_PORT: allow only the trusted node source addresses (frpc control connections)"
  info "  UDP $UDP_START-$UDP_END: open to VPN clients"
  info "  TCP $DASH_PORT: keep closed; the frps dashboard listens on 127.0.0.1 only"
}

if [ "$DRY_RUN" -eq 1 ]; then
  [ -x "$FRPS_BIN" ] && [ "$("$FRPS_BIN" --version 2>/dev/null)" = "$FRP_VERSION" ] &&
    plan "frps $FRP_VERSION already installed at $FRPS_BIN" ||
    plan "download frp v$FRP_VERSION, verify its pinned SHA-256 and install $FRPS_BIN"
  [ -f "$DASH_ENV_FILE" ] && plan "keep dashboard credentials $DASH_ENV_FILE" ||
    plan "generate dashboard credentials in $DASH_ENV_FILE (mode 0600)"
  [ "$conf_same" -eq 1 ] && plan "config $CONF is current" ||
    plan "write $CONF (frps verify before the atomic move): control tcp $CONTROL_PORT, allowPorts $UDP_START-$UDP_END, dashboard 127.0.0.1:$DASH_PORT"
  [ "$unit_same" -eq 1 ] && plan "unit $UNIT_FILE is current" || plan "write $UNIT_FILE"
  if [ "$active" -eq 1 ] && [ "$conf_same" -eq 1 ]; then
    plan "no change: $UNIT is already active"
  else
    plan "enable and start $UNIT, then confirm the control listener on tcp $CONTROL_PORT"
  fi
  print_firewall
  info "dry run: nothing was written, downloaded or started"
  exit 0
fi

# BEGIN frp-fetch (keep identical in infra/bridge/install-frps.sh)
ensure_binary() {
  name="$1"
  dest="$FRP_PREFIX/$FRP_VERSION/$name"
  if [ -x "$dest" ] && [ "$("$dest" --version 2>/dev/null)" = "$FRP_VERSION" ]; then
    return 0
  fi
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64; sum="$FRP_SHA256_AMD64" ;;
    aarch64|arm64) arch=arm64; sum="$FRP_SHA256_ARM64" ;;
    *) die 12 E_FETCH "unsupported CPU architecture $(uname -m); frp is pinned for amd64 and arm64" ;;
  esac
  archive="frp_${FRP_VERSION}_linux_${arch}.tar.gz"
  mkdir -p "$FRP_PREFIX/$FRP_VERSION"
  fetch_dir="$(mktemp -d "$FRP_PREFIX/.fetch.XXXXXX")"
  curl -fsSL --proto '=https' --max-time 180 -o "$fetch_dir/$archive" "$FRP_RELEASE_URL/$archive" ||
    { rm -rf "$fetch_dir"; die 12 E_FETCH "download of $archive failed"; }
  if ! (cd "$fetch_dir" && printf '%s  %s\n' "$sum" "$archive" | sha256sum -c - >/dev/null 2>&1); then
    rm -rf "$fetch_dir"
    die 12 E_FETCH "SHA-256 mismatch for $archive; nothing was installed"
  fi
  tar -xzf "$fetch_dir/$archive" -C "$fetch_dir" --strip-components=1 "frp_${FRP_VERSION}_linux_${arch}/$name" ||
    { rm -rf "$fetch_dir"; die 12 E_FETCH "cannot extract $name from $archive"; }
  install -m 0755 "$fetch_dir/$name" "$dest.new"
  mv -f "$dest.new" "$dest"
  rm -rf "$fetch_dir"
  info "installed $name $FRP_VERSION at $dest"
}
# END frp-fetch

ensure_binary frps

mkdir -p "$FRP_DIR"
if [ ! -f "$DASH_ENV_FILE" ]; then
  # Alphanumeric only, so the file is safe to source and to pass to systemd.
  dash_pass="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 || true)"
  [ "${#dash_pass}" -eq 32 ] || die 11 E_FILE "cannot generate dashboard credentials"
  old_umask="$(umask)"
  umask 077
  printf 'FRPS_DASHBOARD_USER=amnezia-bridge\nFRPS_DASHBOARD_PASSWORD=%s\n' "$dash_pass" >"$DASH_ENV_FILE"
  umask "$old_umask"
  chmod 0600 "$DASH_ENV_FILE"
  dash_pass=""
fi

TMP_CONF="$(mktemp "$FRP_DIR/.frps.XXXXXX")"
trap 'rm -f "$TMP_CONF_RENDER" "$TMP_UNIT_RENDER" "$TMP_CONF"' EXIT INT TERM
cp "$TMP_CONF_RENDER" "$TMP_CONF"
chmod 0644 "$TMP_CONF"
# The config references the dashboard credentials as environment templates.
if ! (set -a; . "$DASH_ENV_FILE"; set +a; "$FRPS_BIN" verify -c "$TMP_CONF") >/dev/null 2>&1; then
  die 13 E_CONFIG_INVALID "frps verify rejected the generated config; the previous config and unit are untouched"
fi

if [ "$conf_same" -eq 1 ] && [ "$unit_same" -eq 1 ] && [ "$active" -eq 1 ] && [ "$enabled" -eq 1 ]; then
  info "frps already configured and running for bridge $BRIDGE_ID: no change"
  print_firewall
  exit 0
fi

had_conf=0
[ -f "$CONF" ] && had_conf=1
BACKUP=""
if [ "$had_conf" -eq 1 ]; then
  BACKUP="$(mktemp "$FRP_DIR/.frps.backup.XXXXXX")"
  cp -p "$CONF" "$BACKUP"
fi
trap 'rm -f "$TMP_CONF_RENDER" "$TMP_UNIT_RENDER" "$TMP_CONF" "$BACKUP"' EXIT INT TERM

if [ "$unit_same" -eq 0 ]; then
  mkdir -p "$SYSTEMD_DIR"
  TMP_UNIT="$(mktemp "$SYSTEMD_DIR/.amnezia-frps.XXXXXX")"
  cp "$TMP_UNIT_RENDER" "$TMP_UNIT"
  chmod 0644 "$TMP_UNIT"
  mv -f "$TMP_UNIT" "$UNIT_FILE"
fi
mv -f "$TMP_CONF" "$CONF"
printf '%s\n' "$BRIDGE_ID" >"$BRIDGE_ID_FILE"
chmod 0644 "$BRIDGE_ID_FILE"
systemctl daemon-reload

rollback() {
  if [ "$had_conf" -eq 1 ]; then
    mv -f "$BACKUP" "$CONF"
    systemctl restart "$UNIT" >/dev/null 2>&1 || true
  else
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$CONF" "$BRIDGE_ID_FILE"
  fi
}

if [ "$active" -eq 1 ]; then
  systemctl restart "$UNIT" || { rollback; die 50 E_START "systemctl restart $UNIT failed; previous config restored"; }
else
  systemctl enable --now "$UNIT" >/dev/null 2>&1 || { rollback; die 50 E_START "systemctl enable --now $UNIT failed; change rolled back"; }
fi

unit_active "$UNIT" || { rollback; die 50 E_START "$UNIT is not active after start"; }
after="$(ss -H -ltn 2>/dev/null || true)"
printf '%s\n' "$after" | awk '{n=split($4,a,":"); print a[n]}' | grep -qx "$CONTROL_PORT" ||
  { rollback; die 50 E_START "frps is active but nothing listens on tcp $CONTROL_PORT"; }
printf '%s\n' "$after" | awk '$4 == "127.0.0.1:'"$DASH_PORT"'" {found=1} END {exit !found}' ||
  { rollback; die 50 E_START "frps dashboard is not listening on 127.0.0.1:$DASH_PORT"; }
info "frps running for bridge $BRIDGE_ID: control tcp $CONTROL_PORT, pool udp $UDP_START-$UDP_END"
info "dashboard API: 127.0.0.1:$DASH_PORT, credentials in $DASH_ENV_FILE"
print_firewall
