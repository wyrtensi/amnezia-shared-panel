#!/usr/bin/env bash
# Host-side updater of an AWG node bridge's bridge-agent. Started by
# amnezia-bridge-agent-update.path (ExecStart=/bin/bash <this file>) whenever
# the agent drops a request into the spool, and whenever a journal of an
# interrupted run exists. install-bridge.sh installs the units.
#
# This is the bridge port of infra/node/scripts/agent-update.sh. Its security
# primitives are kept on purpose (read that script's comments): the lock is a
# read-only flock on a root-only directory outside the spool, a request is
# opened once and verified through /proc/<pid>/fd before it is read, every
# file the agent reads is written to a fresh mktemp name and renamed, the env
# file is rewritten whole, and every `compose up` carries --no-deps and names
# the single bridge-agent service. The node script cannot be sourced here:
# infra/bridge/ is the only directory copied to a bridge host (and infra/node/
# the only one copied to a node), so a helper shared across the two would be
# missing on one of them at run time.
#
# Trust boundary. The agent container (uid 0, every capability dropped, no
# Docker socket) can write only <spool>/requests; <spool>/results is mounted
# read-only into it. Everything in requests/ is untrusted. The approved
# repository comes from this unit's environment (BRIDGE_AGENT_UPDATE_REPO),
# the bridge id and port from agent.env, the rollback target from image.pin:
# all root-owned host files, never the request and never the pin's repository
# line.
#
# One operation, at most once:
#   request (agent) -> validate -> claim (result "queued", journal) -> re-read
#   the clock -> "expired" | "picked_up" -> "staging" (pull by digest) ->
#   "replacing" (agent.env + compose up --no-deps bridge-agent) ->
#   "health_check" (digest, identity, authenticated status with frps
#   reachable) -> "succeeded" (pin written) | rollback -> "rolled_back" |
#   "rollback_failed".
# The agent reports a result file verbatim and judges only an unclaimed
# request by the clock, so the claim is written before the deadline is checked
# again: an "expired" answer can never be followed by a start. An operation
# id that has any result is never applied again.
#
# Results carry fixed error codes only. Details (docker output) go to this
# unit's journal: journalctl -u amnezia-bridge-agent-update.service.
set -uo pipefail

BRIDGE_DIR="${AMNEZIA_BRIDGE_DIR:-/opt/amnezia-bridge}"
BRIDGE_ETC="${AMNEZIA_BRIDGE_ETC:-/etc/amnezia-bridge}"
SPOOL_DIR="${BRIDGE_UPDATE_SPOOL_DIR:-/var/lib/amnezia-bridge/update}"
# Root-only and never mounted into a container: the journal of the operation
# in progress and the backup of the pin it may have to restore.
STATE_DIR="${BRIDGE_UPDATER_STATE_DIR:-/var/lib/amnezia-bridge/updater}"
LOCK_DIR="${BRIDGE_UPDATER_LOCK_DIR:-/run/amnezia-bridge-updater}"
UPDATE_REPO="${BRIDGE_AGENT_UPDATE_REPO:-}"
HEALTH_ATTEMPTS="${BRIDGE_AGENT_HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${BRIDGE_AGENT_HEALTH_INTERVAL:-2}"

REQUESTS_DIR="${SPOOL_DIR}/requests"
RESULTS_DIR="${SPOOL_DIR}/results"
JOURNAL="${STATE_DIR}/journal"
PIN_BACKUP="${STATE_DIR}/image.pin.previous"
AGENT_DIR="${BRIDGE_ETC}/agent"
ENV_FILE="${AGENT_DIR}/agent.env"
PIN_FILE="${AGENT_DIR}/image.pin"
TOKEN_FILE="${AGENT_DIR}/api-token"
COMPOSE_FILE="${BRIDGE_DIR}/compose.yaml"
PROJECT=amnezia-bridge-agent
AGENT_SERVICE=bridge-agent
AGENT_CONTAINER=amnezia-bridge-agent

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'
REPO_RE='^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}$'
# Date#toISOString(), as the panel sends it and the agent validated it.
TIME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'

