#!/usr/bin/env bash
# Host-side worker for the panel's "change this node's capacity" button.
#
# SERVER_MAX_PEERS lives in the node's .env and is fixed at container creation.
# The node-agent container mounts only /var/run/docker.sock: it cannot write
# .env - which the node's own preflight validates - and has no compose binary,
# so it cannot put a new value into effect. Instead it drops a request file into
# a shared spool; the amnezia-node-capacity.path unit notices it and starts
# amnezia-node-capacity.service, which runs THIS script. Install with
# infra/node/scripts/install-capacity-applier.sh.
#
# The actual change is delegated, unchanged, to scripts/set-capacity.sh: it
# recreates ONLY the node-agent (--no-deps), so tunnels stay up, and it restores
# the previous value itself if the agent does not come back healthy. This script
# is the plumbing between a spool file and that script, and nothing more.
#
# The lock placement, the /proc verification and the mktemp+rename of the result
# are copied deliberately from agent-update.sh, which ports them from
# infra/prod/panel-updater.sh. They are security properties, not style: the
# spool is writable by a container, and this runs as root.
#
# bash rather than the #!/bin/sh used by the other node scripts, for the same
# reason agent-update.sh uses it: this runs from systemd on the host, never from
# the deploy path.
set -uo pipefail

NODE_DIR="${AMNEZIA_NODE_DIR:-/opt/amnezia-node}"
SPOOL_DIR="${NODE_CAPACITY_SPOOL_DIR:-/var/lib/amnezia-node/capacity}"
# The lock lives OUTSIDE the spool. The spool is owned by the agent container's
# uid, so anything inside it can be swapped for a symlink before root opens it.
# /run is root-only and is not mounted into any container.
LOCK_DIR="${NODE_CAPACITY_LOCK_DIR:-/run/amnezia-node-capacity}"
REQUEST="${SPOOL_DIR}/request.json"
RESULT="${SPOOL_DIR}/result.json"
LOG_PUBLIC="${SPOOL_DIR}/apply.log"
ENV_FILE="${NODE_DIR}/.env"
COMPOSE_FILE="${NODE_DIR}/compose.yaml"

# The validated ceiling. set-capacity.sh accepts up to 1000 behind --force, and
# this path never passes --force: an unvalidated capacity is an operator's
# decision at a shell, not something a button reaches.
MAX_PEERS=500

# Overwritten once the request body is parsed. write_result() is defined this
# early because the refusal branches below report through it before the body has
# been read.
ID="unknown"
PEERS=0

LOG="$(mktemp)"
cleanup() { rm -f "$LOG"; }
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
  printf '{"id":"%s","finishedAt":"%s","ok":%s,"maxPeers":%s,"message":"%s"}\n' \
    "$ID" "$ts" "$ok" "$PEERS" "$msg" >"$tmp"
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

# Never run two changes at once (the path unit can re-fire during a long run).
# flock(2) on a read-only descriptor of a root-owned directory: nothing is
# created, truncated or written through, so there is no file to pre-plant. The
# directory is created here rather than by systemd's RuntimeDirectory=, which
# would delete and recreate it around every run - two overlapping runs would
# then lock two different inodes and neither would wait.
mkdir -p "$LOCK_DIR"
chmod 0700 "$LOCK_DIR"
exec 9<"$LOCK_DIR"
if ! flock -n 9; then
  # Deliberately does NOT write a result. This branch leaves request.json in
  # place, and the path unit is level-triggered (PathExists=), so it re-arms and
  # the request is retried once the running change finishes. The panel keeps
  # showing it as pending, which is exactly what is true.
  echo "capacity-apply: another run holds the lock; skipping"
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
  echo "capacity-apply: request file is not a regular spool file - refusing" >&2
  exec 8<&-
  rm -f "$REQUEST"
  # The request is consumed and nothing will retry it, so the panel must be
  # told: without this the operator sees a stale result and cannot tell it from
  # "no change was ever requested".
  write_result false "request file is not a regular spool file"
  exit 1
fi
BODY="$(head -c 4096 <&8)"
exec 8<&-

json_string() {
  printf '%s' "$BODY" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}
json_number() {
  printf '%s' "$BODY" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p" | head -n1
}
ID="$(json_string id)"
[ -n "$ID" ] || ID="unknown"
REQUESTED="$(json_number maxPeers)"

# Consume the request up front - a failure must not loop the path unit.
rm -f "$REQUEST"

# --- Re-validate the number ---------------------------------------------------
# The agent validated this before writing the spool file, and this script checks
# it again anyway: the spool is a file on disk and the two components have
# different threat models. set-capacity.sh will validate it a third time; that
# is the point of the layering, not duplication to be cleaned up.
case "$REQUESTED" in
  ''|*[!0-9]*) fail_out "maxPeers is missing or not a whole number" ;;
esac
PEERS="$REQUESTED"
[ "$PEERS" -ge 1 ] || fail_out "maxPeers must be at least 1"
[ "$PEERS" -le "$MAX_PEERS" ] \
  || fail_out "maxPeers ${PEERS} is above the validated limit of ${MAX_PEERS}; change it at a shell with --force if that is really intended"

log "capacity-apply ${ID}: requested SERVER_MAX_PEERS=${PEERS}"

[ -f "$ENV_FILE" ] || fail_out "no .env at ${ENV_FILE}"
[ -f "$COMPOSE_FILE" ] || fail_out "no compose.yaml at ${COMPOSE_FILE}"
[ -f "${NODE_DIR}/scripts/set-capacity.sh" ] \
  || fail_out "this node has no scripts/set-capacity.sh - it predates the capacity feature and must be re-provisioned"

CURRENT="$(sed -n 's/^SERVER_MAX_PEERS=//p' "$ENV_FILE" | tail -n 1)"
if [ "$CURRENT" = "$PEERS" ]; then
  log "the node already runs SERVER_MAX_PEERS=${PEERS}; nothing to do"
  write_result true "already at ${PEERS}"
  exit 0
fi

# --- Apply --------------------------------------------------------------------
# Everything that matters happens in set-capacity.sh: the preflight, the memory
# arithmetic, the --no-deps recreate that leaves the tunnels alone, and the
# automatic restore if the agent does not come back healthy.
if ! ( cd "$NODE_DIR" && sh scripts/set-capacity.sh "$PEERS" ) >>"$LOG" 2>&1; then
  fail_out "set-capacity.sh refused or failed for ${PEERS} (previous value ${CURRENT:-unset} restored if it had been changed)"
fi

APPLIED="$(sed -n 's/^SERVER_MAX_PEERS=//p' "$ENV_FILE" | tail -n 1)"
if [ "$APPLIED" != "$PEERS" ]; then
  # set-capacity.sh rolled back after an unhealthy agent. It exited non-zero in
  # that case, so this is belt and braces - but reporting success for a value
  # the node is not running is the one outcome the panel must never show.
  fail_out "set-capacity.sh finished but .env still says ${APPLIED:-unset}"
fi

log "capacity-apply ${ID}: SERVER_MAX_PEERS=${PEERS} applied"
write_result true "SERVER_MAX_PEERS=${PEERS} applied"
