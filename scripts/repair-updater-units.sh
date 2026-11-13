#!/usr/bin/env bash
# Repair the updater systemd units already installed on THIS host so they start
# their script through /bin/bash instead of relying on its mode bits.
#
# Background: a unit with `ExecStart=/path/to/updater.sh` fails with status
# 203/EXEC when the script is checked out 0644, and the level-triggered path
# unit then ends in `unit-start-limit-hit` while the panel keeps showing the
# request as pending. New installs render `ExecStart=/bin/bash <script>`
# (infra/prod/install-updater.sh, infra/node/scripts/install-agent-updater.sh,
# infra/bridge/install-bridge.sh); this tool fixes hosts installed earlier.
#
# It is self-contained on purpose: nodes only receive infra/node and bridges only
# infra/bridge, so run it from the panel checkout over SSH, for example
#   ssh root@host 'bash -s -- --dry-run' < scripts/repair-updater-units.sh
#
# What it does, per installed unit and independently of the others:
#   - reads the INSTALLED unit (not a template): its ExecStart, paths, lock
#     directory, spool and approved repository stay exactly as the host has them;
#   - inventories effective ExecStart, watcher state, whether an operation is
#     running and whether a request is pending;
#   - defers (changes nothing) while an operation runs or a request is pending:
#     the path unit is level-triggered, so rearming it would start that request;
#   - on an idle unit rewrites only the ExecStart line to `/bin/bash <script>`,
#     runs systemd-analyze verify first, installs the unit, reloads systemd,
#     clears an old failed state and returns the watcher to its previous
#     enablement: an enabled watcher is started and must be waiting, a disabled
#     one stays disabled and stopped;
#   - never triggers an update, never touches requests, results or the journal;
#   - reports an updater that is not installed as its own state (opt-in feature,
#     left disabled) together with the normal enablement step.
# A second run on a repaired host changes nothing.
#
# Usage: repair-updater-units.sh [--dry-run] [--json] [--unit-dir DIR]
#   --dry-run     print the inventory and the planned action, change nothing
#                 (no root needed)
#   --json        machine-readable output (one object per unit)
#   --unit-dir    where the installed unit files live (default /etc/systemd/system)
# Exit status: 0 nothing left to do; 2 at least one unit deferred (operation
# running or request pending); 3 at least one unit blocked or failed; 1 usage.
set -uo pipefail

UNIT_DIR="/etc/systemd/system"
# Same lookup as the installers: an ExecStart drop-in in any of these replaces ours.
UNIT_SEARCH_DIRS="${AMNEZIA_UNIT_SEARCH_DIRS:-}"
DRY_RUN=0
JSON=0

# One row per updater: label | unit base name (<base>.service + <base>.path) |
# Environment= variable naming the lock directory | expected script file name
# (any other ExecStart target is blocked, never rewritten) | enablement step when
# the updater is not installed. Add a row here to cover another updater.
UPDATERS=(
  "panel|panel-updater|PANEL_UPDATER_LOCK_DIR|panel-updater.sh|sudo bash infra/prod/install-updater.sh (from the panel checkout)"
  "node-agent|amnezia-node-agent-update|NODE_UPDATER_LOCK_DIR|agent-update.sh|sudo NODE_AGENT_UPDATE_REPO=<repo> bash scripts/install-agent-updater.sh (see docs/AGENT-HOST-SETUP.md)"
  "bridge-agent|amnezia-bridge-agent-update|BRIDGE_UPDATER_LOCK_DIR|bridge-agent-update.sh|re-run infra/bridge/install-bridge.sh with the pinned agent image (see infra/bridge/README.md)"
)

die() { echo "repair-updater-units: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --json) JSON=1 ;;
    --unit-dir) [ $# -ge 2 ] || die "--unit-dir needs a value"; UNIT_DIR="$2"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$UNIT_SEARCH_DIRS" ] || UNIT_SEARCH_DIRS="$UNIT_DIR /run/systemd/system /usr/lib/systemd/system"

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  die "run as root (or use --dry-run to only read state)"
fi

RECORDS=()
RC=0

jstr() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# Extract the value of a `Key=` line from an installed unit file.
unit_value() { sed -n "s/^$2=//p" "$1" | head -n 1; }

# Effective ExecStart command line (what systemd will run); fails when systemd
# does not answer.
effective_exec() {
  local out
  out="$(systemctl show -p ExecStart --value "$1.service" 2>/dev/null || true)"
  case "$out" in
    *"argv[]="*)
      out="${out#*argv\[\]=}"
      printf '%s' "${out%% ;*}"
      return 0 ;;
  esac
  # No fallback to the unit file: when systemd cannot say what it runs, the
  # caller must not assume the file is what is effective.
  return 1
}