# The operation being worked on; set once a request or the journal is parsed.
OP_ID=""
OP_REPO=""
OP_DIGEST=""
OP_NOT_AFTER=""
CANDIDATE=""
PREVIOUS=""
# Set by health_gate(): the fixed code of the check that failed last.
GATE_CODE=""

log() { printf 'bridge-agent-update: %s\n' "$*"; }

# Whole-string match (a grep would accept a value whose first line matches).
matches() { [[ $1 =~ $2 ]]; }

# Writes stdin to a fresh temp file next to <dest> and renames it into place
# with <mode>. Fails (and leaves <dest> untouched) if any step fails, so a full
# disk never renames an empty file over a good one.
atomic_write() {
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp "$(dirname -- "$dest")/.$(basename -- "$dest").XXXXXX")" || return 1
  if ! cat >"$tmp" || ! chmod "$mode" "$tmp" || ! mv -f "$tmp" "$dest"; then
    rm -f -- "$tmp"
    return 1
  fi
}

now_ms() { date -u +%s%3N; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- results ------------------------------------------------------------------

# The agent reads this file back verbatim. Only validated values reach it: the
# intent fields are written only when they passed validation, the state is one
# of the agent's states and the error code is one of this script's fixed codes.
write_result() {
  local state="$1" code="${2:-}" body
  body="{\"operationId\":\"${OP_ID}\""
  [ -z "$OP_REPO" ] || body="${body},\"imageRepository\":\"${OP_REPO}\""
  [ -z "$OP_DIGEST" ] || body="${body},\"imageDigest\":\"${OP_DIGEST}\""
  [ -z "$OP_NOT_AFTER" ] || body="${body},\"notAfter\":\"${OP_NOT_AFTER}\""
  body="${body},\"state\":\"${state}\",\"updatedAt\":\"$(iso_now)\""
  [ -z "$code" ] || body="${body},\"errorCode\":\"${code}\""
  body="${body}}"
  # mktemp + rename: never a half-written result, never written through a
  # planted name (results/ is read-only to the agent, but the pattern is the
  # same as for every file the agent reads).
  if ! printf '%s\n' "$body" | atomic_write "${RESULTS_DIR}/${OP_ID}.json" 0644; then
    log "operation ${OP_ID}: cannot write the result ${state}"
    return 1
  fi
  log "operation ${OP_ID}: ${state}${code:+ (${code})}"
}

result_state() {
  sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p' "${RESULTS_DIR}/$1.json" 2>/dev/null | head -n 1
}

is_terminal() {
  case "$1" in
    succeeded|rolled_back|rollback_failed|failed|expired) return 0 ;;
    *) return 1 ;;
  esac
}

# --- journal ------------------------------------------------------------------

# KEY=VALUE lines of already validated values. Read back with sed, never
# sourced, and validated again on recovery.
write_journal() {
  local phase="$1"
  {
    printf 'OPERATION_ID=%s\n' "$OP_ID"
    printf 'PHASE=%s\n' "$phase"
    printf 'REPOSITORY=%s\n' "$OP_REPO"
    printf 'DIGEST=%s\n' "$OP_DIGEST"
    printf 'NOT_AFTER=%s\n' "$OP_NOT_AFTER"
    printf 'PREVIOUS=%s\n' "$PREVIOUS"
  } | atomic_write "$JOURNAL" 0600
}

journal_value() { sed -n "s/^$1=//p" "$JOURNAL" | head -n 1; }

# Order matters for recovery: the terminal result first, then the journal, then
# the request. A crash in between is cleaned up by the next run without acting.
# If the terminal result cannot be written, the journal and the request stay
# and the run stops: the next start retries instead of leaving an operation the
# agent reports as running forever.
finish() {
  local state="$1" code="${2:-}"
  if ! write_result "$state" "$code"; then
    log "operation ${OP_ID}: cannot record ${state}; keeping the journal and the request for the next run"
    exit 1
  fi
  rm -f "$JOURNAL" "$PIN_BACKUP"
  rm -f -- "${REQUESTS_DIR}/${OP_ID}.json"
}

# --- host files -----------------------------------------------------------------

env_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n 1; }

