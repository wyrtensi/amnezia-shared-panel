#!/usr/bin/env bash
# Host-side worker for the in-panel "Update" button.
#
# control-api (inside docker compose) cannot restart the stack itself, so the
# button drops a request file into a shared spool. The panel-updater.path unit
# notices it and starts panel-updater.service, which runs THIS script: it runs
# infra/prod/update.sh and writes the outcome back into the spool for the panel
# to display. Install with infra/prod/install-updater.sh.
set -uo pipefail

REPO_DIR="${PANEL_REPO_DIR:-/opt/amnezia-panel}"
SPOOL_DIR="${UPDATE_SPOOL_HOST_DIR:-/var/lib/amnezia-panel/update}"
REQUEST="${SPOOL_DIR}/request.json"
RESULT="${SPOOL_DIR}/result.json"
LOCK="${SPOOL_DIR}/.lock"

[ -f "$REQUEST" ] || exit 0   # nothing to do

# Never run two updates at once (path unit could re-fire during a long run).
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "panel-updater: another run holds the lock; skipping"
  exit 0
fi

# Request id, so the panel can match this result to its request (best effort).
ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST" | head -n1)"
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
  tmp="${RESULT}.tmp"
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
