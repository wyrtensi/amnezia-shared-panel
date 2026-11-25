#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
NODE_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$NODE_DIR/compose.yaml"
ENV_FILE="$NODE_DIR/.env"
SECRET_FILE="$NODE_DIR/secrets/node-agent-api-key"
STATE_ROOT="$NODE_DIR/state"
STATE_DIR="$NODE_DIR/state/amnezia-awg2"
STATE_DIR_AWG3="$NODE_DIR/state/amnezia-awg3"
BACKUP_DIR="$NODE_DIR/backups"
LOCK_DIR="$NODE_DIR/.deploy.lock"
EGRESS_STATE_FILE="${EGRESS_STATE_FILE:-/etc/amnezia-egress/state.json}"
AWG2_IMAGE='amneziavpn/amneziawg-go:0.2.19@sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44'
AWG2_REPO_DIGEST='amneziavpn/amneziawg-go@sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44'
AWG3_IMAGE='amneziavpn/amneziawg-go:3.1.20260828@sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72'
AWG3_REPO_DIGEST='amneziavpn/amneziawg-go@sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72'

info() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Does this node serve AWG 2.0? Read from PROTOCOLS_ENABLED so there is exactly
# one switch: the same value the agent gets, and the one that decides whether
# the awg2 compose profile is active.
awg2_enabled() {
  case ",$(env_value PROTOCOLS_ENABLED)," in
    *,amneziawg2,*) return 0 ;;
    *) return 1 ;;
  esac
}

# Every compose call goes through here so `config --services`, the health gates
# and `up` all see the same set of services.
compose() {
  if awg2_enabled; then
    docker compose \
      --project-directory "$NODE_DIR" \
      --env-file "$ENV_FILE" \
      --file "$COMPOSE_FILE" \
      --profile awg2 \
      "$@"
  else
    docker compose \
      --project-directory "$NODE_DIR" \
      --env-file "$ENV_FILE" \
      --file "$COMPOSE_FILE" \
      "$@"
  fi
}

env_value() {
  key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

set_env_value() {
  key="$1"
  value="$2"
  env_tmp="$(mktemp "$NODE_DIR/.env.XXXXXX")" || return 1
  if [ -f "$ENV_FILE" ]; then
    awk -v k="$key" -v v="$value" '
      $0 ~ ("^" k "=") && !seen { print k "=" v; seen = 1; next }
      { print }
      END { if (!seen) print k "=" v }
    ' "$ENV_FILE" >"$env_tmp" || { rm -f "$env_tmp"; return 1; }
  else
    printf '%s=%s\n' "$key" "$value" >"$env_tmp" || { rm -f "$env_tmp"; return 1; }
  fi
  chmod 600 "$env_tmp"
  mv -f "$env_tmp" "$ENV_FILE"
}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another node operation is active: $LOCK_DIR"
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  trap - EXIT INT TERM
}

ensure_layout() {
  umask 077
  mkdir -p "$NODE_DIR/secrets" "$STATE_DIR" "$STATE_DIR_AWG3" "$BACKUP_DIR"
  chmod 700 "$NODE_DIR/secrets" "$STATE_ROOT" "$STATE_DIR" "$STATE_DIR_AWG3" "$BACKUP_DIR"
}

container_is_running() {
  [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]
}

wait_healthy() {
  container="$1"
  attempts="${2:-45}"
  current=0

  while [ "$current" -lt "$attempts" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
    case "$status" in
      healthy) return 0 ;;
      unhealthy)
        docker inspect --format '{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}' "$container" >&2 || true
        return 1
        ;;
    esac
    current=$((current + 1))
    sleep 2
  done

  return 1
}

verify_linux_amd64_image() {
  image="$1"
  os="$(docker image inspect --format '{{.Os}}' "$image" 2>/dev/null || true)"
  arch="$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null || true)"
  [ "$os" = "linux" ] || fail "image is not linux: $image"
  [ "$arch" = "amd64" ] || fail "image is not amd64: $image"
}

verify_awg2_image() {
  verify_linux_amd64_image "$AWG2_IMAGE"
  digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$AWG2_IMAGE")"
  printf '%s\n' "$digests" | grep -Fx "$AWG2_REPO_DIGEST" >/dev/null || \
    fail "pulled AWG2 image does not match the approved linux/amd64 digest"
}

verify_awg3_image() {
  verify_linux_amd64_image "$AWG3_IMAGE"
  digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$AWG3_IMAGE")"
  printf '%s\n' "$digests" | grep -Fx "$AWG3_REPO_DIGEST" >/dev/null || \
    fail "pulled AWG3 image does not match the approved linux/amd64 digest"
}

# Remove oldest backups matching a prefix pattern in BACKUP_DIR beyond keep_count.
# UTC timestamps ensure lexicographic reverse sort orders newest first.
prune_backup_pattern() {
  pattern="$1"
  keep="$2"
  case "$keep" in
    ''|*[!0-9]*) keep=15 ;;
  esac
  [ "$keep" -gt 0 ] || return 0
  [ -d "$BACKUP_DIR" ] || return 0

  list_tmp="$(mktemp "$BACKUP_DIR/.prune.XXXXXX")" || return 0
  for entry in "$BACKUP_DIR"/$pattern; do
    [ -e "$entry" ] || continue
    basename -- "$entry" >>"$list_tmp"
  done

  idx=0
  sort -r "$list_tmp" | while IFS= read -r name; do
    [ -n "$name" ] || continue
    idx=$((idx + 1))
    if [ "$idx" -gt "$keep" ]; then
      rm -f "$BACKUP_DIR/$name" "$BACKUP_DIR/$name.sha256"
    fi
  done
  rm -f "$list_tmp"
}

