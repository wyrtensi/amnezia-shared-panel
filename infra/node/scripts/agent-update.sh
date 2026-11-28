#!/usr/bin/env bash
# Host-side worker for the panel's "update this node's agent" button.
#
# This is a port of infra/prod/panel-updater.sh, which does the same job for the
# panel itself. Read that script and docs/UPDATE-MECHANISM.md first: the lock
# placement, the /proc verification and the out-of-spool mktemp+rename of the
# result file are security properties, not style, and they are kept here
# deliberately.
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
# Stage result and log files OUTSIDE the container-writable spool in a
# root-owned directory on the same filesystem so mv is an atomic rename(2).
RESULT_STAGING_DIR="${NODE_UPDATER_STAGING_DIR:-$(dirname -- "$SPOOL_DIR")}"
NODE_DEPLOY_LOCK="${NODE_DIR}/.deploy.lock"
DEPLOY_LOCK_WAIT_SEC="${NODE_DEPLOY_LOCK_WAIT_SEC:-30}"
DEPLOY_LOCK_HELD=0
UPDATE_REPO="${NODE_AGENT_UPDATE_REPO:-}"
REQUEST="${SPOOL_DIR}/request.json"
RESULT="${SPOOL_DIR}/result.json"
LOG_PUBLIC="${SPOOL_DIR}/update.log"
ENV_FILE="${NODE_DIR}/.env"
COMPOSE_FILE="${NODE_DIR}/compose.yaml"
AGENT_CONTAINER="${NODE_AGENT_CONTAINER:-amnezia-node-agent}"
AWG3_CONTAINER="${NODE_AWG3_CONTAINER:-amnezia-awg3}"
AGENT_SERVICE=node-agent
# Where the published image carries the deployment files it expects. An image
# built before this feature ships none, which is a supported case.
IMAGE_DEPLOY_DIR="${NODE_AGENT_IMAGE_DEPLOY_DIR:-/opt/node-agent/deploy}"
HEALTH_ATTEMPTS="${NODE_AGENT_HEALTH_ATTEMPTS:-45}"
SYSTEMD_RUNTIME_DIR="${AMNEZIA_SYSTEMD_DIR:-/run/systemd/system}"

# Overwritten once the request body is parsed. write_result() is defined this
# early because the refusal branch below reports through it before the body has
# been read.
ID="unknown"
IMAGE=""
NEW_EXTRACT_CNAME=""
OLD_EXTRACT_CNAME=""

LOG="$(mktemp)"
SCRATCH="$(mktemp -d)"
cleanup() {
  if [ "$DEPLOY_LOCK_HELD" -eq 1 ]; then
    rmdir "$NODE_DEPLOY_LOCK" 2>/dev/null || true
    DEPLOY_LOCK_HELD=0
  fi
  if [ -n "$NEW_EXTRACT_CNAME" ]; then
    docker rm "$NEW_EXTRACT_CNAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$OLD_EXTRACT_CNAME" ]; then
    docker rm "$OLD_EXTRACT_CNAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
  rm -f "$LOG"
}
trap cleanup EXIT

log() { printf '%s\n' "$*" >>"$LOG"; }

# The agent serves the result and the log back to the panel, so both have to be
# readable by the container uid. Stage them outside the container-writable spool
# in a root-owned directory on the same filesystem so mv is an atomic rename(2).
publish() {
  local src="$1" dest="$2" tmp
  [ "$(stat -c %d "$RESULT_STAGING_DIR")" = "$(stat -c %d "$SPOOL_DIR")" ] || return 1
  tmp="$(mktemp "${RESULT_STAGING_DIR}/publish.XXXXXX")" || return 1
  cat "$src" >"$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0644 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$dest" || { rm -f "$tmp"; return 1; }
}

write_result() {
  local ok="$1" msg="$2" ts tmp
  ts="$(date -u -Iseconds)"
  # Minimal JSON escaping for the message (backslash, quote, newline).
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  msg="${msg//$'\n'/ }"
  # Write to a FRESH random file outside the container-writable spool, then
  # rename atomically onto $RESULT so a planted symlink is replaced rather than followed.
  if [ "$(stat -c %d "$RESULT_STAGING_DIR")" != "$(stat -c %d "$SPOOL_DIR")" ]; then
    echo "agent-update: $RESULT_STAGING_DIR and $SPOOL_DIR are on different filesystems; result not written" >&2
    return 1
  fi
  tmp="$(mktemp "${RESULT_STAGING_DIR}/result.XXXXXX")" || return 1
  printf '{"id":"%s","finishedAt":"%s","ok":%s,"image":"%s","message":"%s"}\n' \
    "$ID" "$ts" "$ok" "$IMAGE" "$msg" >"$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0644 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$RESULT" || { rm -f "$tmp"; return 1; }
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

# Serialize with host node operations (deploy.sh, switch-egress-mode.sh,
# set-capacity.sh, rollback.sh) that mutate .env / compose.yaml via .deploy.lock.
deploy_lock_waited=0
while ! mkdir "$NODE_DEPLOY_LOCK" 2>/dev/null; do
  if [ "$deploy_lock_waited" -ge "$DEPLOY_LOCK_WAIT_SEC" ]; then
    fail_out "another node operation is active: ${NODE_DEPLOY_LOCK}"
  fi
  sleep 1
  deploy_lock_waited=$((deploy_lock_waited + 1))
done
DEPLOY_LOCK_HELD=1

env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1
}

if [ -z "${EGRESS_STATE_FILE:-}" ]; then
  EGRESS_STATE_FILE="$(env_value EGRESS_STATE_FILE)"
