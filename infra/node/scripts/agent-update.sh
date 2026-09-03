#!/usr/bin/env bash
# Host-side worker for the panel's "update this node's agent" button.
#
# This is a port of infra/prod/panel-updater.sh, which does the same job for the
# panel itself. Read that script and docs/UPDATE-MECHANISM.md first: the lock
# placement, the /proc verification and the mktemp+rename of the result file are
# security properties, not style, and they are kept here deliberately.
#
# The node-agent container mounts only /var/run/docker.sock, so it cannot read
# compose.yaml, cannot write .env, and has no compose binary - it therefore
# cannot durably update itself. Instead it drops a request file into a shared
# spool; the amnezia-node-agent-update.path unit notices it and starts
# amnezia-node-agent-update.service, which runs THIS script. Install with
# infra/node/scripts/install-agent-updater.sh.
#
# bash rather than the #!/bin/sh used by the other node scripts: this runs from
# systemd on the host, never from the deploy path, and the port keeps the
# original's bash-only string handling instead of re-deriving it in POSIX sh.
set -uo pipefail

NODE_DIR="${AMNEZIA_NODE_DIR:-/opt/amnezia-node}"
SPOOL_DIR="${NODE_UPDATE_SPOOL_DIR:-/var/lib/amnezia-node/update}"
# The lock lives OUTSIDE the spool. The spool is owned by the agent container's
# uid, so anything inside it can be swapped for a symlink before root opens it.
# /run is root-only and is not mounted into any container.
LOCK_DIR="${NODE_UPDATER_LOCK_DIR:-/run/amnezia-node}"
UPDATE_REPO="${NODE_AGENT_UPDATE_REPO:-}"
REQUEST="${SPOOL_DIR}/request.json"
RESULT="${SPOOL_DIR}/result.json"
LOG_PUBLIC="${SPOOL_DIR}/update.log"
ENV_FILE="${NODE_DIR}/.env"
COMPOSE_FILE="${NODE_DIR}/compose.yaml"
AGENT_CONTAINER="${NODE_AGENT_CONTAINER:-amnezia-node-agent}"
AGENT_SERVICE=node-agent
# Where the published image carries the deployment files it expects. An image
# built before this feature ships none, which is a supported case.
IMAGE_DEPLOY_DIR="${NODE_AGENT_IMAGE_DEPLOY_DIR:-/opt/node-agent/deploy}"
HEALTH_ATTEMPTS="${NODE_AGENT_HEALTH_ATTEMPTS:-45}"

# Overwritten once the request body is parsed. write_result() is defined this
# early because the refusal branch below reports through it before the body has
# been read.
ID="unknown"
IMAGE=""

LOG="$(mktemp)"
SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH"; rm -f "$LOG"; }
trap cleanup EXIT

log() { printf '%s\n' "$*" >>"$LOG"; }

# The agent serves the result and the log back to the panel, so both have to be
# readable by the container uid. mktemp gives 0600 root-owned files; without the
# chmod the panel would poll a file it is not allowed to open.
publish() {
  local src="$1" dest="$2" tmp
  tmp="$(mktemp "${SPOOL_DIR}/publish.XXXXXX")" || return 1
  cat "$src" >"$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
}

write_result() {
  local ok="$1" msg="$2" ts tmp
  ts="$(date -u -Iseconds)"
  # Minimal JSON escaping for the message (backslash, quote, newline).
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  msg="${msg//$'\n'/ }"
  # Write to a FRESH random file in the spool (mktemp: O_EXCL, unpredictable
  # name - the container can't pre-plant a symlink at it), then rename onto
  # $RESULT. A same-filesystem rename() replaces whatever is at $RESULT (even a
  # planted symlink) instead of writing through it as root.
  tmp="$(mktemp "${SPOOL_DIR}/result.XXXXXX")" || return 1
  printf '{"id":"%s","finishedAt":"%s","ok":%s,"image":"%s","message":"%s"}\n' \
    "$ID" "$ts" "$ok" "$IMAGE" "$msg" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$RESULT"
  publish "$LOG" "$LOG_PUBLIC" || true
}

