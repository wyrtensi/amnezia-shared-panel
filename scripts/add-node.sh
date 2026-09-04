#!/usr/bin/env bash
# Roll out one VPN node end to end, from a bare Linux/amd64 host to a healthy,
# registered node in the panel:
#
#   1. verify both hosts and that the panel name is free
#   2. ensure the node has 2 GiB of swap, before anything memory-hungry runs
#   3. install Docker Engine + Compose v2 on the node, if missing
#   4. copy infra/node to the node, create its layout, secret, and .env, and
#      authorize the panel's SSH key — the image ship in step 5 already needs it
#   5. ship the pinned node-agent image and record its ID *as loaded there*
#   6. repair state permissions, then run the node's own deploy.sh (which runs
#      preflight.sh itself — invoking it twice fails the RAM gate on a small host)
#   7. allocate a tunnel port and install the supervised autossh unit
#   8. register the node through the bundled admin CLI and reconcile it
#
# Every deployment-specific value (panel address, SSH key, paths, tunnel range)
# lives in scripts/add-node.env — copy scripts/add-node.env.example and fill it
# in. This script hardcodes no site-specific value and prints no key material.
#
# Re-running is safe: each step checks the live state first, an existing
# node-agent API key and SERVER_ID are never regenerated, and an already
# registered node is left alone.
#
# Usage:
#   scripts/add-node.sh --host <ip|dns> --name <panel name> [options]
#
# Options:
#   --region <label>           SERVER_REGION on the node (default: the name)
#   --public-host <ip|dns>     address written into client configs (default: --host)
#   --max-peers <n>            capacity, 1..500 (default: NODE_MAX_PEERS, else
#                              derived from the node's available memory)
#   --protocol <awg2|awg3>     fallback protocol on the node record
#   --enabled-protocols <list> comma-separated, offered to the key wizard
#   --ssh-user <user>          SSH user on the node (default: NODE_SSH_USER)
#   --config <path>            config file (default: scripts/add-node.env)
#   --skip-register            deploy the node but do not register it
#   --dry-run                  report what would change, change nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${REPO_ROOT}/scripts/add-node.env"
NODE_HOST="" NODE_NAME="" NODE_REGION="" PUBLIC_HOST=""
MAX_PEERS="" PROTOCOL="" ENABLED_PROTOCOLS="" SSH_USER=""
SKIP_REGISTER=0 DRY_RUN=0

die() { echo "add-node: $*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# Prints the header comment and stops at the first line that is not one, so
# adding an option never drifts a line-numbered range into the script's code.
usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) NODE_HOST="${2:?--host needs a value}"; shift 2 ;;
    --name) NODE_NAME="${2:?--name needs a value}"; shift 2 ;;
    --region) NODE_REGION="${2:?--region needs a value}"; shift 2 ;;
    --public-host) PUBLIC_HOST="${2:?--public-host needs a value}"; shift 2 ;;
    --max-peers) MAX_PEERS="${2:?--max-peers needs a value}"; shift 2 ;;
    --protocol) PROTOCOL="${2:?--protocol needs a value}"; shift 2 ;;
    --enabled-protocols) ENABLED_PROTOCOLS="${2:?--enabled-protocols needs a value}"; shift 2 ;;
    --ssh-user) SSH_USER="${2:?--ssh-user needs a value}"; shift 2 ;;
    --config) CONFIG="${2:?--config needs a value}"; shift 2 ;;
    --skip-register) SKIP_REGISTER=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$NODE_HOST" ] || die "--host is required"
[ -n "$NODE_NAME" ] || die "--name is required"
# The panel name doubles as the systemd unit name, so keep it a safe token.
case "$NODE_NAME" in
  *[!A-Za-z0-9._-]*) die "--name must be letters, digits, dot, dash, underscore" ;;
esac

[ -f "$CONFIG" ] || die "missing config: $CONFIG (copy scripts/add-node.env.example)"
# shellcheck disable=SC1090
. "$CONFIG"

