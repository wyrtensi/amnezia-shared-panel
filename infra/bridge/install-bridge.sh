#!/bin/sh
# Install a whole bridge host: the frps (install-frps.sh) and the bridge-agent.
#
#   install-bridge.sh --bridge-id <uuid> --control-port <tcp> --udp-start <first>
#       --udp-end <last> [--agent-image <name@sha256:digest>]
#       [--agent-repository <name>] [--agent-port 7600] [--dry-run]
#
# It runs install-frps.sh first, with the same arguments, and then installs the
# bridge-agent as the Docker Compose service in compose.yaml next to this
# script. The frps step is never rolled back or restarted by an agent failure:
# the agent only reads from frps, so a working bridge keeps forwarding.
#
# The agent image comes from --agent-image or BRIDGE_AGENT_IMAGE and must be
# pinned by digest (name@sha256:<64 hex>); a tag is refused. It must also come
# from the approved bridge-agent repository: the one given by --agent-repository
# or BRIDGE_AGENT_IMAGE_REPOSITORY (exact match), else any
# ghcr.io/<path>/bridge-agent. Without an image the frps is still installed, the
# output says "bridge-agent NOT installed" and the script exits 60.
#
# Host prerequisites for the agent (docker, the compose plugin, systemd, curl,
# sha256sum) are checked before anything is installed, so a host that cannot
# run the agent is refused up front (exit 61) instead of ending up with frps
# only. After the agent passes its health check the pin file
# /etc/amnezia-bridge/agent/image.pin records the approved repository and the
# digest that was last verified running. Which file is authoritative:
# agent.env holds the image Compose RUNS; image.pin holds the last known-good
# one (the rollback target). The updater (Task 6c) must take the approved
# repository and digest from the panel's request, never from the pin's
# repository line, and only use the pin to restore the previous image.
#
# The agent's API token is generated here once, on the host, in
# /etc/amnezia-bridge/agent/api-token (mode 0600). It is never regenerated on a
# re-run and its value is never printed, logged or passed as an argument. The
# operator reads it over a trusted channel when enrolling the bridge.
#
# A dry run reads state and prints PLAN: lines. It generates, pulls, writes and
# starts nothing.
#
# Exit codes: those of install-frps.sh (frps step), plus
#    2  invalid arguments (including an image that is not digest-pinned)
#   60  no agent image was given; the frps was installed, the agent was not
#   61  a host prerequisite for the agent is missing (docker, compose plugin,
#       systemd, curl, sha256sum)
#   62  the token or env file is unsafe or cannot be written
#   63  pulling the image or starting the compose service failed
#   64  the agent does not listen on 127.0.0.1:<port> or /healthz fails
#
# Test seams (not for operators): AMNEZIA_ETC, AMNEZIA_FRPS_INSTALLER,
# AMNEZIA_ALLOW_NONROOT, AMNEZIA_LISTEN_WAIT, AMNEZIA_SSH_HOST_KEY,
# AMNEZIA_SYSTEMD_DIR.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ETC="${AMNEZIA_ETC:-/etc}"
FRPS_INSTALLER="${AMNEZIA_FRPS_INSTALLER:-$HERE/install-frps.sh}"
LISTEN_WAIT="${AMNEZIA_LISTEN_WAIT:-20}"
BRIDGE_ETC="$ETC/amnezia-bridge"
AGENT_DIR="$BRIDGE_ETC/agent"
TOKEN_FILE="$AGENT_DIR/api-token"
ENV_FILE="$AGENT_DIR/agent.env"
PIN_FILE="$AGENT_DIR/image.pin"
SYSTEMD_DIR="${AMNEZIA_SYSTEMD_DIR:-/run/systemd/system}"
DASH_ENV_FILE="$BRIDGE_ETC/frp/dashboard.env"
COMPOSE_FILE="$HERE/compose.yaml"
PROJECT=amnezia-bridge-agent
HOST_KEY_PUB="${AMNEZIA_SSH_HOST_KEY:-$ETC/ssh/ssh_host_ed25519_key.pub}"

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
AGENT_PORT=7600
AGENT_IMAGE="${BRIDGE_AGENT_IMAGE:-}"
AGENT_REPOSITORY="${BRIDGE_AGENT_IMAGE_REPOSITORY:-}"
DRY_RUN=0

need_value() { [ "$#" -ge 2 ] || usage_error "$1 needs a value"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bridge-id) need_value "$@"; BRIDGE_ID="$2"; shift 2 ;;
    --control-port) need_value "$@"; CONTROL_PORT="$2"; shift 2 ;;
    --udp-start) need_value "$@"; UDP_START="$2"; shift 2 ;;
    --udp-end) need_value "$@"; UDP_END="$2"; shift 2 ;;
    --agent-image) need_value "$@"; AGENT_IMAGE="$2"; shift 2 ;;
    --agent-repository) need_value "$@"; AGENT_REPOSITORY="$2"; shift 2 ;;
    --agent-port) need_value "$@"; AGENT_PORT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