fail_out() {
  log "ERROR: $1"
  write_result false "$1"
  exit 1
}

[ -e "$REQUEST" ] || exit 0   # nothing to do

# Never run two updates at once (the path unit can re-fire during a long run).
# flock(2) on a read-only descriptor of a root-owned directory: nothing is
# created, truncated or written through, so there is no file to pre-plant. The
# directory is created here rather than by systemd's RuntimeDirectory=, which
# would delete and recreate it around every run - two overlapping runs would
# then lock two different inodes and neither would wait. mkdir -p accepts a
# pre-existing directory whoever owns it, so tighten the mode explicitly.
mkdir -p "$LOCK_DIR"
chmod 0700 "$LOCK_DIR"
exec 9<"$LOCK_DIR"
if ! flock -n 9; then
  # Deliberately does NOT write a result. This branch leaves request.json in
  # place, and the path unit is level-triggered (PathExists=), so it re-arms and
  # the request is retried once the running update finishes. The panel keeps
  # showing it as pending, which is exactly what is true.
  echo "agent-update: another run holds the lock; skipping"
  exit 0
fi

# The spool is writable by the agent container, so treat its contents as
# untrusted. Open the request ONCE and then ask the kernel what was opened:
# /proc/<pid>/fd/8 resolves to the real file. If request.json was a symlink
# (e.g. -> /etc/shadow) the descriptor points at the target, not at the spool
# path, and we refuse without ever reading it as root. Checking the descriptor
# rather than the path closes the window between a `-L` test and a re-open.
if ! exec 8<"$REQUEST"; then
  exit 0   # vanished between the existence check and the open
fi
EXPECTED="$(readlink -f -- "$SPOOL_DIR")/request.json"
OPENED="$(readlink -- "/proc/$$/fd/8")"
if [ "$OPENED" != "$EXPECTED" ] || [ ! -f "/proc/$$/fd/8" ]; then
  echo "agent-update: request file is not a regular spool file - refusing" >&2
  exec 8<&-
  rm -f "$REQUEST"
  # The request is consumed and nothing will retry it, so the panel must be
  # told: without this the operator sees a stale result and cannot tell it from
  # "no update was ever requested".
  write_result false "request file is not a regular spool file"
  exit 1
fi
BODY="$(head -c 4096 <&8)"
exec 8<&-

json_field() {
  printf '%s' "$BODY" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}
ID="$(json_field id)"
[ -n "$ID" ] || ID="unknown"
IMAGE="$(json_field image)"

# Consume the request up front - a failure must not loop the path unit.
rm -f "$REQUEST"

log "agent-update ${ID}: requested image ${IMAGE:-<none>}"

# --- Re-validate the reference ------------------------------------------------
# The agent validated this before writing the spool file, and the updater checks
# it again anyway: the spool is a file on disk and the two components have
# different threat models. Only a digest inside the configured repository is
# accepted - a tag is mutable, so what the admin confirmed would not be what the
# node installs.
[ -n "$UPDATE_REPO" ] || fail_out "NODE_AGENT_UPDATE_REPO is not configured on this host"
case "$IMAGE" in
  "${UPDATE_REPO}@sha256:"*) ;;
  *) fail_out "reference is not a digest in ${UPDATE_REPO}" ;;
esac
printf '%s' "${IMAGE#*@}" | grep -Eq '^sha256:[0-9a-f]{64}$' \
  || fail_out "reference does not carry a full sha256 digest"

[ -f "$ENV_FILE" ] || fail_out "no .env at ${ENV_FILE}"
[ -f "$COMPOSE_FILE" ] || fail_out "no compose.yaml at ${COMPOSE_FILE}"

CURRENT_IMAGE="$(sed -n 's/^NODE_AGENT_IMAGE=//p' "$ENV_FILE" | tail -n 1)"
if [ "$CURRENT_IMAGE" = "$IMAGE" ]; then
  log "the node already runs this digest; nothing to do"
  write_result true "already running ${IMAGE}"
  exit 0
