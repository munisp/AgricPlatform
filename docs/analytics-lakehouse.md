# Analytics & Lakehouse — honest status and upgrade path

**Audience:** operators, data engineers, reviewers.
**Wave:** B (analytics foundation).
**Status of this document:** describes what EXISTS today and what does NOT.
Nothing in this file claims a lakehouse is deployed — because none is.

---

## 1. What exists now (real, deployed in this codebase)

The platform's analytical store today is a **star schema inside the same
PostgreSQL cluster** as the OLTP workload, fed by the transactional outbox.
There is no separate analytics infrastructure.

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

All exports are audit-logged. Web surface: `/admin/analytics` (summary stat
cards, daily metrics table, projection trigger, CSV downloads).

### 1.4 Health

`GET /api/v1/health/modules` includes an `analytics` probe: row counts per
star table plus the projector heartbeat (`lastProjectionAt`,
`processedTotal`). A never-projected store reports `lastProjectionAt: null`
(status stays `up` — the marts are queryable as long as Postgres is).

---

## 2. The honest gap statement

**What does NOT exist today:**

- **No object storage** (S3/GCS/MinIO) holding analytical data.
- **No columnar file format** (Parquet) — exports are CSV only.
- **No table format / catalog** (Apache Iceberg, Delta, Hudi).
- **No distributed query engine** (Trino, Presto, Spark SQL, DuckDB cluster).
- **No stream processor or CDC publisher** beyond the Postgres outbox table
  and its in-process sweeper (no Debezium, no Kafka).
- **No geospatial analytics stack** (Sedona/GeoMesa etc.).

Consequences, stated plainly: analytical queries share the OLTP Postgres
cluster (large scans compete with transactions); there is no petabyte-scale
path; historical fact evolution is limited to what the outbox retains; CSV
exports are file downloads, not a queryable external table.

The older `analytics_marts.*` KPI tables (migration 009, Wave P5c: member
KPIs, marketplace and learning dailies, snapshot-based) coexist with the new
star schema. They serve different consumers (segmentation/retention UI) and
are NOT replaced by this wave.

---

## 3. Upgrade path (when infra budget exists)

The design is deliberately staged so each step is optional and reversible:

1. **Now → CDC stream.** `events.outbox` is already the transactional-outbox
   source. Point **Debezium** (Postgres logical decoding, `pgoutput` plugin)
   at `events.outbox` to publish to Kafka/Redpanda with zero application
   changes. The star marts stay authoritative until the stream is proven.
2. **File handoff without Debezium (cheap alternative).** Schedule the
   existing CSV exports (`/analytics/export/*.csv`) and drop them into
   object storage. The CSV column contracts in §1.3 are the same columns a
   Parquet writer would use, so this path is not throwaway work.
3. **Object storage + Parquet.** Land CSV/CDC payloads as Parquet files
   partitioned by Lagos date (`placed_at_date=YYYY-MM-DD/…`), e.g. via a
   small loader or Spark/Flink job.
4. **Iceberg tables + catalog.** Register the Parquet datasets as Apache
   Iceberg tables (schema evolution, time travel, partition pruning). Table
   names map 1:1: `fact_orders`, `fact_payments`, `fact_livestock`,
   `dim_users`, `dim_listings`, `mart_daily_metrics`.
5. **Query engine.** Attach **Trino** (ad-hoc SQL, BI connectors) and/or
   **Spark** (heavy transforms, ML feature prep). Point them at the Iceberg
   catalog; dashboards move off OLTP Postgres.
6. **Geospatial (only when adopted).** If/when field-level geospatial
   analytics becomes a requirement, evaluate **Apache Sedona** (Spark) or
   the GeoLibre stack for geometry-aware queries over listing/farm
   locations. Not needed today: location analytics is state/LGA-level.

At every step the Postgres marts remain the fallback and the correctness
reference: mart contents are reproducible from `events.outbox`, so the
lakehouse can be rebuilt from source at any time.

---

## 4. Reference docker-compose overlay — **REFERENCE ONLY, NOT DEPLOYED**

> ⚠️ **This compose file is a sketch for the future lakehouse environment.
> It is NOT part of the deployed platform, is NOT started by any runbook or
> CI job, and no equivalent infrastructure exists today.** Do not read
> anything in this section as "running".

```yaml
# infra/lakehouse/docker-compose.lakehouse.yml  (REFERENCE ONLY — NOT DEPLOYED)
# Bring-up sketch for the §3 upgrade path, step 4–5. Requires: Kafka/Redpanda
# with Debezium already streaming events.outbox (step 1).
services:
  minio:                                   # S3-compatible object storage
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: lakehouse
      MINIO_ROOT_PASSWORD: change-me       # placeholder — secret manager in real envs
    ports: ["9000:9000", "9001:9001"]

  iceberg-rest:                            # Iceberg REST catalog over MinIO
    image: apache/iceberg-rest-fixture:latest
    environment:
      AWS_ACCESS_KEY_ID: lakehouse
      AWS_SECRET_ACCESS_KEY: change-me
      AWS_REGION: us-east-1
      CATALOG_WAREHOUSE: s3://warehouse/
      CATALOG_IO__IMPL: org.apache.iceberg.aws.s3.S3FileIO
      CATALOG_S3_ENDPOINT: http://minio:9000
    ports: ["8181:8181"]
    depends_on: [minio]

  trino:                                   # ad-hoc SQL over the Iceberg catalog
    image: trinodb/trino:latest
    volumes:
      - ./trino/catalog/iceberg.properties:/etc/trino/catalog/iceberg.properties:ro
    ports: ["8080:8080"]
    depends_on: [iceberg-rest]

  spark:                                   # batch transforms / Sedona later
    image: apache/spark:latest
    environment:
      SPARK_NO_DAEMONIZE: "true"
    depends_on: [iceberg-rest]
```

Loaders would map the §1.3 CSV contract (or Debezium payloads) onto Iceberg
tables named exactly like the Postgres marts, so queries written against
today's star schema keep working.
