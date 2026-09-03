#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$(uname -s)" = "Linux" ] || fail "production deployment requires Linux"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "production deployment requires linux/amd64" ;;
esac

for command_name in docker tar sha256sum stat df awk sed grep ss; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done
tar --version | grep -q 'GNU tar' || fail "GNU tar is required"

[ -f "$ENV_FILE" ] || fail "copy .env.example to .env and set production values"
[ ! -L "$ENV_FILE" ] || fail ".env must not be a symlink"
[ "$(stat -c '%a' "$ENV_FILE")" = "600" ] || fail ".env permissions must be 0600"

ensure_layout

[ -f "$SECRET_FILE" ] || fail "missing API key secret file"
[ ! -L "$SECRET_FILE" ] || fail "API key secret file must not be a symlink"
[ "$(stat -c '%a' "$SECRET_FILE")" = "640" ] || fail "API key secret permissions must be 0640"
[ "$(stat -c '%u:%g' "$SECRET_FILE")" = "0:0" ] || fail "API key secret must be owned by root:root"
secret_size="$(wc -c <"$SECRET_FILE" | tr -d ' ')"
[ "$secret_size" -ge 32 ] || fail "API key secret must contain at least 32 bytes"
[ "$secret_size" -le 4096 ] || fail "API key secret is unexpectedly large"
api_key="$(cat "$SECRET_FILE")"
[ "${#api_key}" -ge 32 ] || fail "API key must contain at least 32 non-newline bytes"
case "$api_key" in
  *'
'*) fail "API key must be a single line" ;;
esac
# Checked by deleting every acceptable byte rather than with a bounded-repetition
# regex: `grep -E '^[[:graph:]]{32,4096}$'` expands that interval into an
# automaton that costs ~280MB of RSS, which the OOM killer reaps on a small node
# — and the killed grep then reports a valid key as malformed. Length is already
# bounded above, and a trailing newline is tolerated the same way "$(cat)" is.
[ -z "$(LC_ALL=C tr -d '[:graph:]' <"$SECRET_FILE")" ] || \
  fail "API key must contain only printable non-space ASCII characters"
unset api_key

[ -c /dev/net/tun ] || fail "/dev/net/tun is unavailable"
[ -S /var/run/docker.sock ] || fail "Docker socket is unavailable"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"

docker_os="$(docker info --format '{{.OSType}}')"
docker_arch="$(docker info --format '{{.Architecture}}')"
[ "$docker_os" = "linux" ] || fail "Docker Engine must run Linux containers"
[ "$docker_arch" = "x86_64" ] || [ "$docker_arch" = "amd64" ] || fail "Docker Engine must be amd64"

docker_gid="$(env_value DOCKER_GID)"
case "$docker_gid" in
  ''|*[!0-9]*) fail "DOCKER_GID must be an integer" ;;
esac
socket_gid="$(stat -c '%g' /var/run/docker.sock)"
[ "$docker_gid" = "$socket_gid" ] || fail "DOCKER_GID does not match /var/run/docker.sock"

node_image="$(env_value NODE_AGENT_IMAGE)"
case "$node_image" in
  sha256:*) node_digest="${node_image#sha256:}" ;;
  *@sha256:*) node_digest="${node_image##*@sha256:}" ;;
  *) fail "NODE_AGENT_IMAGE must be an immutable sha256 image ID or repository digest" ;;
esac
printf '%s\n' "$node_digest" | grep -Eq '^[0-9a-f]{64}$' || \
  fail "NODE_AGENT_IMAGE must end in a 64-character lowercase sha256 digest"
docker image inspect "$node_image" >/dev/null 2>&1 || fail "NODE_AGENT_IMAGE is not present locally"
verify_linux_amd64_image "$node_image"

public_host="$(env_value SERVER_PUBLIC_HOST)"
case "$public_host" in
  ''|0.0.0.0|127.0.0.1|localhost|vpn.example.com|203.0.113.10|*://*|*/*|*:*|*' '*)
    fail "SERVER_PUBLIC_HOST must be a real public address or DNS name"
    ;;
esac
# An IPv4 literal is the recommended value: the VPN client resolves a DNS name
# on its own network before the tunnel exists, and the panel cannot observe that
# failing. A name still deploys, but the operator is told what to do about it
# and how (docs/NODE-CONNECT.md).
case "$public_host" in
  *[!0-9.]*) info "NOTE: SERVER_PUBLIC_HOST is a DNS name ($public_host) - an IPv4 address is strongly recommended. Resolve it against public DNS (dig +short A $public_host @1.1.1.1) and confirm it matches this node's own address (curl -s https://api.ipify.org) - not with getent, which answers 127.0.0.1 for a host named after itself. Put the address in .env and redeploy: this value is baked into every key this node issues, clients resolve it on the network you are trying to get through, and the panel cannot see it fail." ;;
esac

server_id="$(env_value SERVER_ID)"
[ "$server_id" != "00000000-0000-4000-8000-000000000000" ] || fail "SERVER_ID placeholder must be replaced"
printf '%s\n' "$server_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' || \
  fail "SERVER_ID must be a UUID"

server_weight="$(env_value SERVER_WEIGHT)"
case "$server_weight" in
  ''|*[!0-9]*) fail "SERVER_WEIGHT must be an integer" ;;
esac
if [ "$server_weight" -lt 1 ] || [ "$server_weight" -gt 1000 ]; then
  fail "SERVER_WEIGHT must be between 1 and 1000"
