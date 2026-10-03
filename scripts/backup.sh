#!/usr/bin/env bash
# Backup of the production stack: the database and the local file storage
# (reports, attachments, logos in the api-uploads volume).
#
#   ./scripts/backup.sh               # from anywhere; reads the repo's .env
#   0 2 * * * /opt/central-partner/scripts/backup.sh >> /var/log/central-partner-backup.log 2>&1
#
# Writes BACKUP_DIR/db_<stamp>.sql.gz and uploads_<stamp>.tar.gz, keeps
# BACKUP_KEEP_DAYS days, and copies both to s3://BACKUP_S3_BUCKET when set.
# With an external database (e.g. Supabase) set BACKUP_DATABASE_URL instead:
# pg_dump then runs on this host against that URL.
set -euo pipefail
# Git Bash on Windows would rewrite container paths such as /app/... (no-op on Linux).
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
# Only the keys these scripts need, read literally (values such as
# SMTP_FROM="Name <mail>" would break if .env were sourced as shell).
env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
for key in POSTGRES_DB POSTGRES_USER BACKUP_DIR BACKUP_KEEP_DAYS BACKUP_S3_BUCKET BACKUP_S3_PREFIX BACKUP_DATABASE_URL; do
  if [ -z "${!key:-}" ]; then value="$(env_get "$key")"; [ -n "$value" ] && export "$key=$value"; fi
done

COMPOSE=(docker compose -f docker-compose.prod.yml)
DB_NAME="${POSTGRES_DB:-central_partner}"
DB_USER="${POSTGRES_USER:-central}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"
DB_FILE="$BACKUP_DIR/db_${STAMP}.sql.gz"
FILES_FILE="$BACKUP_DIR/uploads_${STAMP}.tar.gz"

log() { echo "[$(date '+%F %T')] $*"; }

# --clean --if-exists: the dump drops and recreates every object, so a restore
# replaces the database instead of colliding with what is there.
DUMP_ARGS=(--clean --if-exists --no-owner --no-privileges)

log "Backup de la base $DB_NAME…"
if [ -n "${BACKUP_DATABASE_URL:-}" ]; then
  pg_dump "${DUMP_ARGS[@]}" "$BACKUP_DATABASE_URL" | gzip > "$DB_FILE.partial"
else
  "${COMPOSE[@]}" exec -T postgres pg_dump "${DUMP_ARGS[@]}" -U "$DB_USER" -d "$DB_NAME" | gzip > "$DB_FILE.partial"
fi
gzip -t "$DB_FILE.partial"
mv "$DB_FILE.partial" "$DB_FILE"
log "Base guardada: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"

log "Backup de archivos locales…"
"${COMPOSE[@]}" exec -T api tar -czf - -C /app/apps/api uploads > "$FILES_FILE.partial"
gzip -t "$FILES_FILE.partial"
mv "$FILES_FILE.partial" "$FILES_FILE"
log "Archivos guardados: $FILES_FILE ($(du -h "$FILES_FILE" | cut -f1))"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  DEST="s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-central-partner}/"
  log "Copiando a $DEST…"
  aws s3 cp "$DB_FILE" "$DEST" --only-show-errors
  aws s3 cp "$FILES_FILE" "$DEST" --only-show-errors
fi

find "$BACKUP_DIR" -maxdepth 1 \( -name 'db_*.sql.gz' -o -name 'uploads_*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
log "Backup completado"
