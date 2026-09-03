#!/usr/bin/env bash
# One-time install of the host-side updater behind the panel's "update this
# node's agent" button. Run as root from the node directory on the server:
#
#   sudo NODE_AGENT_UPDATE_REPO=ghcr.io/<owner>/<repo>/node-agent \
#        bash scripts/install-agent-updater.sh
#
# It creates the shared spool (writable by the agent container's uid), installs
# the systemd path+service units pointed at THIS node directory, and enables the
# watcher. Then recreate the agent so it mounts the spool:
#
#   docker compose --env-file .env -f compose.yaml up -d --no-deps node-agent
#
# Until this has been run the feature is simply off: the agent has no
# NODE_AGENT_UPDATE_REPO, refuses every update request, and the panel reports
# that the node cannot update itself.
#
# Modelled on infra/prod/install-updater.sh, which does the same for the panel.
set -euo pipefail

NODE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SPOOL_DIR="${NODE_UPDATE_SPOOL_DIR:-/var/lib/amnezia-node/update}"
UPDATE_REPO="${NODE_AGENT_UPDATE_REPO:-}"
# The agent container runs as uid 10001 (compose.yaml: user "10001:0"); it must
# own the spool to write the request file. Override if you changed the image.
CONTAINER_UID="${NODE_AGENT_CONTAINER_UID:-10001}"

if [ "$(id -u)" -ne 0 ]; then
  echo "!! must run as root (sudo)"; exit 1
fi
if [ -z "$UPDATE_REPO" ]; then
  echo "!! set NODE_AGENT_UPDATE_REPO to the repository the panel publishes to,"
  echo "!! e.g. NODE_AGENT_UPDATE_REPO=ghcr.io/<owner>/<repo>/node-agent"
  exit 1
fi
case "$UPDATE_REPO" in
  *@*|*:*/*|*' '*) echo "!! NODE_AGENT_UPDATE_REPO must be a bare repository name"; exit 1 ;;
esac
[ -f "$NODE_DIR/compose.yaml" ] || { echo "!! no compose.yaml in ${NODE_DIR}"; exit 1; }
[ -f "$NODE_DIR/.env" ] || { echo "!! no .env in ${NODE_DIR}"; exit 1; }

echo "==> Node:  ${NODE_DIR}"
echo "==> Spool: ${SPOOL_DIR} (owner uid ${CONTAINER_UID})"
echo "==> Repo:  ${UPDATE_REPO}"

mkdir -p "$SPOOL_DIR"
chown "${CONTAINER_UID}:${CONTAINER_UID}" "$SPOOL_DIR"
chmod 0770 "$SPOOL_DIR"
chmod +x "${NODE_DIR}/scripts/agent-update.sh"

echo "==> Installing systemd units"
sed -e "s#/opt/amnezia-node#${NODE_DIR}#g" \
    -e "s#/var/lib/amnezia-node/update#${SPOOL_DIR}#g" \
    -e "s#^Environment=NODE_AGENT_UPDATE_REPO=\$#Environment=NODE_AGENT_UPDATE_REPO=${UPDATE_REPO}#" \
    "${NODE_DIR}/systemd/amnezia-node-agent-update.service" \
    >/etc/systemd/system/amnezia-node-agent-update.service
sed -e "s#/var/lib/amnezia-node/update#${SPOOL_DIR}#g" \
    "${NODE_DIR}/systemd/amnezia-node-agent-update.path" \
    >/etc/systemd/system/amnezia-node-agent-update.path

systemctl daemon-reload
systemctl enable --now amnezia-node-agent-update.path

# The agent needs the same two settings to accept a request at all.
if ! grep -q '^NODE_AGENT_UPDATE_REPO=' "${NODE_DIR}/.env"; then
  printf 'NODE_AGENT_UPDATE_REPO=%s\n' "$UPDATE_REPO" >>"${NODE_DIR}/.env"
fi
if [ "$SPOOL_DIR" != "/var/lib/amnezia-node/update" ] \
   && ! grep -q '^NODE_UPDATE_SPOOL_DIR=' "${NODE_DIR}/.env"; then
  printf 'NODE_UPDATE_SPOOL_DIR=%s\n' "$SPOOL_DIR" >>"${NODE_DIR}/.env"
fi

cat <<EOF
==> Installed and watching.

Next:
  1) Recreate the agent so it mounts the spool (--no-deps keeps every tunnel up):
       docker compose --env-file "${NODE_DIR}/.env" -f "${NODE_DIR}/compose.yaml" \\
         up -d --no-deps node-agent
  2) The node card in Administration will now offer "Update agent".

Watcher status:  systemctl status amnezia-node-agent-update.path
Last run logs:   journalctl -u amnezia-node-agent-update.service -n 50
Update log:      ${SPOOL_DIR}/update.log
EOF
