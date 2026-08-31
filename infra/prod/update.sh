#!/usr/bin/env bash
# Update the panel to the latest published image — data-safe.
#
#   backup DB → stop → drop old image → pull new → migrate → up
#
# The image is built in CI and pushed to GHCR (see .github/workflows/release.yml),
# so this host only PULLS — it never builds (a 1 GB box OOMs on `next build`).
# Set PANEL_IMAGE=ghcr.io/<owner>/amnezia-shared-panel:latest in infra/prod/.env;
# for a private image, `docker login ghcr.io` once with a read:packages token.
#
# Tiny-disk note: a ~1.4 GB image can't sit twice on a 10 GB box, so we stop the
# panel and drop the current image BEFORE pulling the new one (brief downtime
# during the pull). Postgres data, the config keyring, and state live in named
# volumes, so this never touches them. Run from the repo root on the server:
#   bash infra/prod/update.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

OVERRIDE=""
[ -f infra/prod/compose.override.yaml ] && OVERRIDE="-f infra/prod/compose.override.yaml"
COMPOSE="docker compose -f infra/prod/compose.yaml ${OVERRIDE}"
PANEL_IMAGE="$(grep -E '^PANEL_IMAGE=' infra/prod/.env 2>/dev/null | cut -d= -f2- || true)"

echo "==> [1/5] Backing up the database"
COMPOSE_DIR=infra/prod bash scripts/backup-db.sh || {
  echo "!! backup failed — aborting update (data safety)"; exit 1;
}

echo "==> [2/5] Stopping the panel and freeing the old image (tiny-disk safe)"
${COMPOSE} down
[ -n "${PANEL_IMAGE}" ] && docker image rm -f "${PANEL_IMAGE}" 2>/dev/null || true
docker image prune -f >/dev/null 2>&1 || true

echo "==> [3/5] Pulling the latest image"
${COMPOSE} pull

echo "==> [4/5] Running database migrations"
${COMPOSE} run --rm migrate

echo "==> [5/5] Starting services on the new image"
${COMPOSE} up -d

echo "==> Done. Current status:"
${COMPOSE} ps
