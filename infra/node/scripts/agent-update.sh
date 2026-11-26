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
AWG3_CONTAINER="${NODE_AWG3_CONTAINER:-amnezia-awg3}"
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

MANAGED_SCRIPTS=(
  scripts/awg3-entrypoint.sh
  scripts/agent-update.sh
  scripts/install-egressd.sh
  scripts/install-host-services.sh
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
  extract_from_image "$IMAGE" "$rel" "$new_file" && new_s=1
  [ -z "$CURRENT_IMAGE" ] || { extract_from_image "$CURRENT_IMAGE" "$rel" "$old_file" && old_s=1; }

  # New helper scripts introduced in newer agent releases may be absent on disk
  # while compose/existing scripts have clean provenance (`apply_compose=1` or `old_s=1`).
  if [ ! -f "$dest" ]; then
    if [ "$new_s" -eq 1 ] && [ "$apply_compose" -eq 1 ]; then
      APPLY_SCRIPTS+=("$rel")
      log "adding new stock helper ${rel} shipped by the new image"
    fi
    continue
  fi

  if [ "$new_s" -eq 1 ] && ! cmp -s "$new_file" "$dest"; then
    # Refuse a syntactically broken shell script before touching the host copy.
    if [ "$rel" = "scripts/agent-update.sh" ]; then
      if ! /bin/bash -n "$new_file" >>"$LOG" 2>&1; then
        log "WARNING: shipped ${rel} failed bash syntax check; leaving local copy untouched"
        continue
      fi
    elif ! /bin/sh -n "$new_file" >>"$LOG" 2>&1; then
      log "WARNING: shipped ${rel} failed sh syntax check; leaving local copy untouched"
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
UPDATE_NODE_EGRESSD_UNIT=0
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
extract_bin_cname="amnezia-agent-update-bin-$$-${RANDOM}"
if docker create --name "$extract_bin_cname" "$IMAGE" >/dev/null 2>&1; then
  if docker cp "${extract_bin_cname}:/opt/node-agent/bin/amnezia-egressd" "$NEW_EGRESSD" >/dev/null 2>&1; then
    HAS_NEW_EGRESSD=1
  fi
  if docker cp "${extract_bin_cname}:/opt/node-agent/deploy/systemd/amnezia-egressd.service" "$NEW_EGRESSD_UNIT" >/dev/null 2>&1; then
    HAS_NEW_EGRESSD_UNIT=1
  fi
  docker rm "$extract_bin_cname" >/dev/null 2>&1 || true
fi
if [ "$HAS_NEW_EGRESSD" -eq 1 ] && [ -x "$EGRESSD_DEST_BIN" ] && ! cmp -s "$NEW_EGRESSD" "$EGRESSD_DEST_BIN"; then
  UPDATE_EGRESSD=1
  log "new image ships an updated amnezia-egressd host binary"
fi
if [ "$HAS_NEW_EGRESSD_UNIT" -eq 1 ]; then
  render_egressd_unit "$NEW_EGRESSD_UNIT" "$NEW_EGRESSD_UNIT_RENDERED"
  if [ -f "$EGRESSD_NODE_UNIT" ] && ! cmp -s "$NEW_EGRESSD_UNIT" "$EGRESSD_NODE_UNIT"; then
    UPDATE_NODE_EGRESSD_UNIT=1
  fi
  if [ -f "$EGRESSD_DEST_UNIT" ] && ! cmp -s "$NEW_EGRESSD_UNIT_RENDERED" "$EGRESSD_DEST_UNIT"; then
    unit_unmodified=0
    if [ -f "$EGRESSD_NODE_UNIT" ]; then
      render_egressd_unit "$EGRESSD_NODE_UNIT" "$OLD_EGRESSD_UNIT_RENDERED"
      if cmp -s "$OLD_EGRESSD_UNIT_RENDERED" "$EGRESSD_DEST_UNIT"; then
        unit_unmodified=1
      fi
    elif [ -n "$CURRENT_IMAGE" ]; then
      old_unit_cname="amnezia-agent-update-oldunit-$$-${RANDOM}"
      OLD_IMAGE_EGRESSD_UNIT="${SCRATCH}/old-image-egressd.service"
      if docker create --name "$old_unit_cname" "$CURRENT_IMAGE" >/dev/null 2>&1; then
        if docker cp "${old_unit_cname}:/opt/node-agent/deploy/systemd/amnezia-egressd.service" "$OLD_IMAGE_EGRESSD_UNIT" >/dev/null 2>&1; then
          render_egressd_unit "$OLD_IMAGE_EGRESSD_UNIT" "$OLD_EGRESSD_UNIT_RENDERED"
          if cmp -s "$OLD_EGRESSD_UNIT_RENDERED" "$EGRESSD_DEST_UNIT"; then
            unit_unmodified=1
          fi
        fi
        docker rm "$old_unit_cname" >/dev/null 2>&1 || true
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
  if [ "$UPDATE_NODE_EGRESSD_UNIT" -eq 1 ] && [ -f "$EGRESSD_NODE_UNIT_BACKUP" ]; then
    cp -pf "$EGRESSD_NODE_UNIT_BACKUP" "$EGRESSD_NODE_UNIT"
  fi
  if [ "$UPDATE_EGRESSD_UNIT" -eq 1 ] && [ -f "$EGRESSD_UNIT_BACKUP" ]; then
    cp -pf "$EGRESSD_UNIT_BACKUP" "$EGRESSD_DEST_UNIT"
    chmod 0644 "$EGRESSD_DEST_UNIT"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >>"$LOG" 2>&1 || true
    fi
  fi
  if [ "$UPDATE_EGRESSD" -eq 1 ] || [ "$UPDATE_EGRESSD_UNIT" -eq 1 ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled amnezia-egressd.service >/dev/null 2>&1; then
      systemctl restart amnezia-egressd.service >>"$LOG" 2>&1 || true
    fi
  fi
  agent_up || log "WARNING: the rollback could not recreate the agent"
}

if [ "$apply_compose" -eq 1 ]; then
  cp -f "$NEW_COMPOSE" "$COMPOSE_FILE"
fi
if [ "$UPDATE_EGRESSD" -eq 1 ]; then
  cp -p "$EGRESSD_DEST_BIN" "$EGRESSD_BACKUP"
  egressd_tmp="$(mktemp "${EGRESSD_DEST_BIN}.XXXXXX")" || fail_out "could not stage amnezia-egressd"
  cat "$NEW_EGRESSD" >"$egressd_tmp" || { rm -f "$egressd_tmp"; fail_out "could not write amnezia-egressd"; }
  chmod 0755 "$egressd_tmp"
  mv -f "$egressd_tmp" "$EGRESSD_DEST_BIN"
fi
if [ "$UPDATE_NODE_EGRESSD_UNIT" -eq 1 ]; then
  cp -p "$EGRESSD_NODE_UNIT" "$EGRESSD_NODE_UNIT_BACKUP"
  cp -f "$NEW_EGRESSD_UNIT" "$EGRESSD_NODE_UNIT"
fi
if [ "$UPDATE_EGRESSD_UNIT" -eq 1 ]; then
  cp -p "$EGRESSD_DEST_UNIT" "$EGRESSD_UNIT_BACKUP"
  unit_tmp="$(mktemp "${EGRESSD_DEST_UNIT}.XXXXXX")" || fail_out "could not stage amnezia-egressd unit"
  cat "$NEW_EGRESSD_UNIT_RENDERED" >"$unit_tmp" || { rm -f "$unit_tmp"; fail_out "could not write amnezia-egressd unit"; }
  chmod 0644 "$unit_tmp"
  mv -f "$unit_tmp" "$EGRESSD_DEST_UNIT"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >>"$LOG" 2>&1 || true
  fi
fi
if [ "$UPDATE_EGRESSD" -eq 1 ] || [ "$UPDATE_EGRESSD_UNIT" -eq 1 ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled amnezia-egressd.service >/dev/null 2>&1; then
    if ! systemctl restart amnezia-egressd.service >>"$LOG" 2>&1; then
      rollback
      fail_out "amnezia-egressd failed to restart after update; rolled back"
    fi
  fi
fi
for rel in ${APPLY_SCRIPTS[@]+"${APPLY_SCRIPTS[@]}"}; do
  safe_key="${rel//\//_}"
  dest="${NODE_DIR}/${rel}"
  script_tmp="$(mktemp "${dest}.XXXXXX")" || fail_out "could not stage ${rel}"
  cat "${SCRATCH}/new-${safe_key}" >"$script_tmp" || { rm -f "$script_tmp"; fail_out "could not write ${rel}"; }
  chmod 0755 "$script_tmp"
  mv -f "$script_tmp" "$dest"
done
# Enable IPv6 forwarding sysctls live before bringing up the new agent so its
# first /server report already reflects ipv6RejectStub.supported = true.
ensure_awg3_ipv6_forwarding
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