: "${PANEL_SSH:?set PANEL_SSH in $CONFIG}"
: "${PANEL_COMPOSE_DIR:?set PANEL_COMPOSE_DIR in $CONFIG}"
: "${PANEL_NODE_KEY:?set PANEL_NODE_KEY in $CONFIG}"
PANEL_CONTROL_API_SERVICE="${PANEL_CONTROL_API_SERVICE:-control-api}"
PANEL_CONTROL_API_URL="${PANEL_CONTROL_API_URL:-http://127.0.0.1:3001}"
NODE_AGENT_IMAGE_SOURCE="${NODE_AGENT_IMAGE_SOURCE:-panel}"
TUNNEL_BIND="${TUNNEL_BIND:-172.17.0.1}"
TUNNEL_PORT_BASE="${TUNNEL_PORT_BASE:-4105}"
NODE_DIR="${NODE_DIR:-/opt/amnezia-panel-node}"
NODE_WEIGHT="${NODE_WEIGHT:-100}"

SSH_USER="${SSH_USER:-${NODE_SSH_USER:-root}}"
NODE_REGION="${NODE_REGION:-$NODE_NAME}"
PUBLIC_HOST="${PUBLIC_HOST:-$NODE_HOST}"
MAX_PEERS="${MAX_PEERS:-${NODE_MAX_PEERS:-}}"
PROTOCOL="${PROTOCOL:-${NODE_PROTOCOL:-awg3}}"
ENABLED_PROTOCOLS="${ENABLED_PROTOCOLS:-${NODE_ENABLED_PROTOCOLS:-awg3}}"
NODE_TARGET="${SSH_USER}@${NODE_HOST}"
UNIT="panel-tunnel-${NODE_NAME}"

# Largest capacity the node's memory can carry, given the preflight RAM gate:
# 358400 KiB * peers / 500 of MemAvailable, never below a 192 MiB floor. Below
# that floor no capacity passes, so the answer is 0 rather than a number the
# deploy would refuse. 500 stays the ceiling both the panel and the agent are
# validated for.
recommended_max_peers() {
  local available_kb="$1" peers
  if [ "$available_kb" -lt 196608 ]; then
    printf '0\n'
    return
  fi
  peers=$(( available_kb * 500 / 358400 ))
  [ "$peers" -le 500 ] || peers=500
  [ "$peers" -ge 1 ] || peers=1
  printf '%s\n' "$peers"
}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
node_ssh() { ssh "${SSH_OPTS[@]}" "$NODE_TARGET" "$@"; }
panel_ssh() { ssh "${SSH_OPTS[@]}" "$PANEL_SSH" "$@"; }
# Mutating remote work goes through these so --dry-run stays honest: read-only
# probes still run, anything that changes a host does not.
node_do() { if [ "$DRY_RUN" = 1 ]; then note "[dry-run] node: $*"; else node_ssh "$@"; fi; }
panel_do() { if [ "$DRY_RUN" = 1 ]; then note "[dry-run] panel: $*"; else panel_ssh "$@"; fi; }

[ "$DRY_RUN" = 1 ] && say "DRY RUN — no host will be modified"

# --- 1. Preconditions -------------------------------------------------------
say "[1/8] Checking both hosts"
node_ssh true 2>/dev/null || die "cannot SSH to $NODE_TARGET"
panel_ssh true 2>/dev/null || die "cannot SSH to $PANEL_SSH"
node_arch="$(node_ssh 'uname -m')"
[ "$node_arch" = "x86_64" ] || die "node is $node_arch; the AWG images are linux/amd64 only"
node_ssh 'test -c /dev/net/tun' || die "/dev/net/tun is missing on the node"
note "node $NODE_TARGET is reachable (linux/$node_arch), panel $PANEL_SSH is reachable"

if [ -z "$MAX_PEERS" ]; then
  node_mem_kb="$(node_ssh "awk '/^MemAvailable:/ { print \$2 }' /proc/meminfo")"
  MAX_PEERS="$(recommended_max_peers "$node_mem_kb")"
  [ "$MAX_PEERS" != 0 ] || die "node has $(( node_mem_kb / 1024 )) MiB available; \
at least 192 MiB is required. Add swap or free memory, or pass --max-peers to override."
  note "capacity derived from $(( node_mem_kb / 1024 )) MiB available: --max-peers $MAX_PEERS"