fi
EGRESS_STATE_FILE="${EGRESS_STATE_FILE:-/etc/amnezia-egress/state.json}"
if [ -z "${NODE_EGRESS_RUN_DIR:-}" ]; then
  NODE_EGRESS_RUN_DIR="$(env_value NODE_EGRESS_RUN_DIR)"
fi
NODE_EGRESS_RUN_DIR="${NODE_EGRESS_RUN_DIR:-/run/amnezia-egress}"
if [ -z "${NODE_EGRESS_SOCKET:-}" ]; then
  NODE_EGRESS_SOCKET="$(env_value NODE_EGRESS_SOCKET)"
fi
NODE_EGRESS_SOCKET="${NODE_EGRESS_SOCKET:-${NODE_EGRESS_RUN_DIR}/egressd.sock}"

CURRENT_IMAGE="$(env_value NODE_AGENT_IMAGE)"
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
# has just been pulled - so the node's compose.yaml and scripts can be compared
# against what each image ships using one reused temp container per image.
init_extract_containers() {
  local cand_new="amnezia-agent-update-new-$$-${RANDOM}"
  if docker create --name "$cand_new" "$IMAGE" >/dev/null 2>&1; then
    NEW_EXTRACT_CNAME="$cand_new"
  fi
  if [ -n "$CURRENT_IMAGE" ]; then
    local cand_old="amnezia-agent-update-old-$$-${RANDOM}"
    if docker create --name "$cand_old" "$CURRENT_IMAGE" >/dev/null 2>&1; then
      OLD_EXTRACT_CNAME="$cand_old"
    fi
  fi
}

extract_abs_from_new() {
  local abs_path="$1" dest="$2"
  [ -n "$NEW_EXTRACT_CNAME" ] || return 1
  docker cp "${NEW_EXTRACT_CNAME}:${abs_path}" "$dest" >/dev/null 2>&1
}

extract_abs_from_old() {
  local abs_path="$1" dest="$2"
  [ -n "$OLD_EXTRACT_CNAME" ] || return 1
  docker cp "${OLD_EXTRACT_CNAME}:${abs_path}" "$dest" >/dev/null 2>&1
}

extract_from_new() {
  extract_abs_from_new "${IMAGE_DEPLOY_DIR}/$1" "$2"
}

extract_from_old() {
  extract_abs_from_old "${IMAGE_DEPLOY_DIR}/$1" "$2"
}

init_extract_containers

NEW_COMPOSE="${SCRATCH}/new-compose.yaml"
OLD_COMPOSE="${SCRATCH}/old-compose.yaml"
new_ships=0
old_ships=0
extract_from_new compose.yaml "$NEW_COMPOSE" && new_ships=1
[ -z "$CURRENT_IMAGE" ] || { extract_from_old compose.yaml "$OLD_COMPOSE" && old_ships=1; }

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

# Reconcile helper scripts that the image ships under deploy/scripts/.
# Uses the same provenance rule as compose.yaml (never overwrite local edits),
# plus a read-only allowlist of historical stock SHA-256 digests so the very
# first update from an older image (that did not ship scripts/) can still move
# untouched stock files forward cleanly.
sha256_file() {
  sha256sum "$1" 2>/dev/null | awk '{print $1}'
}

is_known_stock_script() {
  local rel="$1" hash="$2"
  case "${rel}:${hash}" in
    # Historical stock infra/node/scripts/awg3-entrypoint.sh versions prior to shipped scripts
    scripts/awg3-entrypoint.sh:704cfbf85bb8a5f04acfcff9a0c11aa6f83e3855fb52e213a51b0f2b78a711b5|\
    scripts/awg3-entrypoint.sh:83a5b62b4267ea188f382d2ebf1ddac89f58452b9281221d287552c37b4046d0|\
    scripts/awg3-entrypoint.sh:59afca8a08d991dc7ab85d0e6cfc22f546a3957a6541946532a4f9f67c1bbd87|\
    scripts/awg3-entrypoint.sh:138202ead59cc331982bb784770cc848cb4598f56702d94342f456ca51a4784d|\
    scripts/awg3-entrypoint.sh:371743667b21f75fa82ebd7f266f17f905445d8be1cdc02e2a590969e0eab014)
      return 0 ;;
    # Historical stock infra/node/scripts/agent-update.sh prior to shipped scripts
    scripts/agent-update.sh:edad515a20ad2b470965181003857b7a7c4aa8aa8a1a864c3732263e79afadb7)
      return 0 ;;
  esac
  return 1
}

is_bash_script() {
  case "$1" in
    scripts/agent-update.sh|scripts/capacity-apply.sh|scripts/install-agent-updater.sh|scripts/install-capacity-applier.sh|scripts/install-wytunnel-node.sh)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

validate_script_syntax() {
  local rel="$1" candidate="$2"
  if is_bash_script "$rel"; then
    /bin/bash -n "$candidate" >>"$LOG" 2>&1
  else
    /bin/sh -n "$candidate" >>"$LOG" 2>&1
  fi
}

