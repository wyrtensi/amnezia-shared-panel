#!/usr/bin/env bash
# Update the panel to the latest published image — data-safe.
#
#   backup DB  →  docker compose pull  →  run migrations  →  up -d
#
# The image is built in CI and pushed to GHCR (see .github/workflows/release.yml),
# so this host only PULLS — it never builds (a 1 GB box OOMs on `next build`).
# Set PANEL_IMAGE=ghcr.io/<owner>/amnezia-panel:latest in infra/prod/.env and, for
# a private image, `docker login ghcr.io` once with a read:packages token.
#
# Postgres data, the config keyring, and any state live in named volumes, so
# pull + up never touch them. Run from the repo root on the server:
#   bash infra/prod/update.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

OVERRIDE=""
[ -f infra/prod/compose.override.yaml ] && OVERRIDE="-f infra/prod/compose.override.yaml"
COMPOSE="docker compose -f infra/prod/compose.yaml ${OVERRIDE}"

echo "==> [1/4] Backing up the database"
COMPOSE_DIR=infra/prod bash scripts/backup-db.sh || {
  echo "!! backup failed — aborting update (data safety)"; exit 1;
}

echo "==> [2/4] Pulling the latest image"
${COMPOSE} pull

echo "==> [3/4] Running database migrations"
${COMPOSE} run --rm migrate

echo "==> [4/4] Recreating services with the new image"
${COMPOSE} up -d

echo "==> Done. Current status:"
${COMPOSE} ps