prune_node_backups() {
  keep="${1:-${BACKUP_KEEP_COUNT:-$(env_value BACKUP_KEEP_COUNT)}}"
  case "$keep" in
    '') keep=15 ;;
  esac
  prune_backup_pattern 'amnezia-node-*.tar.gz' "$keep"
  prune_backup_pattern 'egress-state-*.json' "$keep"
}

create_backup() {
  restart_after="${1:-1}"
  has_awg2=0
  has_awg3=0
  [ -s "$STATE_DIR/awg0.conf" ] && has_awg2=1
  [ -s "$STATE_DIR_AWG3/awg0.conf" ] && has_awg3=1
  if [ "$has_awg2" -eq 0 ] && [ "$has_awg3" -eq 0 ]; then
    return 2
  fi

  awg_was_running=0
  awg3_was_running=0
  agent_was_running=0
  container_is_running amnezia-awg2 && awg_was_running=1
  container_is_running amnezia-awg3 && awg3_was_running=1
  container_is_running amnezia-node-agent && agent_was_running=1

  if [ "$agent_was_running" -eq 1 ]; then
    compose stop --timeout 30 node-agent >/dev/null
  fi
  if [ "$awg_was_running" -eq 1 ]; then
    compose stop --timeout 30 awg2 >/dev/null
  fi
  if [ "$awg3_was_running" -eq 1 ]; then
    compose stop --timeout 30 awg3 >/dev/null
  fi

  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  egress_stage="$NODE_DIR/egress"
  rm -rf "$egress_stage"
  mkdir -m 700 "$egress_stage"
  egress_mode="$(env_value AWG3_EGRESS_MODE)"
  case "$egress_mode" in
    masquerade|routed) ;;
    *) egress_mode="masquerade" ;;
  esac
  {
    printf 'SCHEMA_VERSION=1\n'
    printf 'AWG3_EGRESS_MODE=%s\n' "$egress_mode"
    printf 'CREATED_AT=%s\n' "$timestamp"
  } >"$egress_stage/meta.env"
  chmod 600 "$egress_stage/meta.env"
  if [ -f "$EGRESS_STATE_FILE" ] && [ ! -L "$EGRESS_STATE_FILE" ]; then
    cp "$EGRESS_STATE_FILE" "$egress_stage/state.json"
    chmod 600 "$egress_stage/state.json"
  fi

  set -- "egress"
  [ "$has_awg2" -eq 1 ] && set -- "$@" "state/amnezia-awg2"
  [ "$has_awg3" -eq 1 ] && set -- "$@" "state/amnezia-awg3"

  archive="$BACKUP_DIR/amnezia-node-$timestamp.tar.gz"
  [ ! -e "$archive" ] || archive="$BACKUP_DIR/amnezia-node-$timestamp-$$.tar.gz"
  temporary="$archive.tmp"

  if ! tar -C "$NODE_DIR" -czf "$temporary" "$@"; then
    rm -rf "$egress_stage" "$temporary"
    restart_services "$awg_was_running" "$agent_was_running" "$awg3_was_running"
    return 1
  fi
  rm -rf "$egress_stage"

  if ! chmod 600 "$temporary" || ! tar -tzf "$temporary" >/dev/null; then
    rm -f "$temporary"
    restart_services "$awg_was_running" "$agent_was_running" "$awg3_was_running"
    return 1
  fi
  mv "$temporary" "$archive"
  archive_name="$(basename -- "$archive")"
  if ! (cd "$BACKUP_DIR" && sha256sum "$archive_name") >"$archive.sha256"; then
    rm -f "$archive" "$archive.sha256"
    restart_services "$awg_was_running" "$agent_was_running" "$awg3_was_running"
    return 1
  fi
  chmod 600 "$archive.sha256"

  if [ "$restart_after" -eq 1 ]; then
    restart_services "$awg_was_running" "$agent_was_running" "$awg3_was_running"
  fi

  prune_node_backups
  printf '%s\n' "$archive"
}

restart_services() {
  awg_was_running="$1"
  agent_was_running="$2"
  awg3_was_running="${3:-0}"

  if [ "$awg_was_running" -eq 1 ]; then
    compose start awg2 >/dev/null
    wait_healthy amnezia-awg2 || fail "AWG2 did not recover after backup"
  fi
  if [ "$awg3_was_running" -eq 1 ]; then
    compose start awg3 >/dev/null
    wait_healthy amnezia-awg3 || fail "AWG3 did not recover after backup"
  fi
  if [ "$agent_was_running" -eq 1 ]; then
    compose start node-agent >/dev/null
    wait_healthy amnezia-node-agent || fail "node-agent did not recover after backup"
  fi
}

validate_backup_archive() {
  archive="$1"
  [ -f "$archive" ] || fail "backup archive not found: $archive"
  [ ! -L "$archive" ] || fail "backup archive must not be a symlink"
  tar -tzf "$archive" >/dev/null || fail "backup archive is unreadable"

  if tar -tzf "$archive" | awk '
    /^\// { bad=1 }
    /(^|\/)\.\.($|\/)/ { bad=1 }
    {
      if ($0 ~ /^state\/amnezia-awg[23](\/|$)/) next
      if ($0 == "egress" || $0 == "egress/" || $0 == "egress/state.json" || $0 == "egress/meta.env") next
      bad=1
    }
    END { exit bad ? 0 : 1 }
  '; then
    fail "backup archive contains an unsafe path"
  fi

  if tar -tvzf "$archive" | awk '{ type=substr($1,1,1); if (type != "d" && type != "-") found=1 } END { exit found ? 0 : 1 }'; then
    fail "backup archive contains links or special files"
  fi
}