MANAGED_SCRIPTS=(
  scripts/awg3-entrypoint.sh
  scripts/awg3-geometry.sh
  scripts/agent-update.sh
  scripts/capacity-apply.sh
  scripts/cotenants.sh
  scripts/install-agent-updater.sh
  scripts/install-capacity-applier.sh
  scripts/install-egressd.sh
  scripts/install-host-services.sh
  scripts/install-wytunnel-node.sh
  scripts/set-capacity.sh
  scripts/switch-egress-mode.sh
  scripts/common.sh
  scripts/backup.sh
  scripts/rollback.sh
  scripts/preflight.sh
  scripts/deploy.sh
)
APPLY_SCRIPTS=()
for rel in "${MANAGED_SCRIPTS[@]}"; do
  dest="${NODE_DIR}/${rel}"
  safe_key="${rel//\//_}"
  new_file="${SCRATCH}/new-${safe_key}"
  old_file="${SCRATCH}/old-${safe_key}"
  new_s=0
  old_s=0
  extract_from_new "$rel" "$new_file" && new_s=1
  [ -z "$CURRENT_IMAGE" ] || { extract_from_old "$rel" "$old_file" && old_s=1; }

  # Missing stock helper scripts (for example newly introduced egress/capacity
  # scripts on legacy nodes) do not overwrite anything, so install them once
  # syntax-checked regardless of whether compose.yaml changed in this release.
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    if [ "$new_s" -eq 1 ]; then
      if validate_script_syntax "$rel" "$new_file"; then
        APPLY_SCRIPTS+=("$rel")
        log "adding new stock helper ${rel} shipped by the new image"
      else
        log "WARNING: shipped ${rel} failed syntax check; skipping add"
      fi
    fi
    continue
  fi

  if [ -L "$dest" ] || [ ! -f "$dest" ]; then
    log "WARNING: ${rel} is not a regular file; leaving it untouched"
    continue
  fi

  if [ "$new_s" -eq 1 ] && ! cmp -s "$new_file" "$dest"; then
    # Refuse a syntactically broken shell script before touching the host copy.
    if ! validate_script_syntax "$rel" "$new_file"; then
      log "WARNING: shipped ${rel} failed syntax check; leaving local copy untouched"
      continue
    fi
    if { [ "$old_s" -eq 1 ] && cmp -s "$old_file" "$dest"; } || { [ "$old_s" -eq 0 ] && is_known_stock_script "$rel" "$(sha256_file "$dest")"; }; then
      APPLY_SCRIPTS+=("$rel")
      log "the node's ${rel} is unmodified; applying the one shipped by the new image"
    else
      log "WARNING: ${rel} has local differences from the stock version; leaving it untouched:"
      diff -u "$dest" "$new_file" >>"$LOG" 2>&1 || true
    fi
  fi
done

EGRESSD_DEST_BIN="${AMNEZIA_EGRESSD_DEST:-/usr/local/bin/amnezia-egressd}"
EGRESSD_DEST_UNIT="${AMNEZIA_EGRESSD_UNIT_DEST:-/etc/systemd/system/amnezia-egressd.service}"
EGRESSD_NODE_UNIT="${NODE_DIR}/systemd/amnezia-egressd.service"
EGRESSD_BACKUP="${SCRATCH}/backup-egressd"
EGRESSD_UNIT_BACKUP="${SCRATCH}/backup-egressd.service"
EGRESSD_NODE_UNIT_BACKUP="${SCRATCH}/backup-node-egressd.service"
NEW_EGRESSD="${SCRATCH}/new-egressd"
NEW_EGRESSD_UNIT="${SCRATCH}/new-egressd.service"
NEW_EGRESSD_UNIT_RENDERED="${SCRATCH}/new-egressd-rendered.service"
OLD_EGRESSD_UNIT_RENDERED="${SCRATCH}/old-egressd-rendered.service"
HAS_NEW_EGRESSD=0
HAS_NEW_EGRESSD_UNIT=0
UPDATE_EGRESSD=0
UPDATE_EGRESSD_UNIT=0
INSTALL_NODE_EGRESSD_UNIT=0
UPDATE_NODE_EGRESSD_UNIT=0
BOOTSTRAP_EGRESSD=0

render_egressd_unit() {
  local src="$1" dest="$2"
  local state_file="${EGRESS_STATE_FILE:-/etc/amnezia-egress/state.json}"
  local sock_file="${NODE_EGRESS_SOCKET:-/run/amnezia-egress/egressd.sock}"
  sed \
    -e "s|/usr/local/bin/amnezia-egressd|${EGRESSD_DEST_BIN}|g" \
    -e "s|/opt/amnezia-node|${NODE_DIR}|g" \
    -e "s|/etc/amnezia-egress/state\\.json|${state_file}|g" \
    -e "s|/run/amnezia-egress/egressd\\.sock|${sock_file}|g" \
    "$src" >"$dest"
}

if extract_abs_from_new "/opt/node-agent/bin/amnezia-egressd" "$NEW_EGRESSD"; then
  HAS_NEW_EGRESSD=1
fi
if extract_from_new "systemd/amnezia-egressd.service" "$NEW_EGRESSD_UNIT"; then
  HAS_NEW_EGRESSD_UNIT=1
fi

if [ "$HAS_NEW_EGRESSD" -eq 1 ]; then
  if [ -x "$EGRESSD_DEST_BIN" ]; then
    if ! cmp -s "$NEW_EGRESSD" "$EGRESSD_DEST_BIN"; then
      UPDATE_EGRESSD=1
      log "new image ships an updated amnezia-egressd host binary"
    fi
  elif [ "$HAS_NEW_EGRESSD_UNIT" -eq 1 ] && [ "$(id -u)" -eq 0 ] && [ -d "$SYSTEMD_RUNTIME_DIR" ] && command -v systemctl >/dev/null 2>&1; then
    BOOTSTRAP_EGRESSD=1
    log "amnezia-egressd not installed on host yet; will bootstrap from the new image"
  fi
fi

