# Analytics & Lakehouse — honest status and upgrade path

**Audience:** operators, data engineers, reviewers.
**Waves:** B (analytics foundation), lakehouse-export (object-storage export).
**Status of this document:** describes what EXISTS today and what does NOT.
Sections marked *implemented* describe code that ships in this repository and
is covered by tests. Sections marked *organizational choice* describe things
that are deliberately NOT built — no ambiguity either way.

---

## 1. What exists now (real, deployed in this codebase)

The platform's analytical store is a **star schema inside the same PostgreSQL
cluster** as the OLTP workload, fed by the transactional outbox — plus, since
the lakehouse-export wave, a **real export path from those marts to
S3-compatible object storage** (parquet part-files + a manifest contract).
There is still no managed lakehouse: no Iceberg/Delta catalog, no managed
query engine, no CDC pipeline.

### 1.1 Star-schema marts — `analytics` schema (migration `infra/postgres/019_analytics.sql`)

| Table | Grain / PK | Contents |
| --- | --- | --- |
| `analytics.dim_users` | `user_id` | roles, state (profile location), chapter (see note), registered_at |
| `analytics.dim_listings` | `listing_id` | kind, crop, state, seller |
| `analytics.fact_orders` | `order_id` | buyer/seller dims, channel + variant (from the Wave M `order_extensions` side table), quantity, `total_kobo`, current status, `status_history_count`, `placed_at`, `fulfilled_at` |
| `analytics.fact_payments` | `entry_id` | one row per double-entry ledger journal entry: debit/credit account arrays, `amount_kobo`, transfer type (`reference_type`), `posted_at` |
| `analytics.fact_livestock` | `animal_id` | animal registrations: species, breed, state, status, registered_at |
| `analytics.mart_daily_metrics` | `metric_date` | Lagos-calendar-day rollups: `orders_gmv_kobo`, `orders_count`, `active_farmers`, `escrow_held_kobo`, `livestock_registered` |
| `analytics.projection_state` | `consumer` | projector heartbeat (last run, last event, cumulative processed count) — powers the health probe |

**Known modelling gap (honest):** `dim_users.chapter_id` is populated only for
members who LEAD a chapter. The OLTP schema has no per-member chapter
affiliation table, so the column is mostly NULL until membership is modelled.

**Metric definitions (normative):**
- `orders_gmv_kobo` / `orders_count` — orders PLACED on the Lagos calendar
  day, excluding orders whose current status is `cancelled`.
- `active_farmers` — distinct `seller_id`s among those orders (marketplace
  sellers are the farmer/supplier side).
- `escrow_held_kobo` — escrow exposure at END of the Lagos day, reconstructed
  deterministically from escrow records (`held_at` before end-of-day and
  unresolved at end-of-day).
- Summary endpoint GMV uses the same "exclude cancelled" rule; its escrow
  exposure is the CURRENT total of open statuses
  (`held`, `releasing`, `refunding`, `disputed`).

### 1.2 Outbox→mart projector

`apps/api/src/modules/analytics/projector.service.ts`
(`AnalyticsProjectorService`):

- Reads `events.outbox` in `occurred_at` order and projects the
  analytics-relevant domain events:
  `identity.user.registered` / `identity.user.roles_updated`,
  `marketplace.listing.created` / `.updated`,
  `marketplace.order.placed` / `marketplace.order.status_changed`,
  `marketplace.escrow.held` / `marketplace.escrow.status_changed`,
  `finance.ledger.entry_posted`,
  `livestock.animal.registered` / `livestock.animal.status_changed`.
- **Cursor:** the consumer-side dedup ledger `events.processed_events`
  (consumer `analytics.projector`, via the existing `EventDedupService`).
  The outbox `published_at` flag CANNOT be the cursor: the event fan-out
  marks rows published immediately after in-process delivery, so
  "unpublished" only means "delivery stalled". The per-consumer ledger
  subsumes both cases.
