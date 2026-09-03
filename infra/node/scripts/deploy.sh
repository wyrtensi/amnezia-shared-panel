#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

sh "$SCRIPT_DIR/preflight.sh"
acquire_lock
ensure_layout

# Which AWG services this node actually defines. AWG 3.1 alone is a supported
# shape -- a node with no legacy peers never needs awg2 -- so pulling and
# health-gating a service that is not in this node's compose file would make
# `deploy.sh` permanently unusable there, which is exactly what it did.
compose_services="$(compose config --services 2>/dev/null || true)"
has_service() {
  printf '%s\n' "$compose_services" | grep -qx "$1"
}

if has_service awg2; then
  docker pull --platform linux/amd64 "$AWG2_IMAGE" >/dev/null
  verify_awg2_image
fi

if has_service awg3; then
  docker pull --platform linux/amd64 "$AWG3_IMAGE" >/dev/null
  verify_awg3_image
fi

node_image="$(env_value NODE_AGENT_IMAGE)"
case "$node_image" in
  *@sha256:*) docker pull --platform linux/amd64 "$node_image" >/dev/null ;;
esac
verify_linux_amd64_image "$node_image"

backup_path=''
if [ -s "$STATE_DIR/awg0.conf" ]; then
  if backup_path="$(create_backup 0)"; then
    info "Pre-deploy backup created: $backup_path"
  else
    fail "pre-deploy backup failed"
  fi
fi

if ! compose up --detach --no-build --remove-orphans; then
  info "Deployment failed before health verification. Persistent state was not removed."
  [ -z "$backup_path" ] || info "Rollback source: $backup_path"
  exit 1
fi

if has_service awg2 && ! wait_healthy amnezia-awg2; then
  info "AWG2 failed its health gate. Persistent state was not removed."
  [ -z "$backup_path" ] || info "Rollback source: $backup_path"
  exit 1
fi

if has_service awg3 && ! wait_healthy amnezia-awg3; then
  info "AWG3 failed its health gate. Persistent state was not removed."
  [ -z "$backup_path" ] || info "Rollback source: $backup_path"
  exit 1
fi

if ! wait_healthy amnezia-node-agent; then
  info "Node-agent failed its health gate. Persistent state was not removed."
  [ -z "$backup_path" ] || info "Rollback source: $backup_path"
  exit 1
fi

agent_binding="$(docker port amnezia-node-agent 4001/tcp)"
[ "$agent_binding" = "127.0.0.1:4001" ] || fail "node-agent is not bound exclusively to 127.0.0.1:4001"

compose ps
# Report what this node actually runs. Naming a protocol it does not serve
# reads as "awg2 is up" to whoever is watching the deploy.
deployed_ports=''
has_service awg2 && deployed_ports="AWG2 is on UDP 51889"
if has_service awg3; then
  [ -z "$deployed_ports" ] || deployed_ports="$deployed_ports, "
  deployed_ports="${deployed_ports}AWG3 is on UDP 51890"
fi
info "Deployment health gates passed. ${deployed_ports}, and node-agent is loopback-only on TCP 4001."
release_lock