fi

server_max_peers="$(env_value SERVER_MAX_PEERS)"
case "$server_max_peers" in
  ''|*[!0-9]*) fail "SERVER_MAX_PEERS must be an integer" ;;
esac
[ "$server_max_peers" -le 500 ] || fail "SERVER_MAX_PEERS must not exceed the unvalidated 500-peer limit"
[ "$server_max_peers" -ge 1 ] || fail "SERVER_MAX_PEERS must be positive"

available_kb="$(df -Pk "$NODE_DIR" | awk 'NR==2 { print $4 }')"
# Free space is what actually binds on a small host, and it is nearly always
# reclaimable rather than absent -- so say how, instead of only refusing.
#
# The floor is derived, not chosen: a deploy pulls at most the node-agent image
# (~500 MiB; the two AWG images are pinned by digest and already present),
# needs transient space to extract it, and writes a state backup measured in
# kilobytes. 2 GiB is four times the largest pull. The previous 3 GiB was a
# flat constant with no derivation, and it refused hosts a deploy would have
# fitted on comfortably -- a gate that stops the redeploy of a node that is
# running fine protects nothing.
[ "$available_kb" -ge 2097152 ] || \
  fail "at least 2 GiB of free disk is required (have $(( available_kb / 1024 )) MiB); reclaim with: docker image prune -a, journalctl --vacuum-size=100M"
# Above the floor but below what a host should be run at: one more image or one
# unattended month of logs away from the floor, so say so without blocking.
[ "$available_kb" -ge 3145728 ] || \
  info "NOTE: free disk is below the recommended 3 GiB (have $(( available_kb / 1024 )) MiB). The deploy will proceed, but reclaim space soon: docker image prune -a, journalctl --vacuum-size=100M"
available_mem_kb="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
[ -n "$available_mem_kb" ] || fail "cannot read available memory"
# The 350 MiB gate sizes a node at the 500-peer maximum, so scale it with the
# capacity this node is actually configured for -- a 500-peer node still gets
# exactly 350 MiB. The floor covers the resident stack, measured at ~117 MiB
# (node-agent 109, awg3 4, awg2 4) plus room for the transient container the
# clientsTable check below starts.
required_mem_kb=$(( 358400 * server_max_peers / 500 ))
[ "$required_mem_kb" -ge 196608 ] || required_mem_kb=196608
[ "$available_mem_kb" -ge "$required_mem_kb" ] || \
  fail "at least $(( required_mem_kb / 1024 )) MiB of available RAM is required for ${server_max_peers} peers (have $(( available_mem_kb / 1024 )) MiB); lower SERVER_MAX_PEERS in .env to size this node for the memory it has"

forbidden_found=0
if grep -niE 'watchtower|(^|[^[:alnum:]_.-])latest([^[:alnum:]_.-]|$)' "$COMPOSE_FILE" >/dev/null; then
  forbidden_found=1
fi
node_agent_dockerfile="$NODE_DIR/../../services/node-agent/Dockerfile"
if [ -f "$node_agent_dockerfile" ] && \
   grep -niE 'watchtower|(^|[^[:alnum:]_.-])latest([^[:alnum:]_.-]|$)' "$node_agent_dockerfile" >/dev/null; then
  forbidden_found=1
fi
if [ "$forbidden_found" -eq 1 ]; then
  fail "latest or Watchtower reference detected"
fi

compose config --quiet

for container_name in amnezia-awg2 amnezia-awg3 amnezia-node-agent; do
  existing_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_name" 2>/dev/null || true)"
  if [ -n "$existing_project" ] && [ "$existing_project" != "amnezia-node" ]; then
    fail "container name is owned by another deployment: $container_name"
  fi
done

if ss -H -lun 'sport = :51889' | grep -q . && ! container_is_running amnezia-awg2; then
  fail "UDP port 51889 is already in use"
fi

if ss -H -lun 'sport = :51890' | grep -q . && ! container_is_running amnezia-awg3; then
  fail "UDP port 51890 is already in use"
fi

if ss -H -ltn 'sport = :4001' | grep -q . && ! container_is_running amnezia-node-agent; then
  fail "TCP port 4001 is already in use"
fi

for state_dir in "$STATE_DIR" "$STATE_DIR_AWG3"; do
  for sensitive_file in \
    "$state_dir/awg0.conf" \
    "$state_dir/wireguard_server_private_key.key" \
    "$state_dir/wireguard_server_public_key.key" \
    "$state_dir/wireguard_psk.key" \
    "$state_dir/clientsTable"; do
    if [ -e "$sensitive_file" ]; then
      [ ! -L "$sensitive_file" ] || fail "state file must not be a symlink: $sensitive_file"
      [ "$(stat -c '%a' "$sensitive_file")" = "600" ] || fail "state file permissions must be 0600: $sensitive_file"
    fi
  done

  if [ -s "$state_dir/clientsTable" ]; then
    docker run --rm --platform linux/amd64 \
      --user 0:0 \
      --volume "$state_dir:/state:ro" \
      --entrypoint node \
      "$node_image" \
      -e "JSON.parse(require('fs').readFileSync('/state/clientsTable','utf8'))"
  fi
done

info "Preflight passed: linux/amd64, 2 GiB disk gate (3 GiB recommended), $(( required_mem_kb / 1024 )) MiB RAM gate for ${server_max_peers} peers, immutable images, strict permissions, and fixed ports verified."
