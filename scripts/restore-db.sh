#!/usr/bin/env bash
# Restore the panel Postgres database from a dump made by backup-db.sh.
# Usage: scripts/restore-db.sh <dump.sql.gz>
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-infra/dev}"
COMPOSE="docker compose -f ${COMPOSE_DIR}/compose.yaml"
USER_NAME="${POSTGRES_USER:-amnezia_panel}"
DB_NAME="${POSTGRES_DB:-amnezia_panel}"
FILE="${1:?Usage: scripts/restore-db.sh <dump.sql.gz>}"

[ -f "$FILE" ] || { echo "No such file: $FILE" >&2; exit 1; }

echo "Restoring ${FILE} into '${DB_NAME}'. Existing objects are dropped/recreated."
# ON_ERROR_STOP so a failed restore exits non-zero instead of a false success;
# the dump carries DROP ... IF EXISTS (backup-db.sh --clean --if-exists).
set -o pipefail
gunzip -c "$FILE" \
  | $COMPOSE exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U "$USER_NAME" -d "$DB_NAME"
echo "Restore complete."
