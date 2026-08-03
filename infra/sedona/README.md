# Apache Sedona — batch geo-analytics (wave FABRIC)

**Scope honesty: this is offline batch analytics on exported parquet. It is
NOT wired into any request path, does not run by default, and has never been
executed against a live cluster in CI.**

## What it does

`batch-geo.py` is a PySpark + Apache Sedona job that:

1. Reads the `dim_listings` mart parquet the analytics lakehouse exporter
   writes to MinIO (`s3a://agric-lakehouse/lakehouse/dim_listings`, see
   `docs/analytics-lakehouse.md`).
2. Aggregates listing counts per Nigeria state.
3. Proves Sedona spatial SQL by joining the counts to the Nigeria
   state→centroid table (mirroring
   `apps/api/src/modules/integrations/drivers/nigeria-states.ts`) and
   ranking states by `ST_DistanceSphere` from Abuja.

The exported marts carry `state` but no lat/lon columns, so the spatial
proof uses the centroid lookup — there is no plot-level geometry in the
lakehouse today.

## Run it (on demand)

```bash
# 1. Start the lakehouse stack and produce an export first:
docker compose -f infra/docker-compose.yml --profile lakehouse up -d
#    (run the API with LAKEHOUSE_ENABLED=true + LAKEHOUSE_S3_* envs, then
#     POST /api/v1/analytics/export)
# 2. Run the batch job once:
docker compose -f infra/docker-compose.yml --profile sedona run --rm sedona
```

Environment overrides: `S3A_ENDPOINT`, `S3A_ACCESS_KEY`, `S3A_SECRET_KEY`,
`S3A_PREFIX` (defaults match the local MinIO dev credentials — LOCAL ONLY).

## What is verified vs not

- **Verified:** compose file YAML validity; the job script parses
  (Python syntax).
- **NOT verified:** no Sedona/Spark cluster run, no S3A read against a
  populated bucket, no correctness check of the spatial output. The
  `apache/sedona` image tag moves — pin a version before any real use.