- **Idempotency / catch-up safety** (three layers):
  1. dedup ledger skips already-processed events;
  2. every mart write is an UPSERT keyed by the natural key — replaying the
     full outbox history (e.g. after wiping `processed_events`) reproduces
     identical marts; `status_history_count` is written as an ABSOLUTE count
     of that order's status events, not an increment;
  3. `mart_daily_metrics` is RECOMPUTED from the fact tables + escrow
     records for every touched date — never incremented.
- **Trigger:** `POST /api/v1/analytics/project` (admin only, audit-logged).
  There is deliberately **no in-process timer**: an external scheduler
  (cron, systemd timer, k8s CronJob) invokes the endpoint. Suggested
  schedule: every 5–15 minutes, plus ad-hoc backfill runs.

### 1.3 Read API and admin surface

| Endpoint | Role | Purpose |
| --- | --- | --- |
| `GET /api/v1/analytics/metrics/daily?from&to` | admin, regulator | `mart_daily_metrics` rows over an inclusive date range |
| `GET /api/v1/analytics/metrics/summary` | admin, regulator | GMV, orders, current escrow exposure, livestock registered, dimension sizes, projector heartbeat |
| `POST /api/v1/analytics/project` | admin | one projection pass (external scheduler calls this) |
| `GET /api/v1/analytics/export/fact_orders.csv?from&to` | admin, regulator | CSV of `fact_orders`, columns 1:1 with migration 019 |
| `GET /api/v1/analytics/export/fact_payments.csv?from&to` | admin, regulator | CSV of `fact_payments` (account arrays `;`-joined) |
| `POST /api/v1/analytics/export` | admin | **lakehouse export run** — see §2; 503 when disabled |
| `GET /api/v1/analytics/export/last` | admin | last export status: `{ enabled, manifest }` — see §2.5 |

All exports are audit-logged. Web surface: `/admin/analytics` (summary stat
cards, daily metrics table, projection trigger, CSV downloads, and the
lakehouse export card with an honest disabled state).

### 1.4 Health

`GET /api/v1/health/modules` includes an `analytics` probe: row counts per
star table plus the projector heartbeat (`lastProjectionAt`,
`processedTotal`). A never-projected store reports `lastProjectionAt: null`
(status stays `up` — the marts are queryable as long as Postgres is).

---

## 2. Lakehouse export path — IMPLEMENTED

`apps/api/src/modules/analytics/exporter/` (`LakehouseExporterService`).

### 2.1 What it does

One export run serialises **all six mart tables** to parquet part-files
(parquetjs-lite) on S3-compatible object storage, in
hive-style partitions:

```
s3://{bucket}/lakehouse/{table}/dt=YYYY-MM-DD/part-{runId}-00000.parquet
s3://{bucket}/lakehouse/_manifests/dt=YYYY-MM-DD/{runId}.json
s3://{bucket}/lakehouse/_manifest.json          ← latest-run pointer
```

- `dt` is the **Africa/Lagos calendar day** of the run (same calendar the
  marts use). One run rewrites the whole day partition for every table —
  the marts are small enough that full-snapshot-per-day is the honest,
  correct unit; there is no incremental append logic to get wrong.
- Column names in the parquet files are the snake_case mart columns (1:1
  with migration 019 and the CSV contract). Timestamp columns are ISO-8601
  UTC **strings** (UTF8), the same representation the CSV exports use.
  Array columns (`roles`, `debit_accounts`, `credit_accounts`) are native
  parquet REPEATED UTF8 fields.

### 2.2 The manifest contract

`_manifest.json` (and each per-run manifest under `_manifests/`) contains:
`runId`, `runDate`, `bucket`, `prefix`, `format: "parquet"`,
`startedAt`/`finishedAt`, and per table: row count plus the part-file list
with `bytes` and a **SHA-256 hex digest per file**, plus `totalRows` /
`totalBytes`. There is no table-format catalog — these manifests are the
contract a loader or query engine integrates against.

### 2.3 Idempotent re-runs ("atomically-ish")

