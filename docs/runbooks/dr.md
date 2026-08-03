# Disaster recovery runbook (Wave OPS)

Scope: PostgreSQL backup schedule, restore drills, and recovery targets.
The tooling is `scripts/backup-db.mjs` and `scripts/verify-restore.mjs`
(existing `scripts/backup-postgres.sh`/`restore-postgres.sh` remain as the
shell fallback; `infra/k8s/backup-cronjob.yaml` is the cluster example).

> **Honesty note.** The RTO/RPO values below are TARGETS and design
> RECOMMENDATIONS. No restore has been performed against a production
> database from this repository, and no uptime evidence is claimed. The
> restore drill (`verify:restore`) is the tool that turns these targets
> into evidence — run it and record results before go-live (see
> [go-live-checklist.md](go-live-checklist.md)).

## Targets (recommendations, not evidence)

| Target | Recommendation | Rationale |
| --- | --- | --- |
| RPO (max data loss) | ≤ 24 h with nightly dumps; ≤ 1 h once WAL archiving or PITR is provisioned | Nightly `pg_dump` is the current tooling; WAL shipping is infrastructure work outside this repo. |
| RTO (max restore time) | ≤ 4 h | Measured by the restore drill below on a production-sized dataset. |
| Backup retention | 14 days local (default `RETENTION_DAYS`), 30+ days off-site (bucket lifecycle) | Covers slow-burn data corruption discovered late. |
| Drill cadence | Monthly, and before every go-live | A backup that has never been restored is a hope, not a backup. |

## Backup schedule

Nightly at 02:00 UTC (see `infra/k8s/backup-cronjob.yaml` for the CronJob
shape). The supported runner going forward is the Node script:

```sh
DATABASE_URL=postgres://… \
BACKUP_DIR=/backups \
RETENTION_DAYS=14 \
S3_BUCKET=s3://agric-dr-backups/nightly \      # optional off-site copy
npm run backup:db
```

Each run produces three files:

```
agric_platform_<UTC>.dump            # pg_dump custom format, compressed
agric_platform_<UTC>.dump.sha256     # integrity checksum (also printed to stdout)
agric_platform_<UTC>.manifest.json   # exact per-table row counts at backup time
```

The script exits non-zero on ANY failed step (dump, checksum, or a
requested S3 upload), so the scheduler alerts instead of silently missing
a night. Credentials are never printed.

Monitoring recommendation: alert when no new `agric_platform_*.dump` has
appeared in 26 h (cron dead-man switch).

## Restore drill (verify:restore)

Run monthly and before go-live. Needs an admin connection to a Postgres
server where a scratch database may be created — **never** run this
against the production database itself; the drill creates and drops
`SCRATCH_DATABASE` (default `agric_restore_drill`).

```sh
DATABASE_URL=postgres://admin@db-host/postgres \
BACKUP_DIR=/backups \
npm run verify:restore
```

What it does, in order:

1. Picks the latest backup manifest in `BACKUP_DIR` (or `BACKUP_FILE`).
2. Recomputes the dump's SHA-256 and compares it to the manifest.
3. Drops + recreates the scratch database, `pg_restore`s into it.
4. For every table in the manifest, compares `count(*)` in the restored
   database against the count recorded at backup time.
5. Drops the scratch database (even on failure; `KEEP_SCRATCH=1` keeps it
   for debugging).

Exit 0 = the backup is restorable and complete. Every check prints
PASS/FAIL/SKIP. A SKIP for `table-counts` means the backup was taken
without `psql` available — re-run `backup:db` from a host that has both
`pg_dump` and `psql` so future drills validate row counts.

**Recording drill results**: append the date, backup timestamp, duration
(wall-clock of step 3), and result to the DR log (ops wiki). The measured
restore duration is the empirical input for the RTO target above.

## Full disaster recovery procedure

1. Provision a fresh PostgreSQL instance (same major version, 16).
2. Retrieve the latest good backup (local PVC first, S3 off-site copy if
   the cluster is lost). Verify the checksum before trusting the file:
   `sha256sum -c agric_platform_<TS>.dump.sha256`.
3. Restore:
   `pg_restore --dbname="$DATABASE_URL" --no-owner --no-privileges --clean --if-exists agric_platform_<TS>.dump`
   (or use `verify:restore` pointed at a scratch DB first to validate the
   chosen backup before committing to it).
4. Re-run migrations to cover any gap between the backup and the repo:
   `npm run migrate -w @agric-platform/api` (idempotent).
5. Redeploy the API, then `npm run verify:deployment`.
6. Validate the audit hash chain (`GET /api/v1/admin/audit-log/verify` as
   admin) to confirm the restored audit trail is intact.
7. Announce recovery per [incident-response.md](incident-response.md).

## Known gaps (honest)

- No WAL archiving / point-in-time recovery yet — nightly dumps only.
- The k8s CronJob example (`infra/k8s/backup-cronjob.yaml`) still embeds
  the shell one-liner; migrating it to `backup:db` requires an image with
  Node + the repo scripts (the postgres:16-alpine image lacks both).
- Off-site upload depends on the `aws` CLI being present on the runner.
- Redis holds cache/rate-limit state only — it is NOT backed up; loss
  means cold caches and reset rate-limit windows, not data loss.
