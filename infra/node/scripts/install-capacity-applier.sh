#!/usr/bin/env bash
# One-time install of the host-side applier behind the panel's "change this
# node's capacity" control. Run as root from the node directory on the server:
#
#   sudo bash scripts/install-capacity-applier.sh
#
# It creates the shared spool (writable by the agent container's uid), installs
# the systemd path+service units pointed at THIS node directory, and enables the
# watcher. Then recreate the agent so it mounts the spool:
#
#   docker compose --env-file .env -f compose.yaml up -d --no-deps node-agent
#
# Until this has been run the feature is simply off: the agent has no
# NODE_AGENT_CAPACITY_SPOOL, answers 501 to every capacity request, and the
# panel reports that the node cannot change its own capacity.
#
# Modelled on install-agent-updater.sh, which does the same for the agent image.
# The two are deliberately separate spools and separate units: an update in
# flight must not block a capacity change, and neither may read the other's
# result as its own.
set -euo pipefail

NODE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SPOOL_DIR="${NODE_CAPACITY_SPOOL_DIR:-/var/lib/amnezia-node/capacity}"
# The agent container runs as uid 10001 (compose.yaml: user "10001:0"); it must
# own the spool to write the request file. Override if you changed the image.
CONTAINER_UID="${NODE_AGENT_CONTAINER_UID:-10001}"

UNIT_DIR="${AMNEZIA_UNIT_DIR:-/etc/systemd/system}"
UNIT_SEARCH_DIRS="${AMNEZIA_UNIT_SEARCH_DIRS:-${UNIT_DIR} /run/systemd/system /usr/lib/systemd/system}"

# The unit launches the script through an explicit interpreter, so its mode bits
# do not matter. Check what that command needs before touching the host: the
# interpreter, a readable regular script and valid Bash syntax.
validate_updater_script() {
  [ -x /bin/bash ] || { echo "!! /bin/bash is missing or not executable; the capacity applier unit cannot start"; exit 1; }
  { [ -f "$1" ] && [ -r "$1" ]; } || { echo "!! $1 is not a readable file"; exit 1; }
  /bin/bash -n "$1" || { echo "!! $1 has a Bash syntax error; not installing"; exit 1; }
}

# A drop-in that sets ExecStart= would replace the command rendered below and
# bring the 203/EXEC failure back. Refuse and name the unit.
reject_execstart_override() {
  local unit="$1" dir conf
  for dir in $UNIT_SEARCH_DIRS; do
    for conf in "$dir/$unit.d/"*.conf; do
      [ -f "$conf" ] || continue
      if grep -Eq '^[[:space:]]*ExecStart[[:space:]]*=' "$conf"; then
        echo "!! ${unit}: drop-in ${conf} overrides ExecStart; remove that line (or the file) and run this installer again"
        exit 1
      fi
    done
  done
}

# Ask systemd what it will actually run, after the daemon-reload.
verify_effective_execstart() {
  local unit="$1" script="$2" effective
  effective="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null || true)"
  case "$effective" in
    *"argv[]=/bin/bash ${script} ;"*) ;;
    *) echo "!! ${unit}: effective ExecStart is not '/bin/bash ${script}' (${effective:-unreadable}); a drop-in or another unit file overrides it. The unit files were already written to ${UNIT_DIR} and systemd was reloaded, but the watcher was NOT enabled"; exit 1 ;;
  esac
}

set_env_key() {
  local key="$1" value="$2" env_file="${NODE_DIR}/.env" env_tmp
  env_tmp="$(mktemp "${NODE_DIR}/.env.XXXXXX")" || return 1
  awk -v k="$key" -v v="$value" '
    $0 ~ ("^" k "=") && !seen { print k "=" v; seen = 1; next }
    { print }
    END { if (!seen) print k "=" v }
  ' "$env_file" >"$env_tmp" || { rm -f "$env_tmp"; return 1; }
  chmod 600 "$env_tmp"
  mv -f "$env_tmp" "$env_file"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "!! must run as root (sudo)"; exit 1
fi
[ -f "$NODE_DIR/compose.yaml" ] || { echo "!! no compose.yaml in ${NODE_DIR}"; exit 1; }
[ -f "$NODE_DIR/.env" ] || { echo "!! no .env in ${NODE_DIR}"; exit 1; }
# The applier delegates the actual change to this script; a node provisioned
# before it existed would fail at apply time with a confusing message.
[ -f "$NODE_DIR/scripts/set-capacity.sh" ] || {
  echo "!! this node has no scripts/set-capacity.sh - re-provision it first"; exit 1; }

APPLIER_SCRIPT="${NODE_DIR}/scripts/capacity-apply.sh"
validate_updater_script "$APPLIER_SCRIPT"
reject_execstart_override amnezia-node-capacity.service

echo "==> Node:  ${NODE_DIR}"
echo "==> Spool: ${SPOOL_DIR} (owner uid ${CONTAINER_UID})"

mkdir -p "$SPOOL_DIR"
chown "${CONTAINER_UID}:${CONTAINER_UID}" "$SPOOL_DIR"
chmod 0770 "$SPOOL_DIR"

echo "==> Installing systemd units"
mkdir -p "$UNIT_DIR"
svc_tmp="$(mktemp "${UNIT_DIR}/.amnezia-node-capacity.service.XXXXXX")"
sed -e "s#/opt/amnezia-node#${NODE_DIR}#g" \
    -e "s#/var/lib/amnezia-node/capacity#${SPOOL_DIR}#g" \
    "${NODE_DIR}/systemd/amnezia-node-capacity.service" \
    >"$svc_tmp"
chmod 0644 "$svc_tmp"
mv -f "$svc_tmp" "${UNIT_DIR}/amnezia-node-capacity.service"

path_tmp="$(mktemp "${UNIT_DIR}/.amnezia-node-capacity.path.XXXXXX")"
sed -e "s#/var/lib/amnezia-node/capacity#${SPOOL_DIR}#g" \
    "${NODE_DIR}/systemd/amnezia-node-capacity.path" \
    >"$path_tmp"
chmod 0644 "$path_tmp"
mv -f "$path_tmp" "${UNIT_DIR}/amnezia-node-capacity.path"

systemctl daemon-reload
verify_effective_execstart amnezia-node-capacity.service "$APPLIER_SCRIPT"
systemctl enable --now amnezia-node-capacity.path

# compose.yaml already points the agent at the container-side path and binds the
# host directory here; only a NON-default host directory needs recording. What
# actually switches the feature on is the chown above: Docker creates this bind
# root-owned, and an agent that cannot write the spool reports the feature as
# unavailable.
if [ "$SPOOL_DIR" != "/var/lib/amnezia-node/capacity" ]; then
  set_env_key NODE_CAPACITY_SPOOL_DIR "$SPOOL_DIR"
fi

cat <<EOF
==> Installed and watching.

Next:
  1) Recreate the agent so it mounts the spool (--no-deps keeps every tunnel up):
       docker compose --env-file "${NODE_DIR}/.env" -f "${NODE_DIR}/compose.yaml" \\
         up -d --no-deps node-agent
  2) The node card in Administration will now offer "Change capacity".

Watcher status:  systemctl status amnezia-node-capacity.path
Last run logs:   journalctl -u amnezia-node-capacity.service -n 50
Apply log:       ${SPOOL_DIR}/apply.log
EOF
