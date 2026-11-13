#!/bin/sh
# Install (or remove) one frpc route on an AWG node host.
#
#   install-frpc.sh --route-id <uuid> --bridge-ip <ipv4> --control-port <tcp>
#       --public-port <udp> [--local-udp-port <udp>] [--local-ip <ipv4>] [--dry-run]
#   install-frpc.sh --remove --route-id <uuid> [--dry-run]
#
# One frpc process per route: unit amnezia-frpc@<route-id>.service from the
# shared template amnezia-frpc@.service, config <etc>/amnezia-node/frpc/<route-id>.toml.
# frpc forwards the bridge's public UDP port to this host's published AWG 3.1
# listener (Docker container amnezia-awg3, container port 51890/udp). The AWG and
# node-agent services are never touched.
#
# Secrets stay out of arguments and out of the config: the shared bridge token
# and the bridge CA come from protected files that the operator places through a
# trusted channel before running this script:
#   /etc/amnezia-node/frp/token    mode 0600, owned by the running user (root)
#   /etc/amnezia-node/frp/ca.crt   mode 0644 (not group/world writable)
# The bridge's frps certificate must carry the bridge IP as a SAN: frpc verifies
# it against ca.crt with serverName = <bridge-ip>.
#
# A dry run reads the real Docker mapping, unit and config state and prints the
# planned changes (PLAN: lines); it writes, downloads and starts nothing. Without
# --dry-run the config is rendered to a temp file, checked with `frpc verify`,
# and only then moved into place atomically before the unit is enabled. A failure
# restores the previous config and unit state.
#
# Exit codes (the message names the field or observed value):
#    0  success, or a repeat with the same inputs (no new route)
#    2  invalid arguments
#   11  token or CA file missing or has unsafe mode/owner
#   12  frp download or SHA-256 check failed (nothing installed)
#   13  frpc verify rejected the generated config (previous config untouched)
#   20  conflict with an existing config/unit (the conflicting field is named)
#   21  the public port is already held by another route on this host
#   30  missing local AWG publication (container absent or no UDP publication)
#   31  ambiguous local AWG publication (several IPv4 UDP publications)
#   32  IPv6-only local AWG publication
#   33  local target mismatch, or --local-ip required for a specific bind
#   34  AWG container is not running and healthy
#   40  control TCP unreachable from this host (bridge firewall or port)
#   41  frp authentication or TLS verification failed
#   42  frps refused the UDP registration (port not allowed or already used)
#   50  service did not start or did not register in time
# Not detectable on the host, reported elsewhere:
#   exhausted bridge pool (panel API: BRIDGE_POOL_EXHAUSTED) and no AWG handshake
#   from the probe network (panel verification result).
#
# Test seams (not for operators): AMNEZIA_ETC, AMNEZIA_SYSTEMD_DIR,
# AMNEZIA_FRP_PREFIX, AMNEZIA_ALLOW_NONROOT, AMNEZIA_REGISTER_WAIT.
set -eu

ETC="${AMNEZIA_ETC:-/etc}"
SYSTEMD_DIR="${AMNEZIA_SYSTEMD_DIR:-/etc/systemd/system}"
FRP_PREFIX="${AMNEZIA_FRP_PREFIX:-/opt/amnezia-frp}"
REGISTER_WAIT="${AMNEZIA_REGISTER_WAIT:-20}"
SECRET_DIR="$ETC/amnezia-node/frp"
TOKEN_FILE="$SECRET_DIR/token"
CA_FILE="$SECRET_DIR/ca.crt"
CONF_DIR="$ETC/amnezia-node/frpc"
TEMPLATE_UNIT="$SYSTEMD_DIR/amnezia-frpc@.service"
AWG_CONTAINER=amnezia-awg3
AWG_CONTAINER_PORT=51890

# BEGIN frp-pin (identical in infra/bridge/install-frps.sh and infra/node/scripts/install-frpc.sh)
FRP_VERSION=0.72.0
FRP_RELEASE_URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}"
# SHA-256 from the official frp_sha256_checksums.txt of release v0.72.0.
FRP_SHA256_AMD64=daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804
FRP_SHA256_ARM64=02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf
# END frp-pin

