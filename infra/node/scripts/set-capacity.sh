#!/bin/sh
# Change this node's peer capacity (SERVER_MAX_PEERS) and put it into effect.
#
# The node-agent reads the value once, at process start, from an environment
# variable Docker fixes at container creation -- there is no API for it. So the
# only mechanism is: rewrite .env, recreate the container. This script recreates
# ONLY the node-agent: the AWG containers never receive SERVER_MAX_PEERS, so
# tunnels stay up and existing peers keep passing traffic. The node's HTTP API
# is unavailable for the few seconds of the recreate plus its health start
# period; during that window the panel cannot create or revoke keys here.
#
# Recreating the node-agent CANNOT lose peers. The peers live on the host, in
# ./state/amnezia-awg2 and ./state/amnezia-awg3, mounted into the two AWG
# containers this script does not stop; the node-agent has no state volume at
# all (it is read_only with a tmpfs /tmp) and reaches peer state only through
# `docker exec` into those containers. Nothing in its startup writes peer state,
# and its one scheduled task disables expired peers rather than deleting them.
#
# --no-deps matters: node-agent declares depends_on on the AWG containers, so
# without it compose would recreate one whose definition has drifted from the
# running container and drop every tunnel. We assert they are healthy ourselves
# instead, which is what depends_on was buying.
#
# It deliberately does NOT call deploy.sh: deploy.sh stops the AWG containers
# for its pre-deploy backup, which drops every tunnel for a one-line .env
# change. It also takes no backup of its own, for the same reason: the node's
# backup mechanism stops the data plane to take a consistent archive, so it
# would cost exactly the outage this script exists to avoid, to insure against
# a loss that cannot happen.
#
# Usage (from the node's infra/node directory):
#   sh scripts/set-capacity.sh <peers> [--force]
#
#   <peers>   1..1000. Above 500 is unvalidated and needs --force.
#   --force   accept an unvalidated capacity above 500.
#
# Rollback: run it again with the previous number. If the node-agent does not
# come back healthy, the previous value is restored automatically.
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

FORCE=0
PEERS=''
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "unknown option: $1" ;;
    *) [ -z "$PEERS" ] || fail "give exactly one capacity"; PEERS="$1"; shift ;;
  esac
done

[ -n "$PEERS" ] || fail "usage: sh scripts/set-capacity.sh <peers> [--force]"
case "$PEERS" in
  ''|*[!0-9]*) fail "capacity must be a positive integer" ;;
esac
[ "$PEERS" -ge 1 ] || fail "capacity must be positive"
[ "$PEERS" -le 1000 ] || fail "capacity must not exceed 1000 (the /22 address pool holds 1021 peers)"
if [ "$PEERS" -gt 500 ] && [ "$FORCE" -eq 0 ]; then
  fail "capacity $PEERS is above the validated 500-peer limit; re-run with --force to accept an unvalidated configuration"
fi

# The same arithmetic preflight.sh applies, so a raise this host cannot carry is
# refused here instead of breaking every later deploy of the node.
required_mem_kb_for() {
  required=$(( 358400 * $1 / 500 ))
  [ "$required" -ge 196608 ] || required=196608
  printf '%s\n' "$required"
}

[ -f "$ENV_FILE" ] || fail "no .env in $NODE_DIR"
previous_max_peers="$(env_value SERVER_MAX_PEERS)"
[ -n "$previous_max_peers" ] || fail "SERVER_MAX_PEERS is not set in .env"
if [ "$previous_max_peers" = "$PEERS" ]; then
  info "SERVER_MAX_PEERS is already $PEERS; nothing to do."
  exit 0
fi

required_kb="$(required_mem_kb_for "$PEERS")"
available_mem_kb="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
[ -n "$available_mem_kb" ] || fail "cannot read available memory"
if [ "$available_mem_kb" -lt "$required_kb" ]; then
  fail "capacity $PEERS needs 358400 * $PEERS / 500 = $(( required_kb / 1024 )) MiB of MemAvailable (192 MiB floor); this host has $(( available_mem_kb / 1024 )) MiB. Add swap or free memory, or choose a smaller capacity."
fi

write_max_peers() {
  sed -i "s|^SERVER_MAX_PEERS=.*|SERVER_MAX_PEERS=$1|" "$ENV_FILE"
}

# We recreate with --no-deps, so compose will not wait on the data plane for us.
# Assert here what depends_on used to assert, and fail loudly rather than
# leaving an agent running against a data plane that is down.
require_healthy() {
  container_is_running "$1" || \
    fail "$1 is not running; start the data plane before changing capacity"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || true)"
  [ "$health" = "healthy" ] || \
    fail "$1 is '$health', not healthy; fix the data plane before changing capacity"
}

acquire_lock
# AWG 3.1 is the data plane every node has. AWG 2.0 is opt-in through
# PROTOCOLS_ENABLED, and demanding it unconditionally would refuse to run on
# every 3.1-only node -- the same defect that once made deploy.sh unable to
# succeed on one.
require_healthy amnezia-awg3
if awg2_enabled; then
  require_healthy amnezia-awg2
fi
info "SERVER_MAX_PEERS: $previous_max_peers -> $PEERS (needs $(( required_kb / 1024 )) MiB, host has $(( available_mem_kb / 1024 )) MiB)"
write_max_peers "$PEERS"

if ! sh "$SCRIPT_DIR/preflight.sh"; then
  write_max_peers "$previous_max_peers"
  fail "preflight refused the new capacity; .env restored to $previous_max_peers"
fi

# --no-deps: recreate this one container and nothing else. Peer state is in the
# AWG bind mounts, which no part of this touches.
if ! compose up --detach --no-deps node-agent; then
  write_max_peers "$previous_max_peers"
  compose up --detach --no-deps node-agent || true
  fail "node-agent failed to start with capacity $PEERS; .env restored to $previous_max_peers"
fi

if ! wait_healthy amnezia-node-agent; then
  write_max_peers "$previous_max_peers"
  compose up --detach --no-deps node-agent || true
  wait_healthy amnezia-node-agent || fail "node-agent did not recover after rollback; investigate before deploying"
  fail "node-agent was unhealthy with capacity $PEERS; .env restored to $previous_max_peers"
fi

release_lock
info "Capacity is now $PEERS. AWG tunnels were not restarted and no peer was touched. The panel picks the new cap up on its next telemetry poll and grows nodes.max_peers into it if automatic growth is on."
info "To confirm nothing was lost: docker exec amnezia-awg3 sh -lc 'awg show awg0 peers | wc -l' should match what it printed before this ran."
