#!/usr/bin/env bash
# Toggle amnezia-frps.service on a bridge host so WyTunnel-only bridges pay
# zero RAM/CPU for an inactive frps daemon.

set -euo pipefail

AGENT_ENV="${BRIDGE_AGENT_ENV:-/etc/amnezia-bridge/agent/agent.env}"
COMPOSE_FILE="${BRIDGE_COMPOSE_FILE:-/opt/amnezia-bridge/compose.yaml}"
MODE=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: toggle-frps.sh (--enable | --disable) [--dry-run]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enable) MODE="enable"; shift ;;
    --disable) MODE="disable"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Error: specify --enable or --disable" >&2
  usage >&2
  exit 2
fi

if [ "$MODE" = "disable" ]; then
  TARGET_VAL="false"
  SYSTEMCTL_CMD="systemctl disable --now amnezia-frps.service"
else
  TARGET_VAL="true"
  SYSTEMCTL_CMD="systemctl enable --now amnezia-frps.service"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] ${SYSTEMCTL_CMD}"
  echo "[dry-run] set BRIDGE_FRPS_ENABLED=${TARGET_VAL} in ${AGENT_ENV}"
  echo "[dry-run] recreate amnezia-bridge-agent via ${COMPOSE_FILE}"
  exit 0
fi

$SYSTEMCTL_CMD 2>/dev/null || true

if [ -f "$AGENT_ENV" ]; then
  if grep -q '^BRIDGE_FRPS_ENABLED=' "$AGENT_ENV"; then
    sed -i "s/^BRIDGE_FRPS_ENABLED=.*/BRIDGE_FRPS_ENABLED=${TARGET_VAL}/" "$AGENT_ENV"
  else
    echo "BRIDGE_FRPS_ENABLED=${TARGET_VAL}" >> "$AGENT_ENV"
  fi
fi

if [ -f "$COMPOSE_FILE" ] && [ -f "$AGENT_ENV" ]; then
  docker compose --project-name amnezia-bridge-agent --env-file "$AGENT_ENV" -f "$COMPOSE_FILE" up -d --force-recreate --no-deps bridge-agent
fi

echo "frps toggled to ${MODE} (BRIDGE_FRPS_ENABLED=${TARGET_VAL})."