TMP_CONF_RENDER=""
TMP_TEMPLATE_RENDER=""
TMP_CONF=""
BACKUP=""
cleanup() { rm -f -- "$TMP_CONF_RENDER" "$TMP_TEMPLATE_RENDER" "$TMP_CONF" "$BACKUP"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

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

ROUTE_ID=""
BRIDGE_IP=""
CONTROL_PORT=""
PUBLIC_PORT=""
LOCAL_UDP_PORT=""
LOCAL_IP=""
DRY_RUN=0
REMOVE=0

need_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --route-id) need_value "$@"; ROUTE_ID="$2"; shift 2 ;;
    --bridge-ip) need_value "$@"; BRIDGE_IP="$2"; shift 2 ;;
    --control-port) need_value "$@"; CONTROL_PORT="$2"; shift 2 ;;
    --public-port) need_value "$@"; PUBLIC_PORT="$2"; shift 2 ;;
    --local-udp-port) need_value "$@"; LOCAL_UDP_PORT="$2"; shift 2 ;;
    --local-ip) need_value "$@"; LOCAL_IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --remove) REMOVE=1; shift ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

is_uuid() {
  case "$1" in
    *[!0-9a-f-]*) return 1 ;;
  esac
  [ "${#1}" -eq 36 ] || return 1
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}
is_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || return 1
  old_ifs="$IFS"
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS="$old_ifs"
  for octet in "$@"; do
    [ "$octet" -le 255 ] || return 1
  done
}

is_uuid "$ROUTE_ID" || usage_error "--route-id must be a lowercase UUID"
if [ "$REMOVE" -eq 0 ]; then
  is_ipv4 "$BRIDGE_IP" || usage_error "--bridge-ip must be an IPv4 address"
  is_port "$CONTROL_PORT" || usage_error "--control-port must be a TCP port (1-65535)"
  is_port "$PUBLIC_PORT" || usage_error "--public-port must be a UDP port (1-65535)"
  [ -z "$LOCAL_UDP_PORT" ] || is_port "$LOCAL_UDP_PORT" || usage_error "--local-udp-port must be a UDP port (1-65535)"
  [ -z "$LOCAL_IP" ] || is_ipv4 "$LOCAL_IP" || usage_error "--local-ip must be an IPv4 address"
else
  [ -z "$BRIDGE_IP$CONTROL_PORT$PUBLIC_PORT$LOCAL_UDP_PORT$LOCAL_IP" ] ||
    usage_error "--remove takes only --route-id and --dry-run"
fi

UNIT="amnezia-frpc@${ROUTE_ID}.service"
CONF="$CONF_DIR/$ROUTE_ID.toml"
FRPC_BIN="$FRP_PREFIX/$FRP_VERSION/frpc"

if [ "$DRY_RUN" -eq 0 ] && [ "${AMNEZIA_ALLOW_NONROOT:-0}" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  die 2 E_USAGE "run as root (or use --dry-run to only read state)"
fi

unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
unit_enabled() { systemctl is-enabled --quiet "$1" 2>/dev/null; }

# ---- removal ---------------------------------------------------------------
if [ "$REMOVE" -eq 1 ]; then
  have_conf=0
  [ -f "$CONF" ] && have_conf=1
  active=0
  unit_active "$UNIT" && active=1
  enabled=0
  unit_enabled "$UNIT" && enabled=1
  if [ "$have_conf" -eq 0 ] && [ "$active" -eq 0 ] && [ "$enabled" -eq 0 ]; then
    info "route $ROUTE_ID: nothing to remove"
    exit 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "stop and disable $UNIT (active=$active enabled=$enabled)"
    plan "remove $CONF (present=$have_conf)"
    plan "keep the shared template, the frpc binary, $TOKEN_FILE and $CA_FILE"
    exit 0
  fi
  systemctl stop "$UNIT" 2>/dev/null || true
  systemctl disable "$UNIT" 2>/dev/null || true
  rm -f "$CONF"
  info "route $ROUTE_ID removed: $UNIT stopped and disabled, config deleted"
  exit 0
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
  # A non-root dry run only reads state, so it may not own root's files.
  [ "$DRY_RUN" -eq 1 ] || [ "$(stat -c %u "$1")" = "$(id -u)" ] ||
    die 11 E_FILE "$1 must be owned by the user running this script (root)"
}
check_public_file() {
  [ -f "$1" ] || die 11 E_FILE "missing file $1 (the bridge CA certificate)"
  mode="$(file_mode "$1")"
  [ "$((0$mode & 022))" -eq 0 ] || die 11 E_FILE "$1 has mode $mode, expected 0644"
}
check_secret_file "$TOKEN_FILE"
check_public_file "$CA_FILE"