human_age() {
  local s="$1"
  if [ "$s" -lt 120 ]; then printf '%ss' "$s"
  elif [ "$s" -lt 7200 ]; then printf '%sm' $((s / 60))
  elif [ "$s" -lt 172800 ]; then printf '%sh' $((s / 3600))
  else printf '%sd' $((s / 86400)); fi
}

# First existing trigger of the installed path unit: sets PEND_PATH.
find_pending() {
  local pathfile="$1" kind value match
  PEND_PATH=""
  while IFS='=' read -r kind value; do
    case "$kind" in
      PathExists) [ -e "$value" ] && { PEND_PATH="$value"; return 0; } ;;
      PathExistsGlob)
        # shellcheck disable=SC2086 # the glob is the point
        match="$(compgen -G "$value" | head -n 1)"
        [ -n "$match" ] && { PEND_PATH="$match"; return 0; } ;;
    esac
  done < <(grep -E '^(PathExists|PathExistsGlob)=' "$pathfile" 2>/dev/null)
  return 1
}

json_field() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1; }

# Describe the pending request: sets REQ_ID, REQ_AGE, REQ_STATUS.
describe_request() {
  local file="$1" dir id mtime now result state
  dir="$(dirname -- "$file")"
  REQ_ID="$(basename -- "$file")"; REQ_AGE="-"; REQ_STATUS="queued"
  if [ "$REQ_ID" = journal ]; then
    REQ_STATUS="interrupted-run"
  elif [ -f "$file" ] && [ ! -L "$file" ]; then
    id="$(json_field "$file" id)"
    [ -n "$id" ] || id="$(json_field "$file" operationId)"
    [ -n "$id" ] && REQ_ID="$id"
    for result in "$dir/result.json" "$dir/../results/$REQ_ID.json"; do
      [ -f "$result" ] || continue
      [ "$(json_field "$result" id)" = "$REQ_ID" ] || [ "$(json_field "$result" operationId)" = "$REQ_ID" ] || continue
      state="$(json_field "$result" state)"
      if [ -z "$state" ]; then
        if grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$result"; then state=succeeded
        elif grep -q '"ok"[[:space:]]*:[[:space:]]*false' "$result"; then state=failed; fi
      fi
      [ -n "$state" ] && REQ_STATUS="$state"
      break
    done
  fi
  mtime="$(stat -c %Y -- "$file" 2>/dev/null || true)"
  if [ -n "$mtime" ]; then
    now="$(date +%s)"
    REQ_AGE="$(human_age $((now - mtime)))"
  fi
}

lock_held() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 1
  ! ( exec 9<"$dir" && flock -n 9 )
}

# Drop-in files that set ExecStart replace the command we are about to fix.
dropin_overrides() {
  local dir conf
  for dir in $UNIT_SEARCH_DIRS; do
    for conf in "$dir/$1.service.d/"*.conf; do
      [ -f "$conf" ] || continue
      grep -Eq '^[[:space:]]*ExecStart[[:space:]]*=' "$conf" && { printf '%s' "$conf"; return 0; }
    done
  done
  return 1
}

# Sets I_RUNNING, I_PENDING and the request fields from the live host state.
# Called at inventory time and again right before the watcher is rearmed.
busy_check() {
  local base="$1" path_file="$2" lockdir="$3" svc_state
  I_RUNNING=no; I_PENDING=no; I_REQ_ID="-"; I_REQ_AGE="-"; I_REQ_STATUS="-"
  svc_state="$(systemctl is-active "$base.service" 2>/dev/null || true)"
  case "$svc_state" in active|activating|deactivating|reloading) I_RUNNING=yes ;; esac
  lock_held "$lockdir" && I_RUNNING=yes
  if find_pending "$path_file"; then
    I_PENDING=yes
    describe_request "$PEND_PATH"
    I_REQ_ID="$REQ_ID"; I_REQ_AGE="$REQ_AGE"; I_REQ_STATUS="$REQ_STATUS"
  fi
}

