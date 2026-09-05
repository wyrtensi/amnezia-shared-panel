#!/usr/bin/env bash
# Safe in-place update of the control plane. NEVER removes volumes or resets
# data: it backs up the DB, pulls/builds new images, runs migrations, and
# recreates only the changed services. Data volumes (postgres-data, node state)
# are preserved. Usage:
#   scripts/deploy.sh            # pull prebuilt images and update
#   scripts/deploy.sh --build    # build images from the current checkout
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-infra/dev}"
# Honour an operator-supplied override exactly like infra/prod/update.sh does.
# Without this, deploying through this script drops the override — including the
# co-located-node network wiring from compose.override.colocated.yaml.example —
# and the panel silently loses its route to the node-agent on the next `up -d`.
OVERRIDE=""
if [ -f "${COMPOSE_DIR}/compose.override.yaml" ]; then
  OVERRIDE="-f ${COMPOSE_DIR}/compose.override.yaml"
fi
COMPOSE="docker compose -f ${COMPOSE_DIR}/compose.yaml ${OVERRIDE}"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# The repository this checkout came from, so the version in the admin UI links
# at THIS deployment's code rather than at whoever it was forked from. Both
# remote spellings are normalised to a browsable https URL; an unset or exotic
# remote leaves it empty and control-api falls back to its documented default.
APP_REPO_URL="$(git remote get-url origin 2>/dev/null || true)"
APP_REPO_URL="$(printf '%s' "$APP_REPO_URL" | sed -e 's#^git@\([^:]*\):#https://\1/#' -e 's#\.git$##')"
case "$APP_REPO_URL" in https://*) ;; *) APP_REPO_URL="" ;; esac

# Safety: this script must never tear down volumes.
for arg in "$@"; do
  case "$arg" in
    down|-v|--volumes|prune)
      echo "Refusing destructive argument: $arg" >&2
      exit 1
      ;;
  esac
done

echo "==> [1/4] Backing up the database"
scripts/backup-db.sh backups

if [ "${1:-}" = "--build" ]; then
  echo "==> [2/4] Building images (${GIT_SHA})"
  APP_VERSION="$GIT_SHA" GIT_SHA="$GIT_SHA" BUILD_TIME="$BUILD_TIME" \
    $COMPOSE build \
      --build-arg "APP_VERSION=${GIT_SHA}" \
      --build-arg "GIT_SHA=${GIT_SHA}" \
      --build-arg "BUILD_TIME=${BUILD_TIME}" \
      --build-arg "APP_REPO_URL=${APP_REPO_URL}"
else
  echo "==> [2/4] Pulling images"
  $COMPOSE pull
fi

echo "==> [3/4] Running migrations + recreating services (volumes preserved)"
# The one-shot `migrate` service applies forward-only migrations, then the
# app services restart. `up -d` never touches named volumes.
$COMPOSE up -d

echo "==> [4/4] Done. Deployed ${GIT_SHA}"
echo "The VPN data plane (AWG containers) was not touched."