Re-running the same day **replaces** that day's partition:

1. new part files are written (run-scoped names: `part-{runId}-…`),
2. the per-run manifest is written, then the `_manifest.json` pointer is
   flipped — the pointer flip is the commit point,
3. only then are part files from superseded runs of the same day deleted.

A reader that follows `_manifest.json` therefore never sees a half-written
partition. Object storage gives no multi-key transactions, so a crash
between steps can leave orphaned part files from the interrupted run;
those are overwritten-and-cleaned by the next run of the same day. Per-run
manifests under `_manifests/` are kept as an audit trail.

### 2.4 Configuration and fail-closed behaviour

Environment variables (documented in `apps/api/.env.example`; credentials
from env ONLY, never logged, never in manifests):

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAKEHOUSE_ENABLED` | `false` | master switch; when not `true` the exporter is cleanly disabled |
| `LAKEHOUSE_BUCKET` | — | target bucket; required when enabled |
| `LAKEHOUSE_S3_ENDPOINT` | — | MinIO-compatible endpoint (empty = AWS S3 default) |
| `LAKEHOUSE_S3_REGION` | `us-east-1` | SDK region (MinIO ignores it) |
| `LAKEHOUSE_S3_ACCESS_KEY` / `LAKEHOUSE_S3_SECRET_KEY` | — | credentials, env only |

**Fail-closed:** with `LAKEHOUSE_ENABLED=true` in production
(`NODE_ENV=production`), a missing bucket or credentials aborts Nest module
init — the API refuses to start rather than silently dropping the export
path. Outside production the same misconfiguration degrades to disabled
with a startup warning. When disabled, `POST /api/v1/analytics/export`
returns **503** with the reason and `GET /api/v1/analytics/export/last`
returns `{ enabled: false, reason, manifest: null }`.

### 2.5 Last-manifest persistence (deliberately simple)

`GET /api/v1/analytics/export/last` serves the latest manifest from an
in-memory cache, falling back to reading `_manifest.json` from object
storage. **No new database table exists** (this wave has a zero migration
budget), and none is needed: object storage is the source of truth, so the
status endpoint survives API restarts. `manifest` is `null` before the
first run — an honest empty state, not an error.

### 2.6 Running it locally (MinIO)

```bash
# 1. Start Postgres etc. plus the lakehouse profile (MinIO + bucket bootstrap):
docker compose -f infra/docker-compose.yml \
  --profile lakehouse up -d postgres redis keycloak meilisearch minio minio-bootstrap

# 2. Run the API with:
LAKEHOUSE_ENABLED=true \
LAKEHOUSE_BUCKET=agric-lakehouse \
LAKEHOUSE_S3_ENDPOINT=http://localhost:9000 \
LAKEHOUSE_S3_ACCESS_KEY=lakehouse \
LAKEHOUSE_S3_SECRET_KEY=local-lakehouse-secret   # LOCAL-ONLY dev credentials

# 3. Project the marts, then export:
curl -X POST .../api/v1/analytics/project   # admin
curl -X POST .../api/v1/analytics/export    # admin → returns the manifest
```

The MinIO console is at http://localhost:9001 (same local-only credentials).

### 2.7 Querying the export — OPTIONAL local convenience (Trino)

`infra/docker-compose.yml` also carries a profile-gated `trino` service
(`--profile lakehouse-query`) with `infra/trino/catalog/lakehouse.properties`
(hive connector, file metastore on a local volume, native-S3 against MinIO).
This is a **local ad-hoc SQL convenience, not a managed lakehouse**: there
is no shared catalog, so each table must be registered by hand, e.g.:

```sql
CREATE TABLE lakehouse.fact_orders (
  order_id varchar, listing_id varchar, buyer_id varchar, seller_id varchar,
  channel varchar, variant_id varchar, quantity integer, total_kobo bigint,
  status varchar, status_history_count integer, escrow_required boolean,
  placed_at varchar, fulfilled_at varchar
) WITH (
  external_location = 's3://agric-lakehouse/lakehouse/fact_orders/',
  format = 'PARQUET',
  partitioned_by = ARRAY['dt']
);
-- then, per exported day:
CALL lakehouse.system.register_partition('fact_orders', 'dt', '2026-08-06',
  's3://agric-lakehouse/lakehouse/fact_orders/dt=2026-08-06/');