# agent.env is rewritten whole and renamed: a truncated file fails
# ${BRIDGE_AGENT_IMAGE:?} in compose and takes the agent down at the next start.
write_env_image() {
  local value="$1" content
  content="$(awk -v value="$value" '
    /^BRIDGE_AGENT_IMAGE=/ && !seen { print "BRIDGE_AGENT_IMAGE=" value; seen = 1; next }
    { print }
    END { if (!seen) print "BRIDGE_AGENT_IMAGE=" value }
  ' "$ENV_FILE")" || return 1
  printf '%s\n' "$content" | atomic_write "$ENV_FILE" 0600
}

# Written only after the health gate passed: the last known-good image.
write_pin() {
  {
    printf '# Written by bridge-agent-update.sh: the approved repository and the digest the agent runs.\n'
    printf 'BRIDGE_AGENT_IMAGE_REPOSITORY=%s\n' "$OP_REPO"
    printf 'BRIDGE_AGENT_IMAGE=%s\n' "$CANDIDATE"
  } | atomic_write "$PIN_FILE" 0600
}

restore_pin() {
  [ -f "$PIN_BACKUP" ] || return 0
  cmp -s "$PIN_BACKUP" "$PIN_FILE" 2>/dev/null && return 0
  atomic_write "$PIN_FILE" 0600 <"$PIN_BACKUP"
}

# --- docker -------------------------------------------------------------------

# --no-deps is required, not optional: only the bridge-agent is replaced, frps
# (a host service) and anything else are never touched.
agent_up() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" --file "$COMPOSE_FILE" up --detach --no-deps --no-build "$AGENT_SERVICE"
}

# One request to the agent on loopback. The bearer token goes in through a curl
# config on stdin, so it never appears in a process's arguments.
agent_get() {
  local path="$1" port token
  port="$(env_value BRIDGE_AGENT_PORT "$ENV_FILE")"
  [ -n "$port" ] || port=7600
  token="$(head -c 256 "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')"
  case "$token" in
    ''|*[!A-Za-z0-9._~+/=-]*) return 2 ;;
  esac
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -fsS --max-time 3 -K - "http://127.0.0.1:${port}${path}" 2>/dev/null | head -c 65536
}

# Passes only when (1) the agent container runs exactly <image>: its configured
# reference is the requested repo@digest and its image id is the id of that
# reference here, (2) /v1/identity names the enrolled bridge, and (3) an
# authenticated /v1/status answers for it with frps reachable. jq is not a host
# prerequisite; the agent's compact JSON is matched with fixed patterns.
health_gate() {
  local image="$1" want_id running identity status attempt=0 bridge_id
  bridge_id="$(env_value BRIDGE_ID "$ENV_FILE")"
  GATE_CODE="HEALTH_IMAGE_MISMATCH"
  want_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)"
  while [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -eq 1 ] || sleep "$HEALTH_INTERVAL"
    running="$(docker inspect --format '{{.Config.Image}}|{{.Image}}|{{.State.Running}}' "$AGENT_CONTAINER" 2>/dev/null)"
    if [ -z "$want_id" ] || [ "$running" != "${image}|${want_id}|true" ]; then
      GATE_CODE="HEALTH_IMAGE_MISMATCH"
      continue
    fi
    identity="$(agent_get /v1/identity)"
    if [ -z "$identity" ]; then
      GATE_CODE="HEALTH_AGENT_UNREACHABLE"
      continue
    fi
    if [ -z "$bridge_id" ] || ! printf '%s' "$identity" | grep -Fq "\"bridgeId\":\"${bridge_id}\""; then
      GATE_CODE="HEALTH_IDENTITY_MISMATCH"
      continue
    fi
    status="$(agent_get /v1/status)"
    if ! printf '%s' "$status" | grep -Fq "\"bridgeId\":\"${bridge_id}\""; then
      GATE_CODE="HEALTH_STATUS_FAILED"
      continue
    fi
    if ! printf '%s' "$status" | grep -Fq '"frps":{"reachable":true'; then
      GATE_CODE="HEALTH_FRPS_UNREACHABLE"
      continue
    fi
    GATE_CODE=""
    return 0
  done
  return 1
}

# --- outcomes -------------------------------------------------------------------

