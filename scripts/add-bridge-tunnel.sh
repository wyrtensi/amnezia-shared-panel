#!/bin/sh
# Open the supervised panel -> bridge-agent management tunnel. Run it ON THE
# PANEL HOST, as root, after infra/bridge/install-bridge.sh has finished on the
# bridge host.
#
#   add-bridge-tunnel.sh --bridge-id <uuid> --bridge-host <ipv4>
#       --host-key-fingerprint <SHA256:...> [--ssh-user root] [--ssh-key <path>]
#       [--agent-port 7600] [--dry-run]
#
# It follows the node pattern of scripts/add-node.sh and docs/NODE-CONNECT.md:
# an autossh unit named panel-tunnel-bridge-<bridge-id> forwards
# <TUNNEL_BIND>:<port> on the panel host to the agent's loopback listener on the
# bridge, and the panel reaches it as http://host.docker.internal:<port>. The
# port is the first free one at or above TUNNEL_PORT_BASE after skipping every
# -L port of every panel-tunnel-*.service unit and every listening socket, the
# same collision domain as the node tunnels. An existing unit keeps its port.
#
# Unlike the node tunnels, the host key is pinned: the script scans the bridge's
# ed25519 host key, compares its fingerprint with the one the installer printed
# and only then writes a dedicated known_hosts file the unit uses with
# StrictHostKeyChecking=yes. A mismatch aborts before anything is written.
#
# It prints the management URL and the enrollment command. The agent token is
# never read or printed here: the command pipes it from the bridge host into
# the CLI's stdin.
#
# Settings (environment, same names as scripts/add-node.env): TUNNEL_BIND
# (an IPv4 literal, default 172.17.0.1; 0.0.0.0 is refused), TUNNEL_PORT_BASE
# (default 4105), PANEL_NODE_KEY (default /root/.ssh/panel_nodes_key, used when
# --ssh-key is not given). The printed enroll command also reads
# PANEL_COMPOSE_DIR (default /opt/amnezia-panel/infra/prod),
# PANEL_CONTROL_API_SERVICE (default control-api) and PANEL_CONTROL_API_URL
# (default http://127.0.0.1:3001).
#
# Exit codes: 0 ok, 2 bad arguments, 40 host key scan failed or fingerprint
# mismatch, 41 autossh missing, 42 the tunnel does not reach the agent.
#
# Test seams (not for operators): AMNEZIA_SYSTEMD_DIR, AMNEZIA_PANEL_ETC,
# AMNEZIA_ALLOW_NONROOT, AMNEZIA_TUNNEL_WAIT.
set -eu

SYSTEMD_DIR="${AMNEZIA_SYSTEMD_DIR:-/etc/systemd/system}"
PANEL_ETC="${AMNEZIA_PANEL_ETC:-/etc/amnezia-panel}"
WAIT="${AMNEZIA_TUNNEL_WAIT:-30}"
BIND="${TUNNEL_BIND:-172.17.0.1}"
BASE="${TUNNEL_PORT_BASE:-4105}"
COMPOSE_DIR="${PANEL_COMPOSE_DIR:-/opt/amnezia-panel/infra/prod}"
CONTROL_SERVICE="${PANEL_CONTROL_API_SERVICE:-control-api}"
CONTROL_URL="${PANEL_CONTROL_API_URL:-http://127.0.0.1:3001}"

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
BRIDGE_HOST=""
FINGERPRINT=""
SSH_USER=root
SSH_KEY="${PANEL_NODE_KEY:-/root/.ssh/panel_nodes_key}"
AGENT_PORT=7600
DRY_RUN=0

need_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bridge-id) need_value "$@"; BRIDGE_ID="$2"; shift 2 ;;
    --bridge-host) need_value "$@"; BRIDGE_HOST="$2"; shift 2 ;;
    --host-key-fingerprint) need_value "$@"; FINGERPRINT="$2"; shift 2 ;;
    --ssh-user) need_value "$@"; SSH_USER="$2"; shift 2 ;;
    --ssh-key) need_value "$@"; SSH_KEY="$2"; shift 2 ;;
    --agent-port) need_value "$@"; AGENT_PORT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

printf '%s' "$BRIDGE_ID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
  usage_error "--bridge-id must be a lowercase UUID"
printf '%s' "$BRIDGE_HOST" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' ||
  usage_error "--bridge-host must be the bridge's IPv4 address"
printf '%s' "$FINGERPRINT" | grep -Eq '^SHA256:[A-Za-z0-9+/]+$' ||
  usage_error "--host-key-fingerprint must look like SHA256:... (the installer prints it)"
printf '%s' "$SSH_USER" | grep -Eq '^[a-z_][a-z0-9_-]*$' || usage_error "--ssh-user is not a valid user name"
case "$AGENT_PORT" in ''|*[!0-9]*) usage_error "--agent-port must be a TCP port" ;; esac
[ "$AGENT_PORT" -ge 1 ] && [ "$AGENT_PORT" -le 65535 ] || usage_error "--agent-port must be a TCP port"
printf '%s' "$BIND" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' ||
  usage_error "TUNNEL_BIND must be an IPv4 literal (the Docker bridge gateway), got '$BIND'"
[ "$BIND" != 0.0.0.0 ] || usage_error "TUNNEL_BIND must not be 0.0.0.0: the forward would be reachable from every interface"
case "$BASE" in ''|*[!0-9]*) usage_error "TUNNEL_PORT_BASE must be a port number" ;; esac
printf '%s' "$SSH_KEY" | grep -Eq '^/[A-Za-z0-9._/-]+$' || usage_error "--ssh-key must be an absolute path without spaces"

