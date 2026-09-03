#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

# --build-context deploy=: the image carries infra/node/compose.yaml so the
# host-side updater can prove whether a node's copy was edited locally. It lives
# outside the build context, so it arrives as a named context (needs BuildKit,
# i.e. Docker 23+).
docker build \
  --platform linux/amd64 \
  --build-context "deploy=$NODE_DIR" \
  --tag amnezia-panel/node-agent:1.0.0-local \
  "$NODE_DIR/../../services/node-agent"

image_id="$(docker image inspect --format '{{.Id}}' amnezia-panel/node-agent:1.0.0-local)"
verify_linux_amd64_image "$image_id"
info "Node-agent image built and verified. Set NODE_AGENT_IMAGE=$image_id in infra/node/.env."
