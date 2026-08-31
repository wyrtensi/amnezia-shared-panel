#!/usr/bin/env bash
# Back up the panel Postgres database to a timestamped, gzipped SQL dump.
# Data lives in the `postgres-data` volume; this is a logical export for
# restore/rollback. Usage: scripts/backup-db.sh [output-dir]
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-infra/dev}"
COMPOSE="docker compose -f ${COMPOSE_DIR}/compose.yaml"
USER_NAME="${POSTGRES_USER:-amnezia_panel}"
DB_NAME="${POSTGRES_DB:-amnezia_panel}"
OUT_DIR="${1:-backups}"

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/panel-db-${STAMP}.sql.gz"
TMP="${FILE}.part"
# Remove a partial dump if the pipeline aborts, so no truncated .sql.gz is left
# looking like a valid backup.
trap 'rm -f "$TMP"' EXIT

echo "Backing up database '${DB_NAME}' -> ${FILE}"
# --clean --if-exists so the dump self-heals on restore into an existing DB.
set -o pipefail
$COMPOSE exec -T postgres \
  pg_dump -U "$USER_NAME" -d "$DB_NAME" --no-owner --clean --if-exists \
  | gzip >"$TMP"
mv "$TMP" "$FILE"
trap - EXIT
echo "Backup written: ${FILE} ($(du -h "$FILE" | cut -f1))"