fi

# --- Pull and check the image -------------------------------------------------
if ! docker pull --platform linux/amd64 "$IMAGE" >>"$LOG" 2>&1; then
  fail_out "docker pull failed for ${IMAGE}"
fi
os="$(docker image inspect --format '{{.Os}}' "$IMAGE" 2>/dev/null)"
arch="$(docker image inspect --format '{{.Architecture}}' "$IMAGE" 2>/dev/null)"
[ "$os" = "linux" ] && [ "$arch" = "amd64" ] \
  || fail_out "pulled image is not linux/amd64 (${os:-?}/${arch:-?})"

# --- Reconcile the deployment files ------------------------------------------
# Both images are on this host right now - the old one is running, the new one
# has just been pulled - so the node's compose.yaml can be compared against the
# file each of them ships. That is what makes "the node's file is unmodified"
# provable rather than assumed.
extract_from_image() {
  local image="$1" name="$2" dest="$3" cname
  cname="amnezia-agent-update-$$-${RANDOM}"
  docker create --name "$cname" "$image" >/dev/null 2>&1 || return 1
  local rc=0
  docker cp "${cname}:${IMAGE_DEPLOY_DIR}/${name}" "$dest" >/dev/null 2>&1 || rc=1
  docker rm "$cname" >/dev/null 2>&1 || true
  return "$rc"
}

NEW_COMPOSE="${SCRATCH}/new-compose.yaml"
OLD_COMPOSE="${SCRATCH}/old-compose.yaml"
new_ships=0
old_ships=0
extract_from_image "$IMAGE" compose.yaml "$NEW_COMPOSE" && new_ships=1
[ -z "$CURRENT_IMAGE" ] || { extract_from_image "$CURRENT_IMAGE" compose.yaml "$OLD_COMPOSE" && old_ships=1; }

apply_compose=0
if [ "$new_ships" -eq 1 ] && ! cmp -s "$NEW_COMPOSE" "$COMPOSE_FILE"; then
  if [ "$old_ships" -eq 1 ] && cmp -s "$OLD_COMPOSE" "$COMPOSE_FILE"; then
    # The node's file is byte-identical to what the running image shipped, so
    # nobody has edited it here and it is safe to move it forward.
    apply_compose=1
    log "the node's compose.yaml is unmodified; applying the one shipped by the new image"
  elif [ "$old_ships" -eq 1 ]; then
    # Never merge, never overwrite: a node's compose may carry deliberate local
    # changes (a shared host, a different port, another tenant's constraint),
    # and silently replacing it is how a node loses its own configuration.
    log "the node's compose.yaml differs from the one its current image shipped:"
    diff -u "$COMPOSE_FILE" "$OLD_COMPOSE" >>"$LOG" 2>&1 || true
    log "the new image expects:"
    diff -u "$COMPOSE_FILE" "$NEW_COMPOSE" >>"$LOG" 2>&1 || true
    fail_out "compose.yaml has local edits on this node; reconcile it by hand on the server, then retry"
  else
    # The running image predates shipped deployment files, so the node's file
    # has no provenance and cannot be shown to be untouched. Blocking here would
    # make the very first update impossible on every existing node, so the
    # update proceeds on the image-only path and says what was not reconciled.
    log "WARNING: the new image ships a different compose.yaml, but the running image"
    log "WARNING: ships none, so this node's file cannot be shown to be unmodified."
    log "WARNING: continuing without touching it. Reconcile by hand if the agent needs it:"
    diff -u "$COMPOSE_FILE" "$NEW_COMPOSE" >>"$LOG" 2>&1 || true
  fi
fi

EFFECTIVE_COMPOSE="$COMPOSE_FILE"
[ "$apply_compose" -eq 0 ] || EFFECTIVE_COMPOSE="$NEW_COMPOSE"

# A compose file declares its own required keys as ${KEY:?...}. Anything named
# that way and missing from .env is site-specific by definition - the updater
# cannot invent a value, so it says so instead of starting a container that
# would fail at once.
missing_keys=''
while read -r key; do
  [ -n "$key" ] || continue
  grep -Eq "^${key}=" "$ENV_FILE" || missing_keys="${missing_keys} ${key}"
