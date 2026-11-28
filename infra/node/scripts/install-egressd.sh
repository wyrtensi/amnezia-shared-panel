#!/bin/sh
# Install or update the host amnezia-egressd binary and systemd service from
# the node's pinned NODE_AGENT_IMAGE (or AMNEZIA_EGRESSD_BIN for offline/test runs).
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

UNIT_DIR="${AMNEZIA_UNIT_DIR:-/etc/systemd/system}"
BIN_DEST="${AMNEZIA_EGRESSD_DEST:-/usr/local/bin/amnezia-egressd}"
EGRESS_DIR="${AMNEZIA_EGRESS_DIR:-/etc/amnezia-egress}"
RUN_DIR="${NODE_EGRESS_RUN_DIR:-/run/amnezia-egress}"
SRC_BIN="${AMNEZIA_EGRESSD_BIN:-}"

[ "$(id -u)" -eq 0 ] || [ "${AMNEZIA_ALLOW_NONROOT:-0}" = "1" ] || fail "must run as root"
[ -f "$ENV_FILE" ] || fail "missing .env at $ENV_FILE"
[ -f "$NODE_DIR/systemd/amnezia-egressd.service" ] || fail "missing systemd/amnezia-egressd.service"

tmp_bin="$(mktemp)"
cleanup() { rm -f "$tmp_bin"; }
trap cleanup EXIT INT TERM

if [ -n "$SRC_BIN" ]; then
  [ -x "$SRC_BIN" ] || fail "AMNEZIA_EGRESSD_BIN is not executable: $SRC_BIN"
  cp "$SRC_BIN" "$tmp_bin"
else
  node_image="$(env_value NODE_AGENT_IMAGE)"
  [ -n "$node_image" ] || fail "NODE_AGENT_IMAGE is unset in $ENV_FILE"
  cname="amnezia-egressd-extract-$$"
  docker create --name "$cname" "$node_image" >/dev/null
  rc=0
  docker cp "${cname}:/opt/node-agent/bin/amnezia-egressd" "$tmp_bin" >/dev/null 2>&1 || rc=1
  docker rm "$cname" >/dev/null 2>&1 || true
  [ "$rc" -eq 0 ] || fail "image $node_image does not contain /opt/node-agent/bin/amnezia-egressd"
fi

install -d -m 0700 "$EGRESS_DIR"
install -d -m 0755 "$RUN_DIR"
install -d -m 0755 "$(dirname -- "$BIN_DEST")"
install -m 0755 "$tmp_bin" "${BIN_DEST}.new"
mv -f "${BIN_DEST}.new" "$BIN_DEST"

install -d -m 0755 "$UNIT_DIR"
sed -e "s#/opt/amnezia-node#${NODE_DIR}#g" \
    -e "s#/usr/local/bin/amnezia-egressd#${BIN_DEST}#g" \
    -e "s#/etc/amnezia-egress/state.json#${EGRESS_STATE_FILE}#g" \
    -e "s#/run/amnezia-egress/egressd.sock#${RUN_DIR}/egressd.sock#g" \
    "$NODE_DIR/systemd/amnezia-egressd.service" \
    >"${UNIT_DIR}/amnezia-egressd.service.tmp"
chmod 0644 "${UNIT_DIR}/amnezia-egressd.service.tmp"
mv -f "${UNIT_DIR}/amnezia-egressd.service.tmp" "${UNIT_DIR}/amnezia-egressd.service"

if command -v systemctl >/dev/null 2>&1 && [ "${AMNEZIA_SKIP_SYSTEMCTL:-0}" != "1" ]; then
  systemctl daemon-reload
  systemctl enable --now amnezia-egressd.service
  systemctl restart amnezia-egressd.service
fi

info "Installed amnezia-egressd at $BIN_DEST and enabled amnezia-egressd.service."
