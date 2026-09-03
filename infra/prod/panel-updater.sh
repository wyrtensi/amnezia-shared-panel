#!/usr/bin/env bash
# Host-side worker for the in-panel "Update" button.
#
# control-api (inside docker compose) cannot restart the stack itself, so the
# button drops a request file into a shared spool. The panel-updater.path unit
# notices it and starts panel-updater.service, which runs THIS script: it runs
# infra/prod/update.sh and writes the outcome back into the spool for the panel
# to display. Install with infra/prod/install-updater.sh.
# The lock is held on $PANEL_UPDATER_LOCK_DIR (default /run/amnezia-panel), never in the spool.
set -uo pipefail

REPO_DIR="${PANEL_REPO_DIR:-/opt/amnezia-panel}"
SPOOL_DIR="${UPDATE_SPOOL_HOST_DIR:-/var/lib/amnezia-panel/update}"
# The lock lives OUTSIDE the spool. The spool is owned by the container uid
# (install-updater.sh), so anything inside it can be swapped for a symlink
# before root opens it. /run is root-only and is not mounted into any container.
LOCK_DIR="${PANEL_UPDATER_LOCK_DIR:-/run/amnezia-panel}"
REQUEST="${SPOOL_DIR}/request.json"
RESULT="${SPOOL_DIR}/result.json"

[ -e "$REQUEST" ] || exit 0   # nothing to do

# Never run two updates at once (path unit could re-fire during a long run).
# flock(2) on a read-only descriptor of a root-owned directory: nothing is
# created, truncated or written through, so there is no file to pre-plant.
# The directory is created here rather than by systemd's RuntimeDirectory=,
# which would delete and recreate it around every run — two overlapping runs
# would then lock two different inodes and neither would wait. mkdir -p accepts
# a pre-existing directory whoever owns it, so tighten the mode explicitly.
mkdir -p "$LOCK_DIR"
chmod 0700 "$LOCK_DIR"
exec 9<"$LOCK_DIR"
if ! flock -n 9; then
  echo "panel-updater: another run holds the lock; skipping"
  exit 0
fi

# The spool is writable by the container (uid 1000), so treat its contents as
# untrusted. Open the request ONCE and then ask the kernel what was opened:
# /proc/<pid>/fd/8 resolves to the real file. If request.json was a symlink
# (e.g. -> /etc/shadow) the descriptor points at the target, not at the spool
# path, and we refuse without ever reading it as root. Checking the descriptor
# rather than the path closes the window between a `-L` test and a re-open.
# (Outside POSIX mode bash reports a failed `exec` redirection instead of
# exiting, so the `if` below works.)
if ! exec 8<"$REQUEST"; then
  exit 0   # vanished between the existence check and the open
fi
EXPECTED="$(readlink -f -- "$SPOOL_DIR")/request.json"
OPENED="$(readlink -- "/proc/$$/fd/8")"
if [ "$OPENED" != "$EXPECTED" ] || [ ! -f "/proc/$$/fd/8" ]; then
  echo "panel-updater: request file is not a regular spool file — refusing" >&2
  exec 8<&-
  rm -f "$REQUEST"
  exit 1
fi
# Read the body once (bounded), close the descriptor; nothing re-opens the path.
BODY="$(head -c 4096 <&8)"
exec 8<&-

# Request id, so the panel can match this result to its request (best effort).
ID="$(printf '%s' "$BODY" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$ID" ] || ID="unknown"

# Consume the request up front — a failure must not loop the path unit.
rm -f "$REQUEST"

write_result() {
  local ok="$1" msg="$2" ts tmp
  ts="$(date -u -Iseconds)"
  # Minimal JSON escaping for the message (backslash, quote, newline).
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  msg="${msg//$'\n'/ }"
  # Write to a FRESH random file in the spool (mktemp: O_EXCL, unpredictable
  # name — the container can't pre-plant a symlink at it), then rename onto
  # $RESULT. A same-filesystem rename() replaces whatever is at $RESULT (even a
  # planted symlink) instead of writing through it as root.
  tmp="$(mktemp "${SPOOL_DIR}/result.XXXXXX")" || return 1
  printf '{"id":"%s","finishedAt":"%s","ok":%s,"message":"%s"}\n' \
    "$ID" "$ts" "$ok" "$msg" >"$tmp"
  mv -f "$tmp" "$RESULT"
}

if ! cd "$REPO_DIR"; then
  write_result false "repo dir $REPO_DIR not found"
  exit 1
fi

LOG="$(mktemp)"
if bash infra/prod/update.sh >"$LOG" 2>&1; then
  write_result true "$(tail -n 3 "$LOG")"
  rm -f "$LOG"
else
  code=$?
  write_result false "update.sh failed (exit $code): $(tail -n 5 "$LOG")"
  rm -f "$LOG"
  exit "$code"
fi