commit() {
  write_journal committing || { rollback "UPDATER_STATE_UNWRITABLE"; return; }
  if ! write_pin; then
    rollback "PIN_UNWRITABLE"
    return
  fi
  finish succeeded
}

# Restores the image of the last known-good pin (recorded in the journal when
# the operation started) and verifies it independently. A replacement was
# attempted, so the outcome is rolled_back or rollback_failed, never failed.
rollback() {
  local reason="$1"
  log "operation ${OP_ID}: rolling back to ${PREVIOUS} (${reason})"
  write_journal rolling_back || true
  write_result replacing "$reason"
  restore_pin || { finish rollback_failed ROLLBACK_PIN_UNWRITABLE; return; }
  if ! write_env_image "$PREVIOUS"; then
    finish rollback_failed ROLLBACK_ENV_UNWRITABLE
    return
  fi
  if ! agent_up; then
    finish rollback_failed ROLLBACK_START_FAILED
    return
  fi
  write_result health_check "$reason"
  if ! health_gate "$PREVIOUS"; then
    log "operation ${OP_ID}: the previous image failed its health gate too (${GATE_CODE})"
    finish rollback_failed ROLLBACK_VERIFICATION_FAILED
    return
  fi
  finish rolled_back "$reason"
}

# Runs an operation that was claimed and is still before its deadline.
apply() {
  local current os_arch
  write_journal picked_up || { finish failed UPDATER_STATE_UNWRITABLE; return; }
  write_result picked_up || { finish failed UPDATER_STATE_UNWRITABLE; return; }

  [ -f "$ENV_FILE" ] || { finish failed AGENT_ENV_MISSING; return; }
  [ -f "$COMPOSE_FILE" ] || { finish failed COMPOSE_FILE_MISSING; return; }
  [ -r "$TOKEN_FILE" ] || { finish failed AGENT_TOKEN_UNREADABLE; return; }
  # Without a known-good pin there is nothing verified to roll back to.
  PREVIOUS="$(env_value BRIDGE_AGENT_IMAGE "$PIN_FILE")"
  if ! matches "${PREVIOUS#*@}" "$DIGEST_RE" || ! matches "${PREVIOUS%@*}" "$REPO_RE" || [ "${PREVIOUS%@*}" = "$PREVIOUS" ]; then
    PREVIOUS=""
    finish failed NO_KNOWN_GOOD_PIN
    return
  fi
  if ! cp -f "$PIN_FILE" "$PIN_BACKUP" || ! chmod 0600 "$PIN_BACKUP"; then
    finish failed UPDATER_STATE_UNWRITABLE
    return
  fi

  current="$(env_value BRIDGE_AGENT_IMAGE "$ENV_FILE")"
  if [ "$current" = "$CANDIDATE" ]; then
    # Nothing to replace. Success still means the checks pass for this image.
    write_journal no_op || true
    write_result health_check
    if health_gate "$CANDIDATE"; then
      commit_no_op
    else
      finish failed "CURRENT_AGENT_UNHEALTHY"
    fi
    return
  fi

  write_journal staging || { finish failed UPDATER_STATE_UNWRITABLE; return; }
  write_result staging || { finish failed UPDATER_STATE_UNWRITABLE; return; }
  # Pulled by digest; the previous image stays (nothing here removes an image).
  if ! docker pull --platform linux/amd64 "$CANDIDATE"; then
    finish failed PULL_FAILED
    return
  fi
  os_arch="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$CANDIDATE" 2>/dev/null)"
  if [ "$os_arch" != "linux/amd64" ]; then
    finish failed IMAGE_PLATFORM_MISMATCH
    return
  fi

  write_journal replacing || { finish failed UPDATER_STATE_UNWRITABLE; return; }
  write_result replacing
  if ! write_env_image "$CANDIDATE"; then
    rollback "AGENT_ENV_UNWRITABLE"
    return
  fi
  if ! agent_up; then
    rollback "CANDIDATE_START_FAILED"
    return
  fi

  write_journal health_check || true
  write_result health_check
  if ! health_gate "$CANDIDATE"; then
    rollback "$GATE_CODE"
    return
  fi
  commit
}

# A no-op that passed its checks: the pin follows the running image.
commit_no_op() {
  write_pin || { finish failed PIN_UNWRITABLE; return; }
  finish succeeded
}

