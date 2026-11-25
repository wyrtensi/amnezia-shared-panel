#!/usr/bin/env bash
# Back up the panel Postgres database to a timestamped, gzipped SQL dump.
# Data lives in the `postgres-data` volume; this is a logical export for
# restore/rollback. Usage: scripts/backup-db.sh [output-dir]
set -euo pipefail
# The dump carries the full user roster, emails, roles and traffic history:
# create it (and its directory) readable by the owner only, matching the
# node-side policy in infra/node/scripts/common.sh (ensure_layout).
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib/compose-dir.sh"
COMPOSE_DIR="$(require_compose_dir)" || exit 1
COMPOSE_ARGS=(-f "${COMPOSE_DIR}/compose.yaml")
if [ -f "${COMPOSE_DIR}/compose.override.yaml" ]; then
  COMPOSE_ARGS+=(-f "${COMPOSE_DIR}/compose.override.yaml")
fi
USER_NAME="${POSTGRES_USER:-amnezia_panel}"
DB_NAME="${POSTGRES_DB:-amnezia_panel}"
OUT_DIR="${1:-backups}"
KEEP_COUNT="${BACKUP_KEEP_COUNT:-14}"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/panel-db-${STAMP}.sql.gz"
TMP="${FILE}.part"
# Remove a partial dump if the pipeline aborts, so no truncated .sql.gz is left
# looking like a valid backup.
trap 'rm -f "$TMP"' EXIT

echo "Backing up database '${DB_NAME}' -> ${FILE}"
# --clean --if-exists so the dump self-heals on restore into an existing DB.
set -o pipefail
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
  pg_dump -U "$USER_NAME" -d "$DB_NAME" --no-owner --clean --if-exists \
  | gzip >"$TMP"
mv "$TMP" "$FILE"
trap - EXIT
echo "Backup written: ${FILE} ($(du -h "$FILE" | cut -f1))"

if [ "$KEEP_COUNT" -gt 0 ] 2>/dev/null; then
  mapfile -t existing_backups < <(ls -1t "${OUT_DIR}"/panel-db-*.sql.gz 2>/dev/null || true)
  if [ "${#existing_backups[@]}" -gt "$KEEP_COUNT" ]; then
    rm -f "${existing_backups[@]:$KEEP_COUNT}"
    echo "Pruned $(( ${#existing_backups[@]} - KEEP_COUNT )) old backup(s), keeping newest ${KEEP_COUNT}"
  fi
fi
