# Runbook: PostgreSQL Backup and Restore

Scope: the AgricPlatform PostgreSQL database (managed service in staging/
production, containerised locally). Assets: `scripts/backup-postgres.sh`,
`scripts/restore-postgres.sh`, `infra/k8s/backup-cronjob.yaml`.

Targets (from `infra/environments.md`): RPO ≤ 15 minutes via managed PITR;
these logical dumps are the portable second tier. RTO ≤ 4 hours.

## 1. Backup schedule

| Tier | Mechanism | Status |
| --- | --- | --- |
| Managed PITR | Cloud provider continuous WAL archiving | EXTERNAL — enable when the managed database is provisioned |
| Nightly logical dump | `infra/k8s/backup-cronjob.yaml` (02:00 UTC) or a scheduled run of `scripts/backup-postgres.sh` | Ready — apply once a cluster exists |
| Off-site copy | `S3_BUCKET` upload from the backup script | EXTERNAL — requires a provisioned bucket and credentials |

## 2. Taking a manual backup

```bash
DATABASE_URL='postgresql://user:pass@host:5432/agric_platform' \
BACKUP_DIR=./backups \
./scripts/backup-postgres.sh
```

The script writes `agric_platform_<UTC timestamp>.dump` (pg_dump custom
format, compressed) plus a `.sha256` checksum, prunes local files older than
`RETENTION_DAYS` (default 14), and uploads to `S3_BUCKET` when that variable
is set.

## 3. Verifying backups (monthly integrity check)

Per the security-compliance acceptance evidence, restore integrity must be
tested monthly:

```bash
# Restore the latest dump into a throwaway local database
docker compose -f infra/docker-compose.yml up -d postgres
DATABASE_URL='postgresql://agric:agric@localhost:5432/agric_platform_restore_test' \
CONFIRM_RESTORE=yes \
./scripts/restore-postgres.sh backups/agric_platform_<timestamp>.dump
```

Record the date, dump timestamp, row-count spot checks, and duration in the
ops log; this is the RTO evidence for the production gate.

## 4. Restore procedure (incident)

1. **Declare** the incident and stop writers: scale the API down
   (`kubectl -n agric-platform scale deploy/api --replicas=0`) or enable
   maintenance mode so no new writes land mid-restore.
2. **Choose the recovery point.** Prefer managed PITR for the smallest data
   loss; use the latest verified logical dump otherwise.
3. **Snapshot the damaged database first** (`PRE_RESTORE_SNAPSHOT=1`) unless
   the target is known-empty — forensic and rollback value.
4. **Restore:**

   ```bash
   DATABASE_URL='postgresql://user:pass@host:5432/agric_platform' \
   CONFIRM_RESTORE=yes FORCE_PRODUCTION_RESTORE=yes PRE_RESTORE_SNAPSHOT=1 \
   ./scripts/restore-postgres.sh backups/agric_platform_<timestamp>.dump
   ```

5. **Verify:** row counts on high-value tables (`admin.audit_events`,
   finance/ledger tables, user/profile tables), then run the API migrations
   if the dump predates the current schema.
6. **Resume traffic:** scale the API back up, watch `/api/v1/health/ready`,
   and confirm audit-event and outbox consumers are flowing.
7. **Post-incident:** record actual RTO/RPO achieved and file follow-ups.

## 5. DR ordering

Full disaster recovery follows the order in `infra/environments.md`:
database → Redis (cold start acceptable) → Keycloak realm re-import and
secret re-issue → stateless tiers from the last known-good image tag → DNS
cutover.