if [ "$HAS_NEW_EGRESSD_UNIT" -eq 1 ]; then
  render_egressd_unit "$NEW_EGRESSD_UNIT" "$NEW_EGRESSD_UNIT_RENDERED"
  if [ ! -e "$EGRESSD_NODE_UNIT" ] && [ ! -L "$EGRESSD_NODE_UNIT" ]; then
    INSTALL_NODE_EGRESSD_UNIT=1
    log "adding systemd/amnezia-egressd.service template shipped by the new image"
  elif [ -f "$EGRESSD_NODE_UNIT" ] && ! cmp -s "$NEW_EGRESSD_UNIT" "$EGRESSD_NODE_UNIT"; then
    UPDATE_NODE_EGRESSD_UNIT=1
  fi

  if [ -f "$EGRESSD_DEST_UNIT" ] && ! cmp -s "$NEW_EGRESSD_UNIT_RENDERED" "$EGRESSD_DEST_UNIT"; then
    unit_unmodified=0
    if [ -f "$EGRESSD_NODE_UNIT" ]; then
      render_egressd_unit "$EGRESSD_NODE_UNIT" "$OLD_EGRESSD_UNIT_RENDERED"
      if cmp -s "$OLD_EGRESSD_UNIT_RENDERED" "$EGRESSD_DEST_UNIT"; then
        unit_unmodified=1
      fi
    elif [ -n "$OLD_EXTRACT_CNAME" ]; then
      OLD_IMAGE_EGRESSD_UNIT="${SCRATCH}/old-image-egressd.service"
      if extract_from_old "systemd/amnezia-egressd.service" "$OLD_IMAGE_EGRESSD_UNIT"; then
        render_egressd_unit "$OLD_IMAGE_EGRESSD_UNIT" "$OLD_EGRESSD_UNIT_RENDERED"
        if cmp -s "$OLD_EGRESSD_UNIT_RENDERED" "$EGRESSD_DEST_UNIT"; then
          unit_unmodified=1
        fi
      fi
    fi
    if [ "$unit_unmodified" -eq 1 ]; then
      UPDATE_EGRESSD_UNIT=1
      log "new image ships an updated amnezia-egressd systemd unit"
    else
      log "WARNING: local modifications detected in $EGRESSD_DEST_UNIT; skipping systemd unit overwrite"
    fi
  fi
fi

# Apply IPv6 forwarding sysctls live inside the running AWG 3.1 container's
# network namespace whenever compose.yaml enables them. Containers created
# before the IPv6 active-reject stub release still have net.ipv6.conf.all.forwarding=0
# and read-only /proc/sys inside the container; setting them via nsenter from
# the host enables the stub with zero tunnel downtime and no AWG restart.
ensure_awg3_ipv6_forwarding() {
  grep -Eq 'net\.ipv6\.conf\.all\.forwarding[[:space:]]*:[[:space:]]*"?1"?' "$EFFECTIVE_COMPOSE" || return 0
  if ! command -v nsenter >/dev/null 2>&1 || ! command -v sysctl >/dev/null 2>&1; then
    log "WARNING: nsenter or sysctl not found on host; skipping live IPv6 forwarding sysctl check for ${AWG3_CONTAINER}"
    return 0
  fi
  local pid current
  pid="$(docker inspect --format '{{if .State.Running}}{{.State.Pid}}{{end}}' "$AWG3_CONTAINER" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*|0|1) return 0 ;;
  esac
  [ -e "/proc/${pid}/ns/net" ] || return 0
  current="$(nsenter --net="/proc/${pid}/ns/net" -- sysctl -n net.ipv6.conf.all.forwarding 2>/dev/null || true)"
  if [ "$current" = "1" ]; then
    return 0
  fi
  if nsenter --net="/proc/${pid}/ns/net" -- sysctl -w \
      net.ipv6.conf.all.disable_ipv6=0 \
      net.ipv6.conf.default.disable_ipv6=0 \
      net.ipv6.conf.all.forwarding=1 >>"$LOG" 2>&1; then
    log "applied live IPv6 forwarding sysctls in ${AWG3_CONTAINER} netns (no AWG restart)"
  else
    log "WARNING: could not apply live IPv6 forwarding sysctls in ${AWG3_CONTAINER} netns; recreate ${AWG3_CONTAINER} manually to enable IPv6 reject stub"
  fi
}

