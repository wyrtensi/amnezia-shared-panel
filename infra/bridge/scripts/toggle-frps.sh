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

if [ "$MODE" = "disable" ]; then
  systemctl disable --now amnezia-frps.service 2>/dev/null || true
else
  systemctl enable --now amnezia-frps.service
fi

if [ -f "$AGENT_ENV" ]; then
  TMP_ENV="$(mktemp "$(dirname -- "$AGENT_ENV")/.agent.env.XXXXXX")"
  trap 'rm -f -- "$TMP_ENV"' EXIT
  awk -v val="$TARGET_VAL" '
    /^BRIDGE_FRPS_ENABLED=/ && !seen { print "BRIDGE_FRPS_ENABLED=" val; seen = 1; next }
    { print }
    END { if (!seen) print "BRIDGE_FRPS_ENABLED=" val }
  ' "$AGENT_ENV" >"$TMP_ENV"
  chmod 0600 "$TMP_ENV"
  mv -f "$TMP_ENV" "$AGENT_ENV"
fi

if [ -f "$COMPOSE_FILE" ] && [ -f "$AGENT_ENV" ]; then
  mkdir -p "${BRIDGE_WYTUNNEL_RUN_DIR:-/run/amnezia-wytunnel}"
  docker compose --project-name amnezia-bridge-agent --env-file "$AGENT_ENV" -f "$COMPOSE_FILE" up -d --force-recreate --no-deps bridge-agent
  port="$(sed -n 's/^BRIDGE_AGENT_PORT=//p' "$AGENT_ENV" 2>/dev/null | tail -n 1)"
  port="${port:-7600}"
  if command -v curl >/dev/null 2>&1; then
    ok=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS --max-time 2 "http://127.0.0.1:${port}/healthz" 2>/dev/null | grep -q '"ok":true'; then
        ok=1
        break
      fi
      sleep 1
    done
    [ "$ok" -eq 1 ] || { echo "Error: amnezia-bridge-agent failed /healthz after toggle-frps" >&2; exit 1; }
  fi
fi

echo "frps toggled to ${MODE} (BRIDGE_FRPS_ENABLED=${TARGET_VAL})."