fi

cli() {
  panel_ssh "cd '$PANEL_COMPOSE_DIR' && docker compose exec -T \
    -e CONTROL_API_URL='$PANEL_CONTROL_API_URL' '$PANEL_CONTROL_API_SERVICE' \
    node /app/apps/cli/dist/main.js $*"
}
existing_nodes="$(cli nodes || die "the admin CLI is not usable on $PANEL_SSH")"
if printf '%s\n' "$existing_nodes" | awk '{print $1}' | grep -qx -- "$NODE_NAME"; then
  ALREADY_REGISTERED=1
  note "a node named '$NODE_NAME' is already registered — registration will be skipped"
else
  ALREADY_REGISTERED=0
fi

# --- 2. Swap on the node ----------------------------------------------------
# Before Docker: `apt-get install docker-ce` is itself a memory spike, and rule
# one for a small host is that swap comes first (docs/SMALL-HOSTS.md §1). The
# script is streamed over stdin and leaves no copy on the node.
ensure_node_swap() {
  local report status=0
  report="$(node_ssh 'bash -s -- --check' < "${REPO_ROOT}/scripts/ensure-swap.sh")" || status=$?
  note "$report"
  case "$status" in
    0) ;;
    10)
      # The apply's own status is checked rather than left to `set -e`: an
      # unchecked failure here aborts the rollout with a bare exit code, at the
      # one step whose failure the operator most needs explained.
      node_do 'bash -s -- --apply' < "${REPO_ROOT}/scripts/ensure-swap.sh" \
        || die "the node refused to create its 2 GiB swapfile — $report"
      ;;
    *) die "the node cannot get its 2 GiB swapfile — $report" ;;
  esac
}
say "[2/8] Ensuring 2 GiB of swap on the node"
ensure_node_swap

# --- 3. Docker on the node --------------------------------------------------
say "[3/8] Ensuring Docker Engine + Compose v2 on the node"
if node_ssh 'command -v docker >/dev/null && docker compose version >/dev/null 2>&1'; then
  note "already present: $(node_ssh 'docker --version')"
else
  note "installing from Docker's apt repository"
  node_do 'bash -seuo pipefail' <<'REMOTE'
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
apt-get update -qq
apt-get install -y -qq ca-certificates curl >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# Docker publishes per-codename suites; a very fresh release may not have one
# yet, so fall back to the newest suite that does exist.
suite="$UBUNTU_CODENAME"
for candidate in "$UBUNTU_CODENAME" questing noble jammy; do
  if curl -sfI "https://download.docker.com/linux/ubuntu/dists/$candidate/Release" >/dev/null; then
    suite="$candidate"; break
  fi
done
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $suite stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
systemctl enable --now docker
REMOTE
fi

# --- 4. Node layout, secret, and .env ---------------------------------------
say "[4/8] Installing infra/node into ${NODE_DIR} on the node"
# --owner/--group pin the archive to root: a plain `tar -c` carries the local
# uid, and the AWG entrypoints are then unreadable inside the containers
# ("can't open /usr/local/libexec/awg2-entrypoint.sh: Permission denied").
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] would copy ${REPO_ROOT}/infra/node -> ${NODE_TARGET}:${NODE_DIR}"
else
  tar -C "${REPO_ROOT}/infra/node" \
    --exclude=tests --exclude=.env --exclude=secrets --exclude=state --exclude=backups \
    --owner=0 --group=0 --numeric-owner -czf - . \
    | node_ssh "install -d -m 755 '$NODE_DIR' && tar -C '$NODE_DIR' -xzf -"
fi

DOCKER_GID="$(node_ssh "stat -c '%g' /var/run/docker.sock" 2>/dev/null || echo 0)"
[ "$DRY_RUN" = 1 ] || [ "$DOCKER_GID" != 0 ] || die "cannot read /var/run/docker.sock GID on the node"

node_do "NODE_DIR='$NODE_DIR' SERVER_NAME='$NODE_NAME' SERVER_REGION='$NODE_REGION' \
  SERVER_PUBLIC_HOST='$PUBLIC_HOST' SERVER_MAX_PEERS='$MAX_PEERS' \
  SERVER_WEIGHT='$NODE_WEIGHT' DOCKER_GID='$DOCKER_GID' bash -seuo pipefail" <<'REMOTE'