egressd_healthy() {
  local attempt=0 sock="$NODE_EGRESS_SOCKET"
  while [ "$attempt" -lt 5 ]; do
    if command -v systemctl >/dev/null 2>&1 &&
       systemctl is-active --quiet amnezia-egressd.service >/dev/null 2>&1 &&
       [ -S "$sock" ]; then
      if command -v curl >/dev/null 2>&1; then
        if curl -fsS --max-time 2 --unix-socket "$sock" http://localhost/v1/health 2>/dev/null | grep -q '"ok":true'; then
          return 0
        fi
      else
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

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
for rel in ${APPLY_SCRIPTS[@]+"${APPLY_SCRIPTS[@]}"}; do
  [ -f "${NODE_DIR}/${rel}" ] || continue
  safe_key="${rel//\//_}"
  cp -p "${NODE_DIR}/${rel}" "${SCRATCH}/backup-${safe_key}"
done

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
  chmod 600 "$env_tmp" || { rm -f "$env_tmp"; return 1; }
  mv -f "$env_tmp" "$ENV_FILE" || { rm -f "$env_tmp"; return 1; }
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

kv_value() {
  local key="$1" file="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -n 1 | tr -d '\r'
}

SHIM_SYSTEM_BIN="${AMNEZIA_SHIM_SYSTEM_BIN:-/usr/bin/containerd-shim-runc-v2}"
SHIM_DIVERT_TARGET="${AMNEZIA_SHIM_DIVERT_TARGET:-${SHIM_SYSTEM_BIN}.upstream}"
SHIM_OVERRIDE_DIR="${AMNEZIA_SHIM_OVERRIDE_DIR:-/usr/local/lib/amnezia}"
SHIM_OVERRIDE_BIN="${SHIM_OVERRIDE_DIR}/containerd-shim-runc-v2"
SHIM_META_FILE="${SHIM_OVERRIDE_DIR}/shim-override.meta"
SHIM_DIVERT_PACKAGE="amnezia-node-shim"
CONTAINERD_BIN="${AMNEZIA_CONTAINERD_BIN:-containerd}"
SHIM_ALLOW_NONROOT="${AMNEZIA_SHIM_ALLOW_NONROOT:-0}"
NEW_SHIM_ENV="${SCRATCH}/new-shim-override.env"
NEW_SHIM_BIN="${SCRATCH}/new-shim-bin"
SHIM_BIN_BACKUP="${SCRATCH}/backup-shim-bin"
SHIM_META_BACKUP="${SCRATCH}/backup-shim-meta"
SHIM_ROLLBACK_ACTION=""

detect_containerd_minor() {
  "$CONTAINERD_BIN" --version 2>/dev/null \
    | grep -oE '(^|[[:space:]])v?[0-9]+\.[0-9]+\.[0-9]+' \
    | head -n1 \
    | tr -d '[:space:]v' \
    | cut -d. -f1,2
}

shim_divert_owner() {
  dpkg-divert --listpackage "$SHIM_SYSTEM_BIN" 2>/dev/null || true
}

write_shim_meta() {
  local mode="$1" minor="$2" ref="$3" sha="$4" tmp
  tmp="$(mktemp "${SHIM_META_FILE}.XXXXXX")" || return 1
  {
    printf 'SHIM_MODE=%s\n' "$mode"
    printf 'CONTAINERD_MINOR=%s\n' "$minor"
    printf 'SHIM_REF=%s\n' "$ref"
    printf 'SHIM_SHA256=%s\n' "$sha"
    printf 'INSTALLED_AT=%s\n' "$(date -u -Iseconds)"
  } >"$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0644 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$SHIM_META_FILE" || { rm -f "$tmp"; return 1; }
}

reconcile_containerd_shim() {
  local shim_mode owner target_link minor minor_key expected_sha shim_ref actual_sha shim_tmp
  shim_mode="upstream"
  if extract_abs_from_new "/opt/node-agent/bin/shim-override.env" "$NEW_SHIM_ENV"; then
    shim_mode="$(kv_value SHIM_MODE "$NEW_SHIM_ENV")"
    [ -n "$shim_mode" ] || shim_mode="upstream"
  fi

  case "$shim_mode" in
    upstream|override) ;;
    *)
      log "WARNING: unsupported SHIM_MODE=${shim_mode} in shim-override.env; skipping shim reconciliation"
      return 0
      ;;
  esac

  if [ "$(id -u)" -ne 0 ] && [ "$SHIM_ALLOW_NONROOT" != "1" ]; then
    [ "$shim_mode" = "upstream" ] || log "WARNING: non-root run; skipping containerd-shim override"
    return 0
  fi

  if ! command -v dpkg-divert >/dev/null 2>&1; then
    [ "$shim_mode" = "upstream" ] || log "WARNING: dpkg-divert not available on host; skipping containerd-shim override"
    return 0
  fi

  if [ ! -e "$SHIM_SYSTEM_BIN" ] && [ ! -L "$SHIM_SYSTEM_BIN" ]; then
    [ "$shim_mode" = "upstream" ] || log "WARNING: ${SHIM_SYSTEM_BIN} not found on host; skipping containerd-shim override"
    return 0
  fi

  owner="$(shim_divert_owner)"
  target_link=""
  [ ! -L "$SHIM_SYSTEM_BIN" ] || target_link="$(readlink "$SHIM_SYSTEM_BIN" 2>/dev/null || true)"

  if [ "$shim_mode" = "upstream" ]; then
    if [ "$owner" != "$SHIM_DIVERT_PACKAGE" ] && [ "$target_link" != "$SHIM_OVERRIDE_BIN" ]; then
      return 0
    fi
    [ ! -f "$SHIM_OVERRIDE_BIN" ] || cp -p "$SHIM_OVERRIDE_BIN" "$SHIM_BIN_BACKUP"
    [ ! -f "$SHIM_META_FILE" ] || cp -p "$SHIM_META_FILE" "$SHIM_META_BACKUP"
    [ ! -L "$SHIM_SYSTEM_BIN" ] || rm -f "$SHIM_SYSTEM_BIN"
    if [ "$owner" = "$SHIM_DIVERT_PACKAGE" ]; then
      if ! dpkg-divert --package "$SHIM_DIVERT_PACKAGE" --remove --rename "$SHIM_SYSTEM_BIN" >>"$LOG" 2>&1; then
        log "WARNING: failed to remove dpkg-divert on ${SHIM_SYSTEM_BIN}; restoring previous override"
        if [ -f "$SHIM_BIN_BACKUP" ]; then
          ln -sfn "$SHIM_OVERRIDE_BIN" "$SHIM_SYSTEM_BIN" 2>/dev/null || true
        fi
        return 0
      fi
    fi
    rm -f "$SHIM_OVERRIDE_BIN" "$SHIM_META_FILE"
    rmdir "$SHIM_OVERRIDE_DIR" 2>/dev/null || true
    if ! "$SHIM_SYSTEM_BIN" -v >>"$LOG" 2>&1; then
      log "WARNING: restored stock ${SHIM_SYSTEM_BIN} failed -v smoke check"
    fi
    SHIM_ROLLBACK_ACTION="restore_removed_override"
    log "removed temporary containerd-shim-runc-v2 override; restored stock upstream binary"
    return 0
  fi

  # SHIM_MODE=override
  minor="$(detect_containerd_minor)"
  if [ -z "$minor" ]; then
    log "WARNING: could not detect host containerd version; skipping temporary shim override"
    return 0
  fi

  minor_key="${minor//./_}"
  expected_sha="$(kv_value "SHIM_SHA256_${minor_key}" "$NEW_SHIM_ENV")"
  shim_ref="$(kv_value SHIM_REF "$NEW_SHIM_ENV")"
  if ! printf '%s' "$expected_sha" | grep -Eq '^[0-9a-f]{64}$'; then
    log "WARNING: no shim override checksum configured for containerd ${minor}; leaving stock shim intact"
    return 0
  fi

  if ! extract_abs_from_new "/opt/node-agent/bin/shims/containerd-shim-runc-v2-${minor}" "$NEW_SHIM_BIN"; then
    log "WARNING: image does not ship containerd-shim-runc-v2-${minor}; leaving stock shim intact"
    return 0
  fi

  actual_sha="$(sha256_file "$NEW_SHIM_BIN")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    log "WARNING: SHA-256 mismatch for containerd-shim-runc-v2-${minor} (expected ${expected_sha}, got ${actual_sha:-none}); leaving stock shim intact"
    return 0
  fi

  chmod 0755 "$NEW_SHIM_BIN"
  if ! "$NEW_SHIM_BIN" -v 2>&1 | grep -q 'containerd-shim-runc-v2'; then
    log "WARNING: containerd-shim-runc-v2-${minor} failed -v smoke test; leaving stock shim intact"
    return 0
  fi

  if [ -n "$owner" ] && [ "$owner" != "$SHIM_DIVERT_PACKAGE" ]; then
    log "WARNING: ${SHIM_SYSTEM_BIN} already diverted by ${owner}; skipping temporary shim override"
    return 0
  fi

  if [ "$owner" = "$SHIM_DIVERT_PACKAGE" ] &&
     [ "$target_link" = "$SHIM_OVERRIDE_BIN" ] &&
     [ -f "$SHIM_OVERRIDE_BIN" ] &&
     cmp -s "$NEW_SHIM_BIN" "$SHIM_OVERRIDE_BIN"; then
    log "temporary containerd-shim-runc-v2 override already current (containerd ${minor}, ${shim_ref:-custom})"
    return 0
  fi

  install -d -m 0755 "$SHIM_OVERRIDE_DIR" || {
    log "WARNING: could not create ${SHIM_OVERRIDE_DIR}; skipping temporary shim override"
    return 0
  }

  if [ "$owner" = "$SHIM_DIVERT_PACKAGE" ] && [ -f "$SHIM_OVERRIDE_BIN" ]; then
    cp -p "$SHIM_OVERRIDE_BIN" "$SHIM_BIN_BACKUP"
    [ ! -f "$SHIM_META_FILE" ] || cp -p "$SHIM_META_FILE" "$SHIM_META_BACKUP"
  fi

  shim_tmp="$(mktemp "${SHIM_OVERRIDE_BIN}.XXXXXX")" || {
    log "WARNING: could not stage ${SHIM_OVERRIDE_BIN}; skipping temporary shim override"
    return 0
  }
  cat "$NEW_SHIM_BIN" >"$shim_tmp" && chmod 0755 "$shim_tmp" && mv -f "$shim_tmp" "$SHIM_OVERRIDE_BIN" || {
    rm -f "$shim_tmp"
    log "WARNING: could not install ${SHIM_OVERRIDE_BIN}; skipping temporary shim override"
    return 0
  }

  if [ "$owner" != "$SHIM_DIVERT_PACKAGE" ]; then
    if ! dpkg-divert --package "$SHIM_DIVERT_PACKAGE" --add --rename --divert "$SHIM_DIVERT_TARGET" "$SHIM_SYSTEM_BIN" >>"$LOG" 2>&1; then
      rm -f "$SHIM_OVERRIDE_BIN"
      log "WARNING: dpkg-divert failed for ${SHIM_SYSTEM_BIN}; leaving stock shim intact"
      return 0
    fi
    ln -sfn "$SHIM_OVERRIDE_BIN" "$SHIM_SYSTEM_BIN"
    SHIM_ROLLBACK_ACTION="remove_new_override"
  else
    ln -sfn "$SHIM_OVERRIDE_BIN" "$SHIM_SYSTEM_BIN"
    if [ -f "$SHIM_BIN_BACKUP" ]; then
      SHIM_ROLLBACK_ACTION="restore_old_override"
    else
      SHIM_ROLLBACK_ACTION="remove_new_override"
    fi
  fi

  write_shim_meta "override" "$minor" "$shim_ref" "$expected_sha" || true
  log "installed temporary containerd-shim-runc-v2 override (containerd ${minor}, ${shim_ref:-custom}); recreated containers use it immediately (running AWG containers keep their existing shim until restarted)"
}

