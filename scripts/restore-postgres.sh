#!/usr/bin/env bash
# restore-postgres.sh — restore a dump produced by scripts/backup-postgres.sh.
#
# DESTRUCTIVE: drops and recreates objects in the TARGET database. Read
# docs/runbooks/backup-restore.md before running this against shared infra.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/db \
#   CONFIRM_RESTORE=yes \
#   ./scripts/restore-postgres.sh backups/agric_platform_20260802T020000Z.dump
#
# Environment:
#   DATABASE_URL              Target connection string (alternative: PG* vars)
#   CONFIRM_RESTORE           Must be exactly "yes" to proceed
#   FORCE_PRODUCTION_RESTORE  Must be "yes" when the target host looks like
#                             production (no localhost/127.0.0.1) — second guard
#   PRE_RESTORE_SNAPSHOT      Set to "1" to dump the current target before
#                             overwriting (saved alongside the input dump)
set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

DUMP_FILE="${1:-}"
[ -n "$DUMP_FILE" ] || fail "Usage: $0 <path-to-dump-file>"
[ -f "$DUMP_FILE" ] || fail "Dump file not found: $DUMP_FILE"

command -v pg_restore >/dev/null 2>&1 || fail "pg_restore not found (install postgresql-client)."

if [ -z "${DATABASE_URL:-}" ] && [ -z "${PGDATABASE:-}" ]; then
  fail "Set DATABASE_URL or the standard PG* variables for the TARGET database."
fi

# --- Guards -----------------------------------------------------------------
[ "${CONFIRM_RESTORE:-}" = "yes" ] || fail "Refusing to run: set CONFIRM_RESTORE=yes to confirm a destructive restore."

TARGET_DESC="${DATABASE_URL:-${PGHOST:-unknown-host}}"
case "$TARGET_DESC" in
  *localhost*|*127.0.0.1*) : ;; # local target — first guard is enough
  *)
    [ "${FORCE_PRODUCTION_RESTORE:-}" = "yes" ] || \
      fail "Target is not localhost. Set FORCE_PRODUCTION_RESTORE=yes after following the restore runbook (docs/runbooks/backup-restore.md)."
    ;;
esac

# --- Optional integrity check ------------------------------------------------
if [ -f "${DUMP_FILE}.sha256" ]; then
  info "Verifying SHA-256 checksum"
  ( cd "$(dirname "$DUMP_FILE")" && sha256sum --check "$(basename "$DUMP_FILE").sha256" )
fi

# --- Optional pre-restore snapshot ------------------------------------------
if [ "${PRE_RESTORE_SNAPSHOT:-0}" = "1" ]; then
  SNAPSHOT="$(dirname "$DUMP_FILE")/pre_restore_$(date -u +%Y%m%dT%H%M%SZ).dump"
  info "Taking pre-restore snapshot of target: $SNAPSHOT"
  pg_dump ${DATABASE_URL:+--dbname="$DATABASE_URL"} \
    --format=custom --compress=6 --no-owner --no-privileges --file="$SNAPSHOT"
fi

info "Restoring $DUMP_FILE into target database"
pg_restore ${DATABASE_URL:+--dbname="$DATABASE_URL"} \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$DUMP_FILE"

info "Restore complete. Verify application health before resuming traffic (see docs/runbooks/backup-restore.md)."