cd "$NODE_DIR"
install -d -m 700 secrets state/amnezia-awg2 state/amnezia-awg3 backups
# Generated once and never rotated by this script: regenerating it would orphan
# the node record in the panel, which stores the key encrypted at rest.
if [ ! -s secrets/node-agent-api-key ]; then
  (umask 077; openssl rand -base64 48 | tr -d '\n' > secrets/node-agent-api-key)
fi
[ -f .env ] || install -m 600 .env.example .env
# Keep an existing SERVER_ID: it is the node's stable identity to the agent.
server_id="$(sed -n 's/^SERVER_ID=//p' .env)"
case "$server_id" in ''|*0000-0000-*) server_id="$(uuidgen)" ;; esac
sed -i \
  -e "s|^DOCKER_GID=.*|DOCKER_GID=${DOCKER_GID}|" \
  -e "s|^SERVER_PUBLIC_HOST=.*|SERVER_PUBLIC_HOST=${SERVER_PUBLIC_HOST}|" \
  -e "s|^SERVER_ID=.*|SERVER_ID=${server_id}|" \
  -e "s|^SERVER_NAME=.*|SERVER_NAME=${SERVER_NAME}|" \
  -e "s|^SERVER_REGION=.*|SERVER_REGION=${SERVER_REGION}|" \
  -e "s|^SERVER_WEIGHT=.*|SERVER_WEIGHT=${SERVER_WEIGHT}|" \
  -e "s|^SERVER_MAX_PEERS=.*|SERVER_MAX_PEERS=${SERVER_MAX_PEERS}|" \
  .env