rollback() {
  log "rolling back to ${CURRENT_IMAGE}"
  cp -f "$ENV_BACKUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cp -f "$COMPOSE_BACKUP" "$COMPOSE_FILE"
  for rel in ${APPLY_SCRIPTS[@]+"${APPLY_SCRIPTS[@]}"}; do
    safe_key="${rel//\//_}"
    if [ -f "${SCRATCH}/backup-${safe_key}" ]; then
      cp -pf "${SCRATCH}/backup-${safe_key}" "${NODE_DIR}/${rel}"
    else
      rm -f "${NODE_DIR}/${rel}"
    fi
  done
  if [ "$UPDATE_EGRESSD" -eq 1 ] && [ -f "$EGRESSD_BACKUP" ]; then
    cp -pf "$EGRESSD_BACKUP" "$EGRESSD_DEST_BIN"
    chmod 0755 "$EGRESSD_DEST_BIN"
  fi
  if [ "$INSTALL_NODE_EGRESSD_UNIT" -eq 1 ]; then
    rm -f "$EGRESSD_NODE_UNIT"
  elif [ "$UPDATE_NODE_EGRESSD_UNIT" -eq 1 ] && [ -f "$EGRESSD_NODE_UNIT_BACKUP" ]; then
    cp -pf "$EGRESSD_NODE_UNIT_BACKUP" "$EGRESSD_NODE_UNIT"
    chmod 0644 "$EGRESSD_NODE_UNIT"
  fi
  if [ "$UPDATE_EGRESSD_UNIT" -eq 1 ] && [ -f "$EGRESSD_UNIT_BACKUP" ]; then
    cp -pf "$EGRESSD_UNIT_BACKUP" "$EGRESSD_DEST_UNIT"
    chmod 0644 "$EGRESSD_DEST_UNIT"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >>"$LOG" 2>&1 || true
    fi
  fi
  if [ "$UPDATE_EGRESSD" -eq 1 ] || [ "$UPDATE_EGRESSD_UNIT" -eq 1 ]; then
    if command -v systemctl >/dev/null 2>&1 && { systemctl is-enabled amnezia-egressd.service >/dev/null 2>&1 || systemctl is-active --quiet amnezia-egressd.service >/dev/null 2>&1; }; then
      systemctl restart amnezia-egressd.service >>"$LOG" 2>&1 || true
    fi
  fi
  case "$SHIM_ROLLBACK_ACTION" in
    remove_new_override)
      [ ! -L "$SHIM_SYSTEM_BIN" ] || rm -f "$SHIM_SYSTEM_BIN"
      if [ "$(shim_divert_owner)" = "$SHIM_DIVERT_PACKAGE" ]; then
        dpkg-divert --package "$SHIM_DIVERT_PACKAGE" --remove --rename "$SHIM_SYSTEM_BIN" >>"$LOG" 2>&1 || true
      fi
      rm -f "$SHIM_OVERRIDE_BIN" "$SHIM_META_FILE"
      rmdir "$SHIM_OVERRIDE_DIR" 2>/dev/null || true
      ;;
    restore_old_override)
      if [ -f "$SHIM_BIN_BACKUP" ]; then
        cp -pf "$SHIM_BIN_BACKUP" "$SHIM_OVERRIDE_BIN"
        chmod 0755 "$SHIM_OVERRIDE_BIN"
        ln -sfn "$SHIM_OVERRIDE_BIN" "$SHIM_SYSTEM_BIN"
      fi
      if [ -f "$SHIM_META_BACKUP" ]; then
        cp -pf "$SHIM_META_BACKUP" "$SHIM_META_FILE"
        chmod 0644 "$SHIM_META_FILE"
      fi
      ;;
    restore_removed_override)
      if [ -f "$SHIM_BIN_BACKUP" ]; then
        install -d -m 0755 "$SHIM_OVERRIDE_DIR" || true
        cp -pf "$SHIM_BIN_BACKUP" "$SHIM_OVERRIDE_BIN"
        chmod 0755 "$SHIM_OVERRIDE_BIN"
        if [ "$(shim_divert_owner)" != "$SHIM_DIVERT_PACKAGE" ]; then
          dpkg-divert --package "$SHIM_DIVERT_PACKAGE" --add --rename --divert "$SHIM_DIVERT_TARGET" "$SHIM_SYSTEM_BIN" >>"$LOG" 2>&1 || true
        fi
        ln -sfn "$SHIM_OVERRIDE_BIN" "$SHIM_SYSTEM_BIN"
      fi
      if [ -f "$SHIM_META_BACKUP" ]; then
        cp -pf "$SHIM_META_BACKUP" "$SHIM_META_FILE"
        chmod 0644 "$SHIM_META_FILE"
      fi
      ;;
  esac
  agent_up || log "WARNING: the rollback could not recreate the agent"
}

