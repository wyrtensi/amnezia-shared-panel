#!/usr/bin/env bash
# One-time install of the host-side updater that powers the in-panel "Update"
# button. Run as root from the repo root on the server:
#
#   sudo bash infra/prod/install-updater.sh
#
# It creates the shared spool (writable by the container uid), installs the
# systemd path+service units pointed at THIS checkout, and enables the watcher.
# Then set UPDATE_SPOOL_HOST_DIR in infra/prod/.env (if you changed it) and
# recreate control-api so it mounts the spool.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SPOOL_DIR="${UPDATE_SPOOL_HOST_DIR:-/var/lib/amnezia-panel/update}"
# control-api runs as the node image's uid (1000); it must own the spool to
# write the request file. Override PANEL_CONTAINER_UID if you changed the image.
CONTAINER_UID="${PANEL_CONTAINER_UID:-1000}"

UNIT_DIR="${AMNEZIA_UNIT_DIR:-/etc/systemd/system}"
UNIT_SEARCH_DIRS="${AMNEZIA_UNIT_SEARCH_DIRS:-${UNIT_DIR} /run/systemd/system /usr/lib/systemd/system}"

# The unit launches the script through an explicit interpreter, so its mode bits
# do not matter. Check what that command needs before touching the host: the
# interpreter, a readable regular script and valid Bash syntax.
validate_updater_script() {
  [ -x /bin/bash ] || { echo "!! /bin/bash is missing or not executable; the updater unit cannot start"; exit 1; }
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
    *) echo "!! ${unit}: effective ExecStart is not '/bin/bash ${script}' (${effective:-unreadable}); a drop-in or another unit file overrides it"; exit 1 ;;
  esac
}

if [ "$(id -u)" -ne 0 ]; then
  echo "!! must run as root (sudo)"; exit 1
fi

UPDATER_SCRIPT="${REPO_DIR}/infra/prod/panel-updater.sh"
validate_updater_script "$UPDATER_SCRIPT"
reject_execstart_override panel-updater.service

echo "==> Repo:  ${REPO_DIR}"
echo "==> Spool: ${SPOOL_DIR} (owner uid ${CONTAINER_UID})"

mkdir -p "$SPOOL_DIR"
chown "${CONTAINER_UID}:${CONTAINER_UID}" "$SPOOL_DIR"
chmod 0770 "$SPOOL_DIR"

echo "==> Installing systemd units"
mkdir -p "$UNIT_DIR"
sed -e "s#/opt/amnezia-panel#${REPO_DIR}#g" \
    -e "s#/var/lib/amnezia-panel/update#${SPOOL_DIR}#g" \
    "${REPO_DIR}/infra/prod/panel-updater.service" \
    >"${UNIT_DIR}/panel-updater.service"
sed -e "s#/var/lib/amnezia-panel/update#${SPOOL_DIR}#g" \
    "${REPO_DIR}/infra/prod/panel-updater.path" \
    >"${UNIT_DIR}/panel-updater.path"

systemctl daemon-reload
verify_effective_execstart panel-updater.service "$UPDATER_SCRIPT"
systemctl enable --now panel-updater.path

cat <<EOF
==> Installed and watching.

Next:
  1) In infra/prod/.env set (only if you changed the default):
       UPDATE_SPOOL_HOST_DIR=${SPOOL_DIR}
  2) Recreate control-api so it mounts the spool:
       docker compose -f infra/prod/compose.yaml up -d control-api
  3) The "Обновить панель" button in Administration will now run update.sh.

Watcher status:  systemctl status panel-updater.path
Last run logs:   journalctl -u panel-updater.service -n 50
EOF