chown -R root:root .
chmod 700 scripts/*.sh
chmod 600 .env
chmod 640 secrets/node-agent-api-key
REMOTE

# --- 4b. Authorize the panel's key on the node ------------------------------
# Must happen before the image ship: with NODE_AGENT_IMAGE_SOURCE=panel the
# image is streamed panel -> node over this very key, so authorizing it only
# with the tunnel (step 6) makes step 4 fail "Permission denied (publickey)"
# on every brand-new node.
authorize_panel_key() {
  panel_do "install -d -m 700 /root/.ssh; \
    test -f '${PANEL_NODE_KEY}.pub' || ssh-keygen -t ed25519 -f '$PANEL_NODE_KEY' -N '' -C panel-to-nodes"
  pubkey="$(panel_ssh "cat '${PANEL_NODE_KEY}.pub'" 2>/dev/null || true)"
  if [ -n "$pubkey" ]; then
    node_do "install -d -m 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; \
      grep -qxF '$pubkey' ~/.ssh/authorized_keys || printf '%s\n' '$pubkey' >> ~/.ssh/authorized_keys"
  fi
}
authorize_panel_key

# --- 5. Ship the node-agent image -------------------------------------------
say "[5/8] Shipping the node-agent image"
current_image="$(node_ssh "sed -n 's/^NODE_AGENT_IMAGE=//p' '$NODE_DIR/.env'" 2>/dev/null || true)"
if [ -n "$current_image" ] && [ "$current_image" != "sha256:replace-with-64-hex-image-id" ] \
   && node_ssh "docker image inspect '$current_image' >/dev/null 2>&1"; then
  note "already present on the node: ${current_image}"
elif [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] would ship the node-agent image from ${NODE_AGENT_IMAGE_SOURCE}"
else
  case "$NODE_AGENT_IMAGE_SOURCE" in
    panel)
      : "${PANEL_NODE_DIR:?set PANEL_NODE_DIR (or NODE_AGENT_IMAGE_SOURCE=local) in $CONFIG}"
      load_out="$(panel_ssh "src=\$(sed -n 's/^NODE_AGENT_IMAGE=//p' '$PANEL_NODE_DIR/.env'); \
        docker save \"\$src\" | ssh -i '$PANEL_NODE_KEY' -o StrictHostKeyChecking=accept-new \
          -o UserKnownHostsFile=/root/.ssh/known_hosts '$NODE_TARGET' 'docker load'")"
      ;;
    local)
      sh "${REPO_ROOT}/infra/node/scripts/build-node-agent.sh"
      src="$(docker images --no-trunc --quiet amnezia-node-agent | head -1)"
      [ -n "$src" ] || die "local build produced no amnezia-node-agent image"
      load_out="$(docker save "$src" | node_ssh 'docker load')"
      ;;
    *) die "NODE_AGENT_IMAGE_SOURCE must be 'panel' or 'local'" ;;
  esac
  # `docker save | docker load` re-encodes the image config on newer engines, so
  # the ID on the node differs from the source host's. Always take the ID the
  # NODE reports — pinning the source ID makes preflight fail "image not found".
  loaded_ref="${load_out##*: }"
  [ -n "$loaded_ref" ] || die "could not parse the output of docker load"
  loaded_id="$(node_ssh "docker image inspect --format '{{.Id}}' '$loaded_ref'")"
  node_ssh "sed -i 's|^NODE_AGENT_IMAGE=.*|NODE_AGENT_IMAGE=${loaded_id}|' '$NODE_DIR/.env'"
  note "loaded on the node as ${loaded_id}"
fi

# --- 6. Preflight and deploy ------------------------------------------------
say "[6/8] Running the node's preflight and deploy"
# The node-agent rewrites awg0.conf and clientsTable with the default umask
# whenever a client changes, so they come back 0644 while preflight demands
# exactly 0600 — which makes deploy.sh refuse to run on any node that has ever
# served a peer. (Access is still gated by the 0700 state/ directory above, so
# this is a broken update path, not an exposure.) Restore the documented mode
# and report it; never relax the gate instead.
loosened="$(node_ssh "find '$NODE_DIR/state' -type f ! -perm 600 -printf '%M %p\n' 2>/dev/null" || true)"
if [ -n "$loosened" ]; then
  note "state files are not 0600 (the node-agent loosened them); restoring:"
  printf '%s\n' "$loosened" | sed 's/^/      /'
  node_do "find '$NODE_DIR/state' -type f -exec chmod 600 {} +"
fi
# deploy.sh runs preflight.sh itself, so it is not invoked separately here:
# the extra run starts a throwaway container whose memory is still held when
# deploy re-checks the RAM gate, which fails the gate on a small node.
node_do "cd '$NODE_DIR' && sh scripts/deploy.sh"

# --- 7. Supervised tunnel on the panel host ---------------------------------
say "[7/8] Opening the panel -> node tunnel"
# Reuse this node's port if the unit exists; otherwise take the first free one
# at or above the base, skipping ports other units or sockets already hold.
TUNNEL_PORT="$(panel_ssh "UNIT='$UNIT' BIND='$TUNNEL_BIND' BASE='$TUNNEL_PORT_BASE' bash -seuo pipefail" <<'REMOTE'
unit_file="/etc/systemd/system/${UNIT}.service"
if [ -f "$unit_file" ]; then
  sed -n "s|.* -L ${BIND}:\([0-9]\+\):.*|\1|p" "$unit_file" | head -1
  exit 0
fi
# Ports already forwarded by another unit, plus everything currently listening.
# Every stage may legitimately match nothing, so no pipeline here may be fatal.
units_ports="$(grep -hoE -- '-L [0-9.]+:[0-9]+:' /etc/systemd/system/panel-tunnel-*.service 2>/dev/null | cut -d: -f2 || true)"
open_ports="$(ss -H -ltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' || true)"
used="$(printf '%s\n%s\n' "$units_ports" "$open_ports" | sort -un)"
port="$BASE"
while printf '%s\n' "$used" | grep -qx "$port"; do port=$((port + 1)); done
echo "$port"
REMOTE
)"
[ -n "$TUNNEL_PORT" ] || die "could not allocate a tunnel port on the panel host"
note "tunnel port ${TUNNEL_BIND}:${TUNNEL_PORT} -> ${NODE_HOST}:4001"

panel_do "UNIT='$UNIT' NAME='$NODE_NAME' BIND='$TUNNEL_BIND' PORT='$TUNNEL_PORT' \
  KEY='$PANEL_NODE_KEY' TARGET='$NODE_TARGET' bash -seuo pipefail" <<'REMOTE'
command -v autossh >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq autossh; }
cat >"/etc/systemd/system/${UNIT}.service" <<UNITFILE
[Unit]
Description=Panel -> node tunnel (${NAME})
After=network-online.target docker.service
Wants=network-online.target

[Service]
# Without this, autossh gives up for good if the first connection dies within
# 30 s — exactly what happens when the node is down while the panel host boots.
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \\
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes \\
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts \\
  -i ${KEY} \\
  -L ${BIND}:${PORT}:127.0.0.1:4001 ${TARGET}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE
systemctl daemon-reload
systemctl enable --now "${UNIT}"
systemctl restart "${UNIT}"
REMOTE

API_BASE_URL="http://host.docker.internal:${TUNNEL_PORT}"
if [ "$DRY_RUN" = 0 ]; then
  health=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    health="$(panel_ssh "cd '$PANEL_COMPOSE_DIR' && docker compose exec -T '$PANEL_CONTROL_API_SERVICE' \
      wget -qO- '${API_BASE_URL}/healthz'" 2>/dev/null || true)"
    case "$health" in *'"ok":true'*) break ;; esac
    sleep 3
  done
  case "$health" in
    *'"ok":true'*) note "panel reaches the agent: ${API_BASE_URL}/healthz -> $health" ;;
    *) die "panel cannot reach ${API_BASE_URL}/healthz — check: systemctl status ${UNIT}" ;;
  esac
fi

# --- 8. Register in the panel -----------------------------------------------
say "[8/8] Registering the node in the panel"
if [ "$SKIP_REGISTER" = 1 ]; then
  note "--skip-register: register it later with api-url ${API_BASE_URL}"
elif [ "$ALREADY_REGISTERED" = 1 ]; then
  note "'$NODE_NAME' was already registered; leaving the record untouched"
elif [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] would run: node-add --name=$NODE_NAME --api-url=$API_BASE_URL \
--protocol=$PROTOCOL --max-peers=$MAX_PEERS --enabled-protocols=$ENABLED_PROTOCOLS"
else
  # The key is read on the panel host over its own SSH hop and handed straight
  # to the CLI, so it never lands on this workstation or in this script's output.
  added="$(panel_ssh "KEYFILE='$NODE_DIR/secrets/node-agent-api-key' NODE_KEY='$PANEL_NODE_KEY' \
    TARGET='$NODE_TARGET' DIR='$PANEL_COMPOSE_DIR' SVC='$PANEL_CONTROL_API_SERVICE' \
    API='$PANEL_CONTROL_API_URL' NAME='$NODE_NAME' URL='$API_BASE_URL' \
    PROTO='$PROTOCOL' PEERS='$MAX_PEERS' ENABLED='$ENABLED_PROTOCOLS' bash -seuo pipefail" <<'REMOTE'
# -n is load-bearing: this block reaches bash on stdin, and without it this
# ssh drains the rest of the heredoc, so the node-add below is never run --
# the step then prints nothing and exits 0 while registering no node.
key="$(ssh -n -i "$NODE_KEY" -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/root/.ssh/known_hosts "$TARGET" "cat '$KEYFILE'")"
cd "$DIR"
docker compose exec -T -e CONTROL_API_URL="$API" "$SVC" \
  node /app/apps/cli/dist/main.js node-add \
  --name="$NAME" --api-url="$URL" --api-key="$key" \
  --protocol="$PROTO" --max-peers="$PEERS" --enabled-protocols="$ENABLED"
REMOTE
)"
  # `node-add` answers "node added: <name> (<uuid>)" — take the id from there
  # rather than re-parsing the node list, which has no id column.
  printf '%s\n' "$added" | sed 's/^/    /'
  node_id="$(printf '%s' "$added" | sed -n 's/.*(\([0-9a-f-]\{36\}\)).*/\1/p' | head -1)"
  if [ -n "$node_id" ]; then
    note "waiting for the first telemetry poll"
    cli node-reconcile "$node_id" >/dev/null || true
  fi
fi

say "Done."
[ "$DRY_RUN" = 1 ] || cli nodes