add_record() {
  # label outcome note
  local label="$1" outcome="$2" note="$3"
  RECORDS+=("$label|$outcome|$note|$I_BASE|$I_EXEC|$I_ENABLED|$I_WATCHER|$I_RUNNING|$I_PENDING|$I_REQ_ID|$I_REQ_AGE|$I_REQ_STATUS")
  case "$outcome" in
    blocked|failed) RC=3 ;;
    deferred-*) [ "$RC" -eq 3 ] || RC=2 ;;
  esac
}

process_unit() {
  local label="$1" base="$2" lockenv="$3" expected="$4" hint="$5"
  local svc_file="$UNIT_DIR/$base.service" path_file="$UNIT_DIR/$base.path"
  local file_exec raw_exec exec_lines dropin script lockdir rewrite=0 failed=0 tmpdir candidate want_active

  I_BASE="$base"; I_EXEC="-"; I_ENABLED="-"; I_WATCHER="-"; I_RUNNING="no"
  I_PENDING="no"; I_REQ_ID="-"; I_REQ_AGE="-"; I_REQ_STATUS="-"

  if [ ! -f "$svc_file" ] && [ ! -f "$path_file" ]; then
    add_record "$label" not-installed "optional updater is not installed and stays disabled; normal enablement step: $hint"
    return
  fi
  if [ ! -f "$svc_file" ] || [ ! -f "$path_file" ]; then
    add_record "$label" blocked "partial install: $base.service or $base.path is missing in $UNIT_DIR; run the installer: $hint"
    return
  fi

  I_ENABLED="$(systemctl is-enabled "$base.path" 2>/dev/null || true)"; [ -n "$I_ENABLED" ] || I_ENABLED=unknown
  I_WATCHER="$(systemctl is-active "$base.path" 2>/dev/null || true)"; [ -n "$I_WATCHER" ] || I_WATCHER=unknown

  local svc_state
  svc_state="$(systemctl is-active "$base.service" 2>/dev/null || true)"
  lockdir="$(unit_value "$svc_file" "Environment=$lockenv")"
  lockdir="${lockdir%\"}"; lockdir="${lockdir#\"}"
  busy_check "$base" "$path_file" "$lockdir"

  [ "$svc_state" = failed ] && failed=1
  [ "$I_WATCHER" = failed ] && failed=1

  if dropin="$(dropin_overrides "$base")"; then
    add_record "$label" blocked "ExecStart is overridden by drop-in $dropin; remove the override, then run this tool again"
    return
  fi
  if ! I_EXEC="$(effective_exec "$base")" || [ -z "$I_EXEC" ]; then
    I_EXEC="-"
    add_record "$label" blocked "systemd did not report an effective ExecStart; cannot rule out an override, fix systemctl access and run again"
    return
  fi

  # Exactly one plain ExecStart line, no prefix, no continuation.
  exec_lines="$(grep -Ec '^[[:space:]]*ExecStart[[:space:]]*=' "$svc_file")"
  if [ "$exec_lines" -ne 1 ]; then
    add_record "$label" blocked "$svc_file has $exec_lines ExecStart lines, expected exactly one; fix by hand"
    return
  fi
  raw_exec="$(grep -E '^[[:space:]]*ExecStart[[:space:]]*=' "$svc_file")"
  case "$raw_exec" in
    ExecStart=*) ;;
    *) add_record "$label" blocked "unrecognized ExecStart line '$raw_exec'; fix by hand"; return ;;
  esac
  file_exec="${raw_exec#ExecStart=}"
  case "$file_exec" in
    [-@+!:]*) add_record "$label" blocked "ExecStart '$file_exec' carries a systemd prefix; fix by hand"; return ;;
  esac
  case "$raw_exec" in
    *\\) add_record "$label" blocked "ExecStart is continued over several lines; fix by hand"; return ;;
  esac
  if [ "$I_EXEC" != "$file_exec" ]; then
    add_record "$label" blocked "effective ExecStart '$I_EXEC' differs from $svc_file; remove the override, then run this tool again"
    return
  fi

  case "$file_exec" in
    "/bin/bash "/*) script="${file_exec#/bin/bash }" ;;
    /*) script="$file_exec"; rewrite=1 ;;
    *) add_record "$label" blocked "unrecognized ExecStart '$file_exec'; fix by hand"; return ;;
  esac
  case "$script" in
    *[[:space:]]*) add_record "$label" blocked "script path '$script' contains whitespace; fix by hand"; return ;;
  esac
  if [ "${script##*/}" != "$expected" ]; then
    add_record "$label" blocked "ExecStart script '$script' is not the expected '$expected'; fix by hand"
    return
  fi

  if [ "$rewrite" -eq 0 ] && [ "$failed" -eq 0 ]; then
    add_record "$label" current "already starts through /bin/bash; nothing to do"
    return
  fi

  # Validate what the corrected unit needs, exactly like the installers do.
  if [ ! -x /bin/bash ]; then add_record "$label" blocked "/bin/bash is missing or not executable"; return; fi
  if [ ! -f "$script" ] || [ ! -r "$script" ]; then add_record "$label" blocked "script $script is not a readable file"; return; fi
  if ! /bin/bash -n "$script" 2>/dev/null; then add_record "$label" blocked "script $script has a Bash syntax error"; return; fi

  if [ "$I_RUNNING" = yes ]; then
    add_record "$label" deferred-running "an operation is running; run this tool again when it has finished"
    return
  fi
  if [ "$I_PENDING" = yes ]; then
    add_record "$label" deferred-pending "request $I_REQ_ID ($I_REQ_STATUS, age $I_REQ_AGE) is pending and the watcher is left as is; resume or cancel it explicitly, then run this tool again"
    return
  fi

  # Local helper: re-run the busy check and record a deferral when it now holds.
  recheck_busy_defer() {
    busy_check "$base" "$path_file" "$lockdir"
    if [ "$I_RUNNING" = yes ]; then
      add_record "$label" deferred-running "unit repaired, but an operation started meanwhile; the watcher was left untouched. Run this tool again when it has finished"
      return 0
    fi
    if [ "$I_PENDING" = yes ]; then
      add_record "$label" deferred-pending "unit repaired, but request $I_REQ_ID ($I_REQ_STATUS, age $I_REQ_AGE) appeared meanwhile; the watcher was left untouched. Resume or cancel it explicitly, then run this tool again"
      return 0
    fi
    return 1
  }

  want_active=0
  case "$I_ENABLED" in enabled|enabled-runtime) want_active=1 ;; esac

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$rewrite" -eq 1 ]; then
      add_record "$label" would-repair "would rewrite ExecStart to '/bin/bash $script', verify, reload, clear the failed state and restore the watcher (enabled: $I_ENABLED)"
    else
      add_record "$label" would-repair "would clear the failed state and restore the watcher (enabled: $I_ENABLED)"
    fi
    return
  fi

  tmpdir="$(mktemp -d)" || { add_record "$label" failed "cannot create a temp dir"; return; }
  if [ "$rewrite" -eq 1 ]; then
    candidate="$tmpdir/$base.service"
    if ! sed -E 's#^ExecStart=(/[^[:space:]]+)$#ExecStart=/bin/bash \1#' "$svc_file" >"$candidate" ||
       ! chmod --reference="$svc_file" "$candidate"; then
      rm -rf "$tmpdir"; add_record "$label" failed "cannot render the corrected unit"; return
    fi
    if ! systemd-analyze verify "$candidate" >"$tmpdir/verify.log" 2>&1; then
      add_record "$label" failed "systemd-analyze verify rejected the corrected unit; nothing changed ($(tr '\n' ' ' <"$tmpdir/verify.log" | cut -c1-200))"
      rm -rf "$tmpdir"; return
    fi
    if ! cp -p -- "$candidate" "$UNIT_DIR/.$base.service.repair" || ! mv -f -- "$UNIT_DIR/.$base.service.repair" "$svc_file"; then
      rm -f -- "$UNIT_DIR/.$base.service.repair"; rm -rf "$tmpdir"
      add_record "$label" failed "cannot install the corrected unit into $UNIT_DIR"; return
    fi
  fi
  rm -rf "$tmpdir"

  if ! systemctl daemon-reload; then add_record "$label" failed "systemctl daemon-reload failed after installing the unit"; return; fi
  if [ "$rewrite" -eq 1 ]; then
    I_EXEC="$(effective_exec "$base")"
    if [ "$I_EXEC" != "/bin/bash $script" ]; then
      add_record "$label" failed "effective ExecStart after reload is '$I_EXEC', expected '/bin/bash $script'"; return
    fi
  fi

  # The host can change while the unit is verified, installed and reloaded: look
  # again before anything is rearmed. The unit stays repaired; the watcher stays
  # exactly as it is.
  if recheck_busy_defer; then return; fi

  # Clear the old failed state (203/EXEC, unit-start-limit-hit) of both units.
  [ "$svc_state" = failed ] && systemctl reset-failed "$base.service" >/dev/null 2>&1
  [ "$I_WATCHER" = failed ] && systemctl reset-failed "$base.path" >/dev/null 2>&1

  # Back to the previous enablement. A disabled updater is never enabled here.
  if [ "$want_active" -eq 1 ]; then
    if [ "$(systemctl is-active "$base.path" 2>/dev/null || true)" != active ]; then
      if recheck_busy_defer; then return; fi
      systemctl start "$base.path" >/dev/null 2>&1 ||
        { add_record "$label" failed "could not start $base.path"; return; }
    fi
    I_WATCHER="$(systemctl show -p SubState --value "$base.path" 2>/dev/null || true)"
    if [ "$I_WATCHER" != waiting ]; then
      add_record "$label" failed "$base.path is '${I_WATCHER:-unknown}', expected 'waiting'"; return
    fi
  else
    I_WATCHER="$(systemctl is-active "$base.path" 2>/dev/null || true)"
  fi
  add_record "$label" repaired "unit repaired; watcher state: $I_WATCHER (enabled: $I_ENABLED); no update was triggered"
}