if [ "$apply_compose" -eq 1 ]; then
  compose_tmp="$(mktemp "${NODE_DIR}/.compose.yaml.XXXXXX")" || fail_out "could not stage compose.yaml"
  cat "$NEW_COMPOSE" >"$compose_tmp" || { rm -f "$compose_tmp"; fail_out "could not write compose.yaml"; }
  chmod 0644 "$compose_tmp" || { rm -f "$compose_tmp"; fail_out "could not chmod compose.yaml"; }
  mv -f "$compose_tmp" "$COMPOSE_FILE" || { rm -f "$compose_tmp"; fail_out "could not replace compose.yaml"; }
fi

if [ "$INSTALL_NODE_EGRESSD_UNIT" -eq 1 ] || [ "$UPDATE_NODE_EGRESSD_UNIT" -eq 1 ]; then
  [ "$UPDATE_NODE_EGRESSD_UNIT" -eq 0 ] || cp -p "$EGRESSD_NODE_UNIT" "$EGRESSD_NODE_UNIT_BACKUP"
  mkdir -p "$(dirname -- "$EGRESSD_NODE_UNIT")"
  node_unit_tmp="$(mktemp "${EGRESSD_NODE_UNIT}.XXXXXX")" || { rollback; fail_out "could not stage systemd/amnezia-egressd.service"; }
  cat "$NEW_EGRESSD_UNIT" >"$node_unit_tmp" || { rm -f "$node_unit_tmp"; rollback; fail_out "could not write systemd/amnezia-egressd.service"; }
  chmod 0644 "$node_unit_tmp" || { rm -f "$node_unit_tmp"; rollback; fail_out "could not chmod systemd/amnezia-egressd.service"; }
  mv -f "$node_unit_tmp" "$EGRESSD_NODE_UNIT" || { rm -f "$node_unit_tmp"; rollback; fail_out "could not install systemd/amnezia-egressd.service"; }