is_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
is_uuid() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

# The frps step validates its own arguments; these checks cover the values this
# script writes into the agent's environment, before anything is installed.
is_uuid "$BRIDGE_ID" || usage_error "--bridge-id must be a lowercase UUID"
is_port "$CONTROL_PORT" || usage_error "--control-port must be a TCP port (1-65535)"
is_port "$UDP_START" || usage_error "--udp-start must be a UDP port (1-65535)"
is_port "$UDP_END" || usage_error "--udp-end must be a UDP port (1-65535)"
is_port "$AGENT_PORT" || usage_error "--agent-port must be a TCP port (1-65535)"
[ "$AGENT_PORT" -ne 7500 ] || usage_error "--agent-port must not be 7500 (frps dashboard)"
if [ -n "$AGENT_IMAGE" ]; then
  printf '%s' "$AGENT_IMAGE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$' ||
    usage_error "--agent-image must be pinned by digest (name@sha256:<64 hex>); tags are refused"
  IMAGE_REPO="${AGENT_IMAGE%@*}"
  if [ -n "$AGENT_REPOSITORY" ]; then
    [ "$IMAGE_REPO" = "$AGENT_REPOSITORY" ] ||
      usage_error "--agent-image is not from the approved bridge-agent repository $AGENT_REPOSITORY"
  else
    printf '%s' "$IMAGE_REPO" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+/bridge-agent$' ||
      usage_error "--agent-image must come from a ghcr.io/<owner>/<repo>/bridge-agent repository (or set --agent-repository)"
  fi
fi

if [ "$DRY_RUN" -eq 0 ] && [ "${AMNEZIA_ALLOW_NONROOT:-0}" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  die 2 E_USAGE "run as root (or use --dry-run to only read state)"
fi

# ---- 0. host prerequisites of the agent -----------------------------------
# Checked before frps is touched: a bridge that can never run the agent should
# be refused now, not left half-installed. Not needed when no image was given
# (that path installs frps only and exits 60).
if [ -n "$AGENT_IMAGE" ]; then
  missing=""
  for tool in docker curl sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    missing="$missing docker-compose-plugin"
  fi
  [ -d "$SYSTEMD_DIR" ] || missing="$missing systemd"
  [ -z "$missing" ] ||
    die 61 E_PREREQ "missing host prerequisites for the bridge-agent:$missing (nothing was installed)"
fi

# ---- 1. frps (unchanged interface) ----------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  sh "$FRPS_INSTALLER" --bridge-id "$BRIDGE_ID" --control-port "$CONTROL_PORT" \
    --udp-start "$UDP_START" --udp-end "$UDP_END" --dry-run
else
  sh "$FRPS_INSTALLER" --bridge-id "$BRIDGE_ID" --control-port "$CONTROL_PORT" \
    --udp-start "$UDP_START" --udp-end "$UDP_END"
fi

# ---- 2. bridge-agent -------------------------------------------------------
if [ -z "$AGENT_IMAGE" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "bridge-agent NOT planned: no --agent-image or BRIDGE_AGENT_IMAGE given (a real run installs frps only and exits 60)"
    exit 0
  fi
  info "bridge-agent NOT installed: no --agent-image or BRIDGE_AGENT_IMAGE given."
  info "frps is installed and running. Run this script again with a digest-pinned image."
  exit 60
fi

file_mode() { stat -c %a "$1"; }
check_token_file() {
  mode="$(file_mode "$TOKEN_FILE")"
  case "$mode" in
    400|600) ;;
    *) die 62 E_FILE "$TOKEN_FILE has mode $mode, expected 0600" ;;
  esac
  [ "$DRY_RUN" -eq 1 ] || [ "$(stat -c %u "$TOKEN_FILE")" = "$(id -u)" ] ||
    die 62 E_FILE "$TOKEN_FILE must be owned by the user running this script (root)"
  # Length only: the value is never read into output.
  [ "$(wc -c <"$TOKEN_FILE")" -ge 33 ] || die 62 E_FILE "$TOKEN_FILE holds fewer than 32 characters"
}

render_env() {
  cat <<ENV_EOF
# Written by install-bridge.sh. No secrets: the API token lives in $TOKEN_FILE.
BRIDGE_AGENT_IMAGE=$AGENT_IMAGE
BRIDGE_ETC=$BRIDGE_ETC
BRIDGE_ID=$BRIDGE_ID
BRIDGE_APPLIED_CONTROL_PORT=$CONTROL_PORT
BRIDGE_APPLIED_UDP_START=$UDP_START
BRIDGE_APPLIED_UDP_END=$UDP_END
BRIDGE_AGENT_PORT=$AGENT_PORT
ENV_EOF
}

compose() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