for row in "${UPDATERS[@]}"; do
  IFS='|' read -r r_label r_base r_lock r_script r_hint <<<"$row"
  process_unit "$r_label" "$r_base" "$r_lock" "$r_script" "$r_hint"
done

HOST="$(hostname 2>/dev/null || echo unknown)"

if [ "$JSON" -eq 1 ]; then
  printf '{"host":%s,"dryRun":%s,"units":[' "$(jstr "$HOST")" "$([ "$DRY_RUN" -eq 1 ] && echo true || echo false)"
  first=1
  for rec in "${RECORDS[@]}"; do
    IFS='|' read -r label outcome note base exec enabled watcher running pending rid rage rstatus <<<"$rec"
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"updater":%s,"unit":%s,"outcome":%s,"note":%s,"execStart":%s,"enabled":%s,"watcher":%s,"running":%s,"pending":%s,"requestId":%s,"requestAge":%s,"requestStatus":%s}' \
      "$(jstr "$label")" "$(jstr "$base")" "$(jstr "$outcome")" "$(jstr "$note")" "$(jstr "$exec")" \
      "$(jstr "$enabled")" "$(jstr "$watcher")" "$([ "$running" = yes ] && echo true || echo false)" \
      "$([ "$pending" = yes ] && echo true || echo false)" "$(jstr "$rid")" "$(jstr "$rage")" "$(jstr "$rstatus")"
  done
  printf ']}\n'
else
  printf 'host: %s%s\n' "$HOST" "$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run, nothing changed)')"
  printf '%-13s %-16s %-9s %-9s %-8s %-8s %s\n' UPDATER OUTCOME ENABLED WATCHER RUNNING PENDING REQUEST
  for rec in "${RECORDS[@]}"; do
    IFS='|' read -r label outcome note base exec enabled watcher running pending rid rage rstatus <<<"$rec"
    req="-"
    [ "$pending" = yes ] && req="$rid, $rstatus, age $rage"
    printf '%-13s %-16s %-9s %-9s %-8s %-8s %s\n' "$label" "$outcome" "$enabled" "$watcher" "$running" "$pending" "$req"
    printf '    unit:  %s\n    exec:  %s\n    note:  %s\n' "$base" "$exec" "$note"
  done
fi
exit "$RC"