# --- recovery -------------------------------------------------------------------

# A journal means a run ended before its operation did (crash, reboot, the
# unit's timeout). Nothing is ever applied a second time: before the agent was
# replaced the operation fails; after that the running agent is verified and
# either accepted or rolled back to the recorded previous image.
recover() {
  local phase state
  OP_ID="$(journal_value OPERATION_ID)"
  phase="$(journal_value PHASE)"
  OP_REPO="$(journal_value REPOSITORY)"
  OP_DIGEST="$(journal_value DIGEST)"
  OP_NOT_AFTER="$(journal_value NOT_AFTER)"
  PREVIOUS="$(journal_value PREVIOUS)"
  if ! matches "$OP_ID" "$UUID_RE" || ! matches "$OP_REPO" "$REPO_RE" || ! matches "$OP_DIGEST" "$DIGEST_RE"; then
    log "the journal is unreadable; removed it (nothing was applied from it)"
    rm -f "$JOURNAL" "$PIN_BACKUP"
    return
  fi
  matches "$OP_NOT_AFTER" "$TIME_RE" || OP_NOT_AFTER=""
  CANDIDATE="${OP_REPO}@${OP_DIGEST}"
  state="$(result_state "$OP_ID")"
  if is_terminal "$state"; then
    log "operation ${OP_ID}: already ${state}; cleaning up after an interrupted run"
    finish_cleanup
    return
  fi
  log "operation ${OP_ID}: recovering an interrupted run (phase ${phase})"
  case "$phase" in
    claimed|picked_up|staging|no_op)
      finish failed UPDATE_INTERRUPTED ;;
    replacing|health_check|committing)
      if ! matches "${PREVIOUS#*@}" "$DIGEST_RE"; then
        finish rollback_failed ROLLBACK_TARGET_UNKNOWN
        return
      fi
      write_result health_check
      if health_gate "$CANDIDATE"; then
        commit
      else
        rollback UPDATE_INTERRUPTED
      fi ;;
    rolling_back)
      if ! matches "${PREVIOUS#*@}" "$DIGEST_RE"; then
        finish rollback_failed ROLLBACK_TARGET_UNKNOWN
        return
      fi
      rollback UPDATE_INTERRUPTED ;;
    *)
      finish failed UPDATE_INTERRUPTED ;;
  esac
}

finish_cleanup() {
  rm -f "$JOURNAL" "$PIN_BACKUP"
  rm -f -- "${REQUESTS_DIR}/${OP_ID}.json"
}

# --- one request ------------------------------------------------------------------

# A refused file under an operation id the host never saw gets a terminal
# result, so the agent does not keep reporting it as queued.
refuse_unread() {
  matches "$1" "$UUID_RE" || return 0
  [ ! -e "${RESULTS_DIR}/$1.json" ] || return 0
  OP_ID="$1"
  write_result failed REQUEST_NOT_REGULAR_FILE
}

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