if [ "$DRY_RUN" -eq 0 ] && [ "${AMNEZIA_ALLOW_NONROOT:-0}" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  die 2 E_USAGE "run as root (or use --dry-run to only read state)"
fi

UNIT="panel-tunnel-bridge-$BRIDGE_ID"
UNIT_FILE="$SYSTEMD_DIR/$UNIT.service"
KNOWN_HOSTS="$PANEL_ETC/bridge-known-hosts/$BRIDGE_ID"

# The same allocator as scripts/add-node.sh, in the same collision domain:
# reuse this unit's port, else the first port at or above the base that no
# panel-tunnel-*.service forwards and nothing listens on.
allocate_port() {
  if [ -f "$UNIT_FILE" ]; then
    # BIND is a validated IPv4 literal; its dots are escaped for the regex.
    bind_re="$(printf '%s' "$BIND" | sed 's/\./\\./g')"
    sed -n "s|.* -L ${bind_re}:\([0-9][0-9]*\):.*|\1|p" "$UNIT_FILE" | head -n 1
    return 0
  fi
  units_ports="$(grep -hoE -- '-L [0-9.]+:[0-9]+:' "$SYSTEMD_DIR"/panel-tunnel-*.service 2>/dev/null | cut -d: -f2 || true)"
  open_ports="$(ss -H -ltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' || true)"
  used="$(printf '%s\n%s\n' "$units_ports" "$open_ports" | sort -un)"
  port="$BASE"
  while printf '%s\n' "$used" | grep -qx "$port"; do port=$((port + 1)); done
  echo "$port"
}
PORT="$(allocate_port)"
[ -n "$PORT" ] || die 2 E_USAGE "could not allocate a tunnel port"

if [ "$DRY_RUN" -eq 1 ]; then
  plan "scan the ed25519 host key of $BRIDGE_HOST and require fingerprint $FINGERPRINT"
  plan "write $KNOWN_HOSTS (the only key this tunnel trusts)"
  plan "write $UNIT_FILE: autossh -L $BIND:$PORT:127.0.0.1:$AGENT_PORT $SSH_USER@$BRIDGE_HOST, StrictHostKeyChecking=yes"
  plan "enable and start $UNIT, then check http://$BIND:$PORT/healthz"
  info "dry run: nothing was written or started"
  exit 0
fi

command -v autossh >/dev/null 2>&1 || die 41 E_AUTOSSH "autossh is not installed on the panel host (apt-get install autossh)"

scanned="$(ssh-keyscan -t ed25519 -T 10 "$BRIDGE_HOST" 2>/dev/null || true)"
[ -n "$scanned" ] || die 40 E_HOSTKEY "could not read the ed25519 host key of $BRIDGE_HOST"
found="$(printf '%s\n' "$scanned" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' | head -n 1)"
[ "$found" = "$FINGERPRINT" ] ||
  die 40 E_HOSTKEY "host key of $BRIDGE_HOST is ${found:-unreadable}, expected $FINGERPRINT; nothing was written"

mkdir -p "$PANEL_ETC/bridge-known-hosts"
printf '%s\n' "$scanned" >"$KNOWN_HOSTS"
chmod 0644 "$KNOWN_HOSTS"

cat >"$UNIT_FILE" <<UNITFILE
[Unit]
Description=Panel -> bridge-agent tunnel ($BRIDGE_ID)
After=network-online.target docker.service
Wants=network-online.target

[Service]
# Without this, autossh gives up for good if the first connection dies within
# 30 s, which is what happens when the bridge is down while the panel boots.
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes \\
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS \\
  -o GlobalKnownHostsFile=/dev/null \\
  -o IdentitiesOnly=yes -i $SSH_KEY \\
  -L $BIND:$PORT:127.0.0.1:$AGENT_PORT $SSH_USER@$BRIDGE_HOST
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE
systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null 2>&1
systemctl restart "$UNIT"

# The agent's unauthenticated /healthz proves the forwarding reaches it.
waited=0
until curl -fsS --max-time 3 "http://$BIND:$PORT/healthz" 2>/dev/null | grep -q '"ok":true'; do
  [ "$waited" -lt "$WAIT" ] || die 42 E_TUNNEL "http://$BIND:$PORT/healthz did not answer (check: systemctl status $UNIT)"
  sleep 2
  waited=$((waited + 2))
done

info "tunnel $UNIT: $BIND:$PORT -> $BRIDGE_HOST:127.0.0.1:$AGENT_PORT (host key pinned)"
info "management URL for the panel: http://host.docker.internal:$PORT"
info "enroll it, from $COMPOSE_DIR on this host (the token goes from the bridge host into the CLI's stdin, never an argument):"
info "  cd '$COMPOSE_DIR' && ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS \\"
info "    -o GlobalKnownHostsFile=/dev/null -i $SSH_KEY $SSH_USER@$BRIDGE_HOST cat /etc/amnezia-bridge/agent/api-token | \\"
info "    docker compose exec -T -e CONTROL_API_URL='$CONTROL_URL' '$CONTROL_SERVICE' \\"
info "    node /app/apps/cli/dist/main.js bridge-enroll $BRIDGE_ID --api-url=http://host.docker.internal:$PORT --api-key-file=- --confirm"