fi

if [ "$BOOTSTRAP_EGRESSD" -eq 1 ]; then
  install -d -m 0700 "$(dirname -- "$EGRESS_STATE_FILE")"
  install -d -m 0755 "$NODE_EGRESS_RUN_DIR"
  install -d -m 0755 "$(dirname -- "$EGRESSD_DEST_BIN")" "$(dirname -- "$EGRESSD_DEST_UNIT")"
  boot_bin_tmp="$(mktemp "${EGRESSD_DEST_BIN}.XXXXXX" 2>/dev/null || true)"
  boot_unit_tmp="$(mktemp "${EGRESSD_DEST_UNIT}.XXXXXX" 2>/dev/null || true)"
  if [ -n "$boot_bin_tmp" ] && [ -n "$boot_unit_tmp" ] &&
     cat "$NEW_EGRESSD" >"$boot_bin_tmp" && chmod 0755 "$boot_bin_tmp" && mv -f "$boot_bin_tmp" "$EGRESSD_DEST_BIN" &&
     cat "$NEW_EGRESSD_UNIT_RENDERED" >"$boot_unit_tmp" && chmod 0644 "$boot_unit_tmp" && mv -f "$boot_unit_tmp" "$EGRESSD_DEST_UNIT" &&
     systemctl daemon-reload >>"$LOG" 2>&1 &&
     systemctl enable --now amnezia-egressd.service >>"$LOG" 2>&1 &&
     egressd_healthy; then
    log "bootstrapped amnezia-egressd host daemon and verified socket health"
  else
    rm -f "$boot_bin_tmp" "$boot_unit_tmp"
    systemctl disable --now amnezia-egressd.service >/dev/null 2>&1 || true
    rm -f "$EGRESSD_DEST_BIN" "$EGRESSD_DEST_UNIT"
    systemctl daemon-reload >>"$LOG" 2>&1 || true
    log "WARNING: could not bootstrap amnezia-egressd automatically; continuing node-agent update. Install manually on host: sh scripts/install-egressd.sh"
  fi
fi

if [ "$UPDATE_EGRESSD" -eq 1 ]; then
  cp -p "$EGRESSD_DEST_BIN" "$EGRESSD_BACKUP"
  egressd_tmp="$(mktemp "${EGRESSD_DEST_BIN}.XXXXXX")" || { rollback; fail_out "could not stage amnezia-egressd"; }
  cat "$NEW_EGRESSD" >"$egressd_tmp" || { rm -f "$egressd_tmp"; rollback; fail_out "could not write amnezia-egressd"; }
  chmod 0755 "$egressd_tmp" || { rm -f "$egressd_tmp"; rollback; fail_out "could not chmod amnezia-egressd"; }
  mv -f "$egressd_tmp" "$EGRESSD_DEST_BIN" || { rm -f "$egressd_tmp"; rollback; fail_out "could not replace amnezia-egressd"; }
fi
if [ "$UPDATE_EGRESSD_UNIT" -eq 1 ]; then
  cp -p "$EGRESSD_DEST_UNIT" "$EGRESSD_UNIT_BACKUP"
  unit_tmp="$(mktemp "${EGRESSD_DEST_UNIT}.XXXXXX")" || { rollback; fail_out "could not stage amnezia-egressd unit"; }
  cat "$NEW_EGRESSD_UNIT_RENDERED" >"$unit_tmp" || { rm -f "$unit_tmp"; rollback; fail_out "could not write amnezia-egressd unit"; }
  chmod 0644 "$unit_tmp" || { rm -f "$unit_tmp"; rollback; fail_out "could not chmod amnezia-egressd unit"; }
  mv -f "$unit_tmp" "$EGRESSD_DEST_UNIT" || { rm -f "$unit_tmp"; rollback; fail_out "could not replace amnezia-egressd unit"; }
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >>"$LOG" 2>&1 || true
  fi
fi
if [ "$UPDATE_EGRESSD" -eq 1 ] || [ "$UPDATE_EGRESSD_UNIT" -eq 1 ]; then
  if command -v systemctl >/dev/null 2>&1 && { systemctl is-enabled amnezia-egressd.service >/dev/null 2>&1 || systemctl is-active --quiet amnezia-egressd.service >/dev/null 2>&1; }; then
    if ! systemctl restart amnezia-egressd.service >>"$LOG" 2>&1 || ! egressd_healthy; then
      rollback
      fail_out "amnezia-egressd failed health gate after update; rolled back"
    fi
  fi
fi
for rel in ${APPLY_SCRIPTS[@]+"${APPLY_SCRIPTS[@]}"}; do
  safe_key="${rel//\//_}"
  dest="${NODE_DIR}/${rel}"
  mkdir -p "$(dirname -- "$dest")"
  script_tmp="$(mktemp "${dest}.XXXXXX")" || { rollback; fail_out "could not stage ${rel}"; }
  cat "${SCRATCH}/new-${safe_key}" >"$script_tmp" || { rm -f "$script_tmp"; rollback; fail_out "could not write ${rel}"; }
  chmod 0755 "$script_tmp" || { rm -f "$script_tmp"; rollback; fail_out "could not chmod ${rel}"; }
  mv -f "$script_tmp" "$dest" || { rm -f "$script_tmp"; rollback; fail_out "could not replace ${rel}"; }
done
# Enable IPv6 forwarding sysctls live before bringing up the new agent so its
# first /server report already reflects ipv6RejectStub.supported = true.
ensure_awg3_ipv6_forwarding
reconcile_containerd_shim
if ! write_env_image "$IMAGE"; then
  rollback
  fail_out "could not rewrite ${ENV_FILE}"
fi

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