# ---- local AWG target ------------------------------------------------------
detect_local_target() {
  command -v docker >/dev/null 2>&1 || die 30 E_NO_PUBLICATION "docker is not available on this host"
  ports_out="$(docker port "$AWG_CONTAINER" 2>/dev/null)" ||
    die 30 E_NO_PUBLICATION "container $AWG_CONTAINER not found or has no published ports; expected ${AWG_CONTAINER_PORT}/udp published"
  observed="$(printf '%s\n' "$ports_out" | sed -n "s|^${AWG_CONTAINER_PORT}/udp -> ||p")"
  [ -n "$observed" ] ||
    die 30 E_NO_PUBLICATION "no ${AWG_CONTAINER_PORT}/udp publication on $AWG_CONTAINER (observed: $(printf '%s' "$ports_out" | tr '\n' ';')); expected ${AWG_CONTAINER_PORT}/udp published to an IPv4 address"
  v4_count=0
  v4_binding=""
  v6_count=0
  while IFS= read -r binding; do
    [ -n "$binding" ] || continue
    case "$binding" in
      *:*:*|\[*) v6_count=$((v6_count + 1)) ;;
      *) v4_count=$((v4_count + 1)); v4_binding="$binding" ;;
    esac
  done <<OBSERVED
$observed
OBSERVED
  if [ "$v4_count" -eq 0 ]; then
    die 32 E_IPV6_ONLY "${AWG_CONTAINER_PORT}/udp is published on IPv6 only (observed: $(printf '%s' "$observed" | tr '\n' ' ')); expected an IPv4 publication"
  fi
  if [ "$v4_count" -gt 1 ]; then
    die 31 E_AMBIGUOUS "${v4_count} IPv4 publications of ${AWG_CONTAINER_PORT}/udp (observed: $(printf '%s' "$observed" | tr '\n' ' ')); expected exactly one"
  fi
  bind_ip="${v4_binding%:*}"
  bind_port="${v4_binding##*:}"
  if ! is_ipv4 "$bind_ip" || ! is_port "$bind_port"; then
    die 31 E_AMBIGUOUS "cannot parse publication '$v4_binding'"
  fi

  health="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$AWG_CONTAINER" 2>/dev/null || true)"
  [ "$health" = "running healthy" ] ||
    die 34 E_AWG_UNHEALTHY "$AWG_CONTAINER is not running and healthy (observed: ${health:-unknown})"

  expected_ip=""
  case "$bind_ip" in
    0.0.0.0) expected_ip=127.0.0.1 ;;
    127.*) expected_ip="$bind_ip" ;;
  esac
  if [ -z "$expected_ip" ]; then
    [ -n "$LOCAL_IP" ] ||
      die 33 E_LOCAL_TARGET "$AWG_CONTAINER publishes ${AWG_CONTAINER_PORT}/udp only on $bind_ip:$bind_port; pass --local-ip $bind_ip"
    expected_ip="$bind_ip"
  fi
  if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "$expected_ip" ]; then
    die 33 E_LOCAL_TARGET "field --local-ip is $LOCAL_IP but the observed mapping $bind_ip:$bind_port/udp needs $expected_ip"
  fi
  if [ -n "$LOCAL_UDP_PORT" ] && [ "$LOCAL_UDP_PORT" != "$bind_port" ]; then
    die 33 E_LOCAL_TARGET "field --local-udp-port is $LOCAL_UDP_PORT but the observed host UDP port is $bind_port"
  fi
  LOCAL_TARGET_IP="$expected_ip"
  LOCAL_TARGET_PORT="$bind_port"
}
detect_local_target
info "local AWG target: $LOCAL_TARGET_IP:$LOCAL_TARGET_PORT/udp (observed binding $bind_ip:$bind_port, $AWG_CONTAINER healthy)"

# ---- existing state and conflicts -----------------------------------------
conf_field() { sed -n "s/^$1 = \"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$2" | head -n 1; }

render_config() {
  cat <<CONF_EOF
# Managed by install-frpc.sh for route $ROUTE_ID. Holds no secrets.
serverAddr = "$BRIDGE_IP"
serverPort = $CONTROL_PORT
loginFailExit = true
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "$TOKEN_FILE"
transport.tls.enable = true
transport.tls.trustedCaFile = "$CA_FILE"
transport.tls.serverName = "$BRIDGE_IP"

[[proxies]]
name = "awg-route-$ROUTE_ID"
type = "udp"
localIP = "$LOCAL_TARGET_IP"
localPort = $LOCAL_TARGET_PORT
remotePort = $PUBLIC_PORT
CONF_EOF
}

