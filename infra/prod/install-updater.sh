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

if [ "$(id -u)" -ne 0 ]; then
  echo "!! must run as root (sudo)"; exit 1
fi

echo "==> Repo:  ${REPO_DIR}"
echo "==> Spool: ${SPOOL_DIR} (owner uid ${CONTAINER_UID})"

mkdir -p "$SPOOL_DIR"
chown "${CONTAINER_UID}:${CONTAINER_UID}" "$SPOOL_DIR"
chmod 0770 "$SPOOL_DIR"
chmod +x "${REPO_DIR}/infra/prod/panel-updater.sh"

echo "==> Installing systemd units"
sed -e "s#/opt/amnezia-panel#${REPO_DIR}#g" \
    -e "s#/var/lib/amnezia-panel/update#${SPOOL_DIR}#g" \
    "${REPO_DIR}/infra/prod/panel-updater.service" \
    >/etc/systemd/system/panel-updater.service
sed -e "s#/var/lib/amnezia-panel/update#${SPOOL_DIR}#g" \
    "${REPO_DIR}/infra/prod/panel-updater.path" \
    >/etc/systemd/system/panel-updater.path

systemctl daemon-reload
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
