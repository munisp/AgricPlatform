"""Sedona batch geo-analytics proof (wave FABRIC, batch only).

Reads the exported lakehouse parquet (dim_listings mart) from MinIO over
S3A and computes per-state listing counts, then demonstrates Sedona
spatial SQL by joining the counts to the Nigeria state->centroid table
(the same centroids the API uses for weather/geo lookups) and ranking
states by distance from a reference point (Abuja).

NOT wired into any request path: this is an offline batch job run on
demand via the `sedona` compose profile:

    docker compose -f infra/docker-compose.yml --profile lakehouse up -d
    # export marts first (POST /api/v1/analytics/export with LAKEHOUSE_* envs)
    docker compose -f infra/docker-compose.yml --profile sedona run --rm sedona

The parquet prefix matches the lakehouse exporter manifest contract
(docs/analytics-lakehouse.md). The exported marts carry `state` but no
lat/lon columns, so the spatial proof uses the centroid lookup — honest
batch analytics, not plot-level geometry.
"""

import os

from pyspark.sql import SparkSession

S3A_ENDPOINT = os.environ.get("S3A_ENDPOINT", "http://minio:9000")
S3A_ACCESS_KEY = os.environ.get("S3A_ACCESS_KEY", "lakehouse")
S3A_SECRET_KEY = os.environ.get("S3A_SECRET_KEY", "local-lakehouse-secret")
S3A_PREFIX = os.environ.get(
    "S3A_PREFIX", "s3a://agric-lakehouse/lakehouse/dim_listings"
)

# Subset of the Nigeria state centroid table (mirrors
# apps/api/src/modules/integrations/drivers/nigeria-states.ts) — enough to
# prove the spatial join without duplicating the whole file.
STATE_CENTROIDS = [
    ("Abuja (FCT)", 9.0765, 7.3986),
    ("Kano", 12.0022, 8.5920),
    ("Lagos", 6.5244, 3.3792),
    ("Kaduna", 10.5105, 7.4165),
    ("Oyo", 7.3775, 3.9470),
    ("Borno", 11.8311, 13.1510),
]
REFERENCE_POINT = ("Abuja (FCT)", 9.0765, 7.3986)


def main() -> None:
    spark = (
        SparkSession.builder.appName("agric-sedona-batch-geo")
        .config("spark.hadoop.fs.s3a.endpoint", S3A_ENDPOINT)
        .config("spark.hadoop.fs.s3a.access.key", S3A_ACCESS_KEY)
        .config("spark.hadoop.fs.s3a.secret.key", S3A_SECRET_KEY)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        .getOrCreate()
    )
    try:
        from sedona.spark import SedonaContext

        SedonaContext.create(spark)
    except Exception:  # noqa: BLE001 — older sedona.register path
        from sedona.register import SedonaRegistrator

        SedonaRegistrator.registerAll(spark)

    listings = spark.read.parquet(S3A_PREFIX)
    listings.createOrReplaceTempView("dim_listings")
    spark.createDataFrame(STATE_CENTROIDS, ["state", "lat", "lon"]).createOrReplaceTempView(
        "state_centroids"
    )

    result = spark.sql(
        f"""
        WITH per_state AS (
          SELECT state, COUNT(*) AS listings
          FROM dim_listings
          WHERE state IS NOT NULL
          GROUP BY state
        )
        SELECT p.state,
               p.listings,
               ROUND(
                 ST_DistanceSphere(
                   ST_Point(c.lon, c.lat),
                   ST_Point({REFERENCE_POINT[2]}, {REFERENCE_POINT[1]})
                 ) / 1000.0, 1
               ) AS km_from_abuja
        FROM per_state p
        JOIN state_centroids c ON p.state = c.state
        ORDER BY p.listings DESC
        """
    )
    result.show(truncate=False)
    spark.stop()


if __name__ == "__main__":
    main()