check_conflicts() {
  if [ -f "$CONF" ]; then
    for pair in "serverAddr:bridge-ip:$BRIDGE_IP" "serverPort:control-port:$CONTROL_PORT" \
      "remotePort:public-port:$PUBLIC_PORT" "localIP:local-ip:$LOCAL_TARGET_IP" \
      "localPort:local-udp-port:$LOCAL_TARGET_PORT"; do
      key="${pair%%:*}"
      rest="${pair#*:}"
      flag="${rest%%:*}"
      want="${rest#*:}"
      have="$(conf_field "$key" "$CONF")"
      [ "$have" = "$want" ] ||
        die 20 E_CONFLICT "route $ROUTE_ID already has $CONF with $key=$have, requested --$flag $want (run --remove first to change it)"
    done
  fi
  for other in "$CONF_DIR"/*.toml; do
    [ -f "$other" ] || continue
    [ "$other" != "$CONF" ] || continue
    if [ "$(conf_field serverAddr "$other")" = "$BRIDGE_IP" ] &&
      [ "$(conf_field remotePort "$other")" = "$PUBLIC_PORT" ]; then
      die 21 E_PORT_HELD "--public-port $PUBLIC_PORT on bridge $BRIDGE_IP is already held by route $(basename "$other" .toml)"
    fi
  done
}
check_conflicts

TMP_CONF_RENDER="$(mktemp)"
render_config >"$TMP_CONF_RENDER"

template_body() {
  cat <<UNIT_EOF
[Unit]
Description=Amnezia frpc route %i
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$FRPC_BIN -c $CONF_DIR/%i.toml
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
TMP_TEMPLATE_RENDER="$(mktemp)"
template_body >"$TMP_TEMPLATE_RENDER"

binary_ok() { [ -x "$FRPC_BIN" ] && [ "$("$FRPC_BIN" --version 2>/dev/null)" = "$FRP_VERSION" ]; }
conf_same=0
[ -f "$CONF" ] && cmp -s "$TMP_CONF_RENDER" "$CONF" && conf_same=1
template_same=0
[ -f "$TEMPLATE_UNIT" ] && cmp -s "$TMP_TEMPLATE_RENDER" "$TEMPLATE_UNIT" && template_same=1
active=0
unit_active "$UNIT" && active=1
enabled=0
unit_enabled "$UNIT" && enabled=1

if [ "$DRY_RUN" -eq 1 ]; then
  existing="$(find "$CONF_DIR" -maxdepth 1 -name '*.toml' 2>/dev/null | sed -n 's|.*/\(.*\)\.toml$|\1|p' | tr '\n' ' ')"
  info "existing frpc routes on this host: ${existing:-none}"
  listed="$(systemctl list-units --all --plain --no-legend 'amnezia-frpc@*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ' || true)"
  info "existing frpc units: ${listed:-none}"
  if binary_ok; then
    plan "frpc $FRP_VERSION already installed at $FRPC_BIN"
  else
    plan "download frp v$FRP_VERSION, verify its pinned SHA-256 and install $FRPC_BIN"
  fi
  if [ "$template_same" -eq 1 ]; then
    plan "template unit $TEMPLATE_UNIT is current"
  else
    plan "write template unit $TEMPLATE_UNIT"
  fi
  if [ "$conf_same" -eq 1 ]; then
    plan "config $CONF is current"
  else
    plan "write $CONF (frpc verify before the atomic move): $BRIDGE_IP:$CONTROL_PORT, proxy awg-route-$ROUTE_ID udp $LOCAL_TARGET_IP:$LOCAL_TARGET_PORT -> remote $PUBLIC_PORT"
  fi
  if [ "$active" -eq 1 ] && [ "$conf_same" -eq 1 ]; then
    plan "no change: $UNIT is already active"
  else
    plan "enable and start $UNIT, then wait for frps registration"
  fi
  plan "check control TCP $BRIDGE_IP:$CONTROL_PORT is reachable (skipped in a dry run)"
  info "dry run: nothing was written, downloaded or started"
  exit 0
fi

# ---- install ---------------------------------------------------------------
# A same-input repeat changes nothing and must not depend on the network.
if [ "$conf_same" -eq 1 ] && [ "$template_same" -eq 1 ] && [ "$active" -eq 1 ] && [ "$enabled" -eq 1 ]; then
  info "route $ROUTE_ID already configured and running: no change"
  exit 0
fi

# BEGIN frp-fetch (identical in infra/bridge/install-frps.sh and infra/node/scripts/install-frpc.sh)
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

control_reachable() {
  command -v nc >/dev/null 2>&1 || { info "nc not found: control TCP pre-check skipped"; return 0; }
  nc -z -w 5 "$BRIDGE_IP" "$CONTROL_PORT" >/dev/null 2>&1
}
control_reachable ||
  die 40 E_CONTROL_UNREACHABLE "cannot open TCP $BRIDGE_IP:$CONTROL_PORT from this host; allow this node's source address to the bridge control port in the host and cloud firewall"

ensure_binary frpc

mkdir -p "$CONF_DIR"
TMP_CONF="$(mktemp "$CONF_DIR/.$ROUTE_ID.XXXXXX")"
cp "$TMP_CONF_RENDER" "$TMP_CONF"
chmod 0644 "$TMP_CONF"
verify_out="$("$FRPC_BIN" verify -c "$TMP_CONF" 2>&1)" ||
  die 13 E_CONFIG_INVALID "frpc verify rejected the generated config (previous config and unit untouched): $verify_out"

had_conf=0
[ -f "$CONF" ] && had_conf=1
if [ "$had_conf" -eq 1 ]; then
  BACKUP="$(mktemp "$CONF_DIR/.$ROUTE_ID.backup.XXXXXX")"
  cp -p "$CONF" "$BACKUP"
fi

if [ "$template_same" -eq 0 ]; then
  mkdir -p "$SYSTEMD_DIR"
  TMP_UNIT="$(mktemp "$SYSTEMD_DIR/.amnezia-frpc.XXXXXX")"
  cp "$TMP_TEMPLATE_RENDER" "$TMP_UNIT"
  chmod 0644 "$TMP_UNIT"
  mv -f "$TMP_UNIT" "$TEMPLATE_UNIT"
fi
mv -f "$TMP_CONF" "$CONF"
systemctl daemon-reload
started_at="$(date '+%Y-%m-%d %H:%M:%S')"

rollback() {
  if [ "$had_conf" -eq 1 ]; then
    mv -f "$BACKUP" "$CONF"
    if [ "$active" -eq 1 ]; then
      systemctl restart "$UNIT" >/dev/null 2>&1 || true
    elif [ "$enabled" -eq 1 ]; then
      systemctl stop "$UNIT" >/dev/null 2>&1 || true
    else
      systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    fi
  else
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$CONF"
  fi
}

if [ "$active" -eq 1 ]; then
  systemctl enable "$UNIT" >/dev/null 2>&1 || true
  systemctl restart "$UNIT" || { rollback; die 50 E_START "systemctl restart $UNIT failed; previous config restored"; }
else
  systemctl enable --now "$UNIT" >/dev/null 2>&1 || { rollback; die 50 E_START "systemctl enable --now $UNIT failed; change rolled back"; }
fi

# Read frpc's own log until it either registers the proxy or says why not.
waited=0
while :; do
  log="$(journalctl -u "$UNIT" --since "$started_at" --no-pager -o cat 2>/dev/null | tail -n 60 || true)"
  case "$log" in
    *"start proxy success"*) break ;;
    *"token"*"doesn't match"*|*"authentication failed"*|*x509*|*"tls: "*)
      rollback
      die 41 E_AUTH_TLS "frp authentication or TLS verification failed; check the token file, the bridge CA and that the frps certificate has SAN $BRIDGE_IP"
      ;;
    *"port already used"*|*"port not allowed"*|*"start error"*)
      rollback
      die 42 E_UDP_REGISTRATION "frps refused UDP registration of port $PUBLIC_PORT (port not allowed or already used on the bridge)"
      ;;
    *"connection refused"*|*"i/o timeout"*|*"no route to host"*)
      rollback
      die 40 E_CONTROL_UNREACHABLE "frpc cannot reach $BRIDGE_IP:$CONTROL_PORT"
      ;;
  esac
  if [ "$waited" -ge "$REGISTER_WAIT" ]; then
    rollback
    die 50 E_START "frpc did not register the proxy within ${REGISTER_WAIT}s"
  fi
  sleep 1
  waited=$((waited + 1))
done

unit_active "$UNIT" || { rollback; die 50 E_START "$UNIT is not active after start"; }
info "route $ROUTE_ID registered: bridge $BRIDGE_IP udp $PUBLIC_PORT -> $LOCAL_TARGET_IP:$LOCAL_TARGET_PORT"
info "next: run the panel's AWG handshake verification for this route"