if [ "$DRY_RUN" -eq 1 ]; then
  if [ -f "$TOKEN_FILE" ]; then
    check_token_file
    plan "keep API token $TOKEN_FILE"
  else
    plan "generate API token $TOKEN_FILE (mode 0600, value never printed)"
  fi
  plan "write $ENV_FILE (mode 0600): image $AGENT_IMAGE, ports, bridge id"
  plan "docker compose pull and up -d the $PROJECT project (network_mode host, listens on 127.0.0.1:$AGENT_PORT)"
  plan "confirm the listener on 127.0.0.1:$AGENT_PORT and GET /healthz"
  plan "write the pin file $PIN_FILE (mode 0600): repository $IMAGE_REPO, digest ${AGENT_IMAGE#*@}"
  info "dry run: nothing was written, pulled or started"
  exit 0
fi

mkdir -p "$AGENT_DIR"
chmod 0700 "$AGENT_DIR"
if [ ! -f "$TOKEN_FILE" ]; then
  # Alphanumeric only, so the file is safe to read from a shell or a pipe.
  token="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48 || true)"
  [ "${#token}" -eq 48 ] || die 62 E_FILE "cannot generate the agent API token"
  old_umask="$(umask)"
  umask 077
  printf '%s\n' "$token" >"$TOKEN_FILE"
  umask "$old_umask"
  chmod 0600 "$TOKEN_FILE"
  token=""
fi
check_token_file
[ -f "$DASH_ENV_FILE" ] || die 62 E_FILE "missing $DASH_ENV_FILE (install-frps.sh creates it)"

TMP_ENV="$(mktemp "$AGENT_DIR/.agent.env.XXXXXX")"
trap 'rm -f -- "$TMP_ENV"' EXIT
render_env >"$TMP_ENV"
chmod 0600 "$TMP_ENV"
mv -f "$TMP_ENV" "$ENV_FILE"

compose pull --quiet >/dev/null 2>&1 ||
  die 63 E_PULL "pulling $AGENT_IMAGE failed; frps is unaffected"
compose up -d >/dev/null 2>&1 ||
  die 63 E_COMPOSE "starting the $PROJECT compose project failed; frps is unaffected (inspect: docker compose --project-name $PROJECT logs)"

# The agent must listen on loopback only, exactly where the SSH forwarding
# will reach it, and answer its unauthenticated health check.
waited=0
while :; do
  problem=""
  ss -H -ltn 2>/dev/null | awk -v want="127.0.0.1:$AGENT_PORT" '$4 == want {found=1} END {exit !found}' ||
    problem="nothing listens on 127.0.0.1:$AGENT_PORT"
  if [ -z "$problem" ]; then
    curl -fsS --max-time 3 "http://127.0.0.1:$AGENT_PORT/healthz" 2>/dev/null | grep -q '"ok":true' ||
      problem="http://127.0.0.1:$AGENT_PORT/healthz did not answer ok"
  fi
  [ -n "$problem" ] || break
  if [ "$waited" -ge "$LISTEN_WAIT" ]; then
    die 64 E_AGENT "$problem (waited ${LISTEN_WAIT}s); frps is unaffected (inspect: docker compose --project-name $PROJECT logs)"
  fi
  sleep 1
  waited=$((waited + 1))
done

# The pin the updater trusts: written only once this exact digest is running
# and answering, from the already validated reference.
TMP_PIN="$(mktemp "$AGENT_DIR/.image.pin.XXXXXX")"
trap 'rm -f -- "$TMP_ENV" "$TMP_PIN"' EXIT
{
  printf '# Written by install-bridge.sh: the approved repository and the digest the agent runs.\n'
  printf 'BRIDGE_AGENT_IMAGE_REPOSITORY=%s\n' "$IMAGE_REPO"
  printf 'BRIDGE_AGENT_IMAGE=%s\n' "$AGENT_IMAGE"
} >"$TMP_PIN"
chmod 0600 "$TMP_PIN"
mv -f "$TMP_PIN" "$PIN_FILE"

fingerprint=""
if [ -f "$HOST_KEY_PUB" ]; then
  fingerprint="$(ssh-keygen -lf "$HOST_KEY_PUB" 2>/dev/null | awk '{print $2}' || true)"
fi
info "bridge-agent running for bridge $BRIDGE_ID"
info "  bridge id:           $BRIDGE_ID"
info "  pinned image:        ${AGENT_IMAGE#*@} ($PIN_FILE)"
info "  management listener: 127.0.0.1:$AGENT_PORT (loopback only)"
info "  API token file:      $TOKEN_FILE (mode 0600; the value is not printed)"
info "  SSH host key (ed25519): ${fingerprint:-unknown; read it with ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub}"
info "next: from the panel host run scripts/add-bridge-tunnel.sh with this bridge id and host key fingerprint,"
info "      then enroll the agent with the CLI command it prints (see infra/bridge/README.md)."
