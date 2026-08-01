#!/usr/bin/env bash
# backup-postgres.sh — create a timestamped, compressed PostgreSQL backup.
#
# Safe to run before cloud provisioning: with no S3_BUCKET set it writes to a
# local directory only. Restore with scripts/restore-postgres.sh.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/backup-postgres.sh
#   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... ./scripts/backup-postgres.sh
#
# Environment:
#   DATABASE_URL     Connection string (alternative: standard PG* variables)
#   BACKUP_DIR       Output directory            (default: ./backups)
#   RETENTION_DAYS   Local pruning window        (default: 14)
#   S3_BUCKET        Optional s3://bucket[/prefix] for off-site upload.
#                    EXTERNAL: requires provisioned bucket + AWS credentials.
#   S3_ENDPOINT_URL  Optional S3-compatible endpoint (e.g. Backblaze, MinIO)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/agric_platform_${TIMESTAMP}.dump"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

command -v pg_dump >/dev/null 2>&1 || fail "pg_dump not found (install postgresql-client)."

# pg_dump accepts DATABASE_URL natively; PG* variables are picked up from the
# environment automatically. Never echo credentials here.
if [ -z "${DATABASE_URL:-}" ] && [ -z "${PGDATABASE:-}" ]; then
  fail "Set DATABASE_URL or the standard PG* variables (PGHOST/PGUSER/PGDATABASE...)."
fi

mkdir -p "$BACKUP_DIR"

info "Dumping database to ${BACKUP_FILE}"
pg_dump ${DATABASE_URL:+--dbname="$DATABASE_URL"} \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$BACKUP_FILE"

info "Writing SHA-256 checksum"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$BACKUP_FILE")" > "$(basename "$BACKUP_FILE").sha256" )

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
info "Backup complete: ${BACKUP_FILE} (${SIZE})"

# Optional off-site upload (external dependency: provisioned bucket).
if [ -n "${S3_BUCKET:-}" ]; then
  command -v aws >/dev/null 2>&1 || fail "S3_BUCKET set but aws CLI not found."
  S3_TARGET="${S3_BUCKET#s3://}"
  info "Uploading to s3://${S3_TARGET}/"
  aws ${S3_ENDPOINT_URL:+--endpoint-url="$S3_ENDPOINT_URL"} s3 cp \
    "$BACKUP_FILE" "s3://${S3_TARGET}/$(basename "$BACKUP_FILE")"
  aws ${S3_ENDPOINT_URL:+--endpoint-url="$S3_ENDPOINT_URL"} s3 cp \
    "${BACKUP_FILE}.sha256" "s3://${S3_TARGET}/$(basename "$BACKUP_FILE").sha256"
fi

info "Pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name 'agric_platform_*.dump*' -mtime "+${RETENTION_DAYS}" -delete

info "Done."