done <<EOF
$(grep -oE '\$\{[A-Z0-9_]+:\?' "$EFFECTIVE_COMPOSE" 2>/dev/null | sed 's/^\${//; s/:?$//' | sort -u)
EOF
if [ -n "$missing_keys" ]; then
  fail_out "the new compose requires .env keys this node does not set:${missing_keys}"
fi

# Keys with a default are reported, never invented. The compose file is the
# authority on what the agent reads, and a ${KEY:-default} it can fall back to is
# not a failure - but an operator who never hears about it cannot set it either.
new_keys=''
while read -r key; do
  [ -n "$key" ] || continue
  grep -Eq "^${key}=" "$ENV_FILE" || new_keys="${new_keys} ${key}"
done <<EOF
$(grep -oE '\$\{[A-Z0-9_]+:-' "$EFFECTIVE_COMPOSE" 2>/dev/null | sed 's/^\${//; s/:-$//' | sort -u)
EOF
[ -z "$new_keys" ] || log "NOTE: the new compose reads .env keys this node does not set (defaults apply):${new_keys}"

# --- Swap the agent -----------------------------------------------------------
ENV_BACKUP="${SCRATCH}/env.backup"
COMPOSE_BACKUP="${SCRATCH}/compose.backup"
cp "$ENV_FILE" "$ENV_BACKUP"
cp "$COMPOSE_FILE" "$COMPOSE_BACKUP"

write_env_image() {
  local value="$1" env_tmp
  env_tmp="$(mktemp "${NODE_DIR}/.env.XXXXXX")" || return 1
  awk -v value="$value" '
    /^NODE_AGENT_IMAGE=/ && !seen { print "NODE_AGENT_IMAGE=" value; seen = 1; next }
    { print }
    END { if (!seen) print "NODE_AGENT_IMAGE=" value }
  ' "$ENV_FILE" >"$env_tmp" || { rm -f "$env_tmp"; return 1; }
  # A truncated .env fails ${NODE_AGENT_IMAGE:?} in compose and takes the node
  # down at the next deploy, so the new file is written whole and then renamed.
  # `mv -f` carries the temp file's mode onto the target, so the mode is set
  # here rather than inherited from the umask.
  chmod 600 "$env_tmp"
  mv -f "$env_tmp" "$ENV_FILE"
}

agent_up() {
  # --no-deps is required, not optional: node-agent declares depends_on awg2 and
  # awg3, so without it compose recreates both and every live tunnel drops.
  docker compose --project-directory "$NODE_DIR" --env-file "$ENV_FILE" --file "$COMPOSE_FILE" up --detach --no-deps --no-build "$AGENT_SERVICE" >>"$LOG" 2>&1
}

agent_healthy() {
  local attempt=0 status
  while [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$AGENT_CONTAINER" 2>/dev/null || true)"
    case "$status" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

rollback() {
  log "rolling back to ${CURRENT_IMAGE}"
  cp -f "$ENV_BACKUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cp -f "$COMPOSE_BACKUP" "$COMPOSE_FILE"
  agent_up || log "WARNING: the rollback could not recreate the agent"
}

if [ "$apply_compose" -eq 1 ]; then
  cp -f "$NEW_COMPOSE" "$COMPOSE_FILE"
fi
write_env_image "$IMAGE" || fail_out "could not rewrite ${ENV_FILE}"

if ! agent_up; then
  rollback
  fail_out "the agent could not be recreated; rolled back to ${CURRENT_IMAGE}"
fi

if ! agent_healthy; then
  # A node whose agent will not start has lost its whole management path, and
  # the panel is the tool you would use to notice.
  rollback
  fail_out "the new agent failed its health gate; rolled back to ${CURRENT_IMAGE}"
fi

log "agent-update ${ID}: now running ${IMAGE}"
write_result true "updated to ${IMAGE}"