# Every path out of here removes the request file unless the operation is still
# running (it is then removed by finish()). An unprocessable file left behind
# would re-fire the level-triggered path unit forever.
process_request() {
  local path="$1" name id body expected opened state
  name="${path##*/}"
  id="${name%.json}"
  OP_ID="" OP_REPO="" OP_DIGEST="" OP_NOT_AFTER="" CANDIDATE="" PREVIOUS=""

  # Open once, then ask the kernel what was opened: a symlink (or a swapped
  # directory) resolves elsewhere and is refused before a byte is read. The
  # pre-check keeps a planted FIFO or directory from even being opened.
  if [ -L "$path" ] || [ ! -f "$path" ] || ! exec 8<"$path"; then
    log "refusing ${name}: not a regular spool file"
    rm -rf -- "$path"
    refuse_unread "$id"
    return
  fi
  expected="$(readlink -f -- "$REQUESTS_DIR")/${name}"
  opened="$(readlink -- "/proc/$$/fd/8")"
  if [ "$opened" != "$expected" ] || [ ! -f "/proc/$$/fd/8" ]; then
    exec 8<&-
    log "refusing ${name}: not a regular spool file"
    rm -rf -- "$path"
    refuse_unread "$id"
    return
  fi
  body="$(head -c 4096 <&8)"
  exec 8<&-

  if ! matches "$id" "$UUID_RE"; then
    log "refusing ${name}: not an operation id"
    rm -f -- "$path"
    return
  fi
  OP_ID="$id"

  # Any result at all: the operation was seen before and is never applied again.
  if [ -e "${RESULTS_DIR}/${OP_ID}.json" ]; then
    state="$(result_state "$OP_ID")"
    if is_terminal "$state"; then
      log "operation ${OP_ID}: already ${state}; request removed"
    else
      # Claimed by a run that left no journal (its state was lost): it is
      # neither started again nor left open.
      finish failed UPDATE_INTERRUPTED
      return
    fi
    rm -f -- "$path"
    return
  fi

  # Re-validate independently of the agent: the spool is a file on disk and
  # the two sides have different threat models.
  local body_id repo digest not_after
  body_id="$(json_field "$body" operationId)"
  repo="$(json_field "$body" imageRepository)"
  digest="$(json_field "$body" imageDigest)"
  not_after="$(json_field "$body" notAfter)"
  matches "$repo" "$REPO_RE" && OP_REPO="$repo"
  matches "$digest" "$DIGEST_RE" && OP_DIGEST="$digest"
  matches "$not_after" "$TIME_RE" && OP_NOT_AFTER="$not_after"
  if [ "$body_id" != "$OP_ID" ]; then
    OP_REPO="" OP_DIGEST="" OP_NOT_AFTER=""
    finish failed OPERATION_MISMATCH
    return
  fi
  if [ -z "$UPDATE_REPO" ]; then
    finish failed UPDATER_NOT_CONFIGURED
    return
  fi
  if [ -z "$OP_REPO" ] || [ "$OP_REPO" != "$UPDATE_REPO" ]; then
    finish failed REPOSITORY_NOT_APPROVED
    return
  fi
  if [ -z "$OP_DIGEST" ]; then
    finish failed DIGEST_INVALID
    return
  fi
  local deadline
  deadline=""
  [ -z "$OP_NOT_AFTER" ] || deadline="$(date -u -d "$OP_NOT_AFTER" +%s%3N 2>/dev/null)"
  if [ -z "$deadline" ]; then
    OP_NOT_AFTER=""
    finish failed NOT_AFTER_INVALID
    return
  fi
  CANDIDATE="${OP_REPO}@${OP_DIGEST}"

  # First clock read: an intent already past its deadline is never claimed.
  # Both reads fail closed: a clock that cannot be read counts as "too late".
  if ! [ "$(now_ms)" -lt "$deadline" ] 2>/dev/null; then
    finish expired
    return
  fi
  # Claim, then read the clock again. Until the claim exists the agent may
  # answer "expired" for this request; after it, the agent reports this file.
  # Without a written claim nothing starts: the request stays, and the agent
  # keeps judging it by the clock.
  write_journal claimed || { finish failed UPDATER_STATE_UNWRITABLE; return; }
  if ! write_result queued; then
    log "operation ${OP_ID}: the claim could not be written; not started"
    rm -f "$JOURNAL"
    exit 1
  fi
  if ! [ "$(now_ms)" -lt "$deadline" ] 2>/dev/null; then
    finish expired
    return
  fi
  apply
}

# --- main -------------------------------------------------------------------------

# Never run two updates at once. flock(2) on a read-only descriptor of a
# root-only directory outside the spool: nothing is created or written through,
# so there is nothing for the agent to pre-plant (see agent-update.sh).
mkdir -p "$LOCK_DIR"
chmod 0700 "$LOCK_DIR"
exec 9<"$LOCK_DIR"
if ! flock -n 9; then
  # The request stays in place and the path unit retries it after the
  # running update finishes.
  echo "bridge-agent-update: another run holds the lock; skipping"
  exit 0
fi

mkdir -p "$STATE_DIR" "$RESULTS_DIR"
chmod 0700 "$STATE_DIR"

if [ -e "$JOURNAL" ]; then
  recover
fi

shopt -s nullglob
for request in "$REQUESTS_DIR"/*.json; do
  process_request "$request"
done
exit 0