```

Zero-infra alternative: **DuckDB** reads the parquet prefix directly
(`read_parquet('s3://agric-lakehouse/lakehouse/fact_orders/*/*.parquet',
hive_partitioning=true)`). For **Athena**, point a Glue table at the same
`s3://…/lakehouse/{table}/` prefix with `dt` as the partition key and run
`MSCK REPAIR TABLE` after each export; for **BigQuery**, an external table
over the GCS-equivalent prefix with hive partitioning. All of these consume
the same layout — the exporter does not depend on any of them.

---

## 3. What still does NOT exist (organizational choices)

Stated plainly, so nobody reads the §2 implementation as more than it is:

- **No table-format catalog** (Apache Iceberg, Delta, Hudi). The manifest
  JSON files are the integration contract; schema evolution, time travel
  and partition pruning across engines would need a real catalog.
- **No managed/shared query engine.** The compose Trino is local-only with
  a private file metastore; Athena/BigQuery/DuckDB are point-it-yourself.
- **No CDC stream** (Debezium/Kafka). The outbox table + projector remain
  the only replication mechanism; exports are per-day snapshots, not a
  streaming changelog.
- **No retention tiers or lifecycle policies** on the export bucket —
  partitions accumulate until an operator configures bucket lifecycle rules
  (an infra-policy decision, not application code).
- **No incremental/intraday export.** The unit is one full mart snapshot
  per Lagos day; sub-day freshness means re-running the export.
- **No geospatial analytics stack** (Sedona/GeoMesa etc.).

Consequences, stated plainly: analytical queries still share the OLTP
Postgres cluster (the export moves *copies* out; the marts remain the
serving store); the object-storage copy is only as fresh as the last
export run; there is no petabyte-scale path until a catalog + query engine
are adopted.

The older `analytics_marts.*` KPI tables (migration 009, Wave P5c: member
KPIs, marketplace and learning dailies, snapshot-based) coexist with the
star schema. They serve different consumers (segmentation/retention UI) and
are NOT replaced by either wave.

---

## 4. Upgrade path (when infra budget exists)

Each step is optional and reversible, and steps 1–2 now build on a real
export instead of a sketch:

1. **Adopt a table format on the existing prefix.** Register the exported
   parquet datasets as Apache Iceberg tables (e.g. via the Iceberg REST
   catalog + the same MinIO bucket). Table names map 1:1: `fact_orders`,
   `fact_payments`, `fact_livestock`, `dim_users`, `dim_listings`,
   `mart_daily_metrics`. The exporter's manifest SHA-256s are the
   verification contract for the migration.
2. **Shared catalog + query engine.** Attach **Trino** (ad-hoc SQL, BI
   connectors) and/or **Spark** (heavy transforms, ML feature prep) to the
   shared Iceberg catalog; dashboards move off OLTP Postgres.
3. **CDC stream (only if snapshot latency hurts).** `events.outbox` is
   already the transactional-outbox source. Point **Debezium** (Postgres
   logical decoding, `pgoutput` plugin) at it to publish to Kafka/Redpanda
   with zero application changes. The Postgres marts stay authoritative
   until the stream is proven.
4. **Retention/lifecycle policy.** Bucket lifecycle rules for partition
   expiry once the org decides its retention tiers.
5. **Geospatial (only when adopted).** If/when field-level geospatial
   analytics becomes a requirement, evaluate **Apache Sedona** (Spark) or
   the GeoLibre stack. Not needed today: location analytics is
   state/LGA-level.

At every step the Postgres marts remain the fallback and the correctness
reference: mart contents are reproducible from `events.outbox`, so the
lakehouse can be rebuilt from source at any time.
