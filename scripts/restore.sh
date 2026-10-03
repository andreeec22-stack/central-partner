#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh. REPLACES the current data.
#
#   ./scripts/restore.sh backups/db_20261001_020000.sql.gz [backups/uploads_20261001_020000.tar.gz] [--yes]
#
# The API is stopped while restoring (no writes in between) and started again
# afterwards; on start it applies any migration newer than the backup.
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

DB_FILE=""; FILES_FILE=""; ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    *.sql.gz) DB_FILE="$arg" ;;
    *.tar.gz) FILES_FILE="$arg" ;;
    *) echo "Argumento no reconocido: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "$DB_FILE" ]; then
  echo "Uso: ./scripts/restore.sh <db_*.sql.gz> [uploads_*.tar.gz] [--yes]" >&2
  exit 1
fi
for f in "$DB_FILE" ${FILES_FILE:+"$FILES_FILE"}; do
  [ -f "$f" ] || { echo "Archivo no encontrado: $f" >&2; exit 1; }
  gzip -t "$f" || { echo "Archivo dañado: $f" >&2; exit 1; }
done

COMPOSE=(docker compose -f docker-compose.prod.yml)
DB_NAME="${POSTGRES_DB:-central_partner}"
DB_USER="${POSTGRES_USER:-central}"

echo "Restaurar base desde: $DB_FILE"
[ -n "$FILES_FILE" ] && echo "Restaurar archivos desde: $FILES_FILE"
echo "⚠️  Esto SOBRESCRIBE la base de datos${FILES_FILE:+ y los archivos} actuales."
if ! $ASSUME_YES; then
  read -r -p "¿Continuar? (y/N) " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Cancelado"; exit 1; }
fi

echo "Deteniendo la API…"
"${COMPOSE[@]}" stop api
trap 'echo "Iniciando la API…"; "${COMPOSE[@]}" start api' EXIT

echo "Restaurando la base…"
gunzip -c "$DB_FILE" | "${COMPOSE[@]}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 --single-transaction --quiet -U "$DB_USER" -d "$DB_NAME" > /dev/null

if [ -n "$FILES_FILE" ]; then
  echo "Restaurando archivos…"
  "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh api \
    -c 'rm -rf /app/apps/api/uploads/* && tar -xzf - -C /app/apps/api' < "$FILES_FILE"
fi

echo "Restauración completada"
