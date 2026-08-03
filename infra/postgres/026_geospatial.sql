-- 026_geospatial.sql — geospatial pack (Wave GEO). H3 cell index for every
-- geo-located entity plus administrative/custom boundaries, all WITHOUT
-- PostGIS: CI runs postgres:16-alpine (no postgis extension), so geo data
-- stays lat/long columns + JSONB and spatial indexing is computed in the
-- application layer via h3-js (see apps/api/src/modules/geo). PostGIS is an
-- optional future ops upgrade — docs/geospatial.md documents the path. All
-- statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS geo;

-- H3 index entries, one row per geo-located entity. Cells are precomputed at
-- the three platform resolutions (5 ≈ state/LGA rollups, 7 ≈ ward/neighbour-
-- hood queries, 9 ≈ plot-level precision) by the geo module on entity
-- create/update and via POST /geo/reindex. Composite PK (entity, entity_id)
-- keeps the index entity-agnostic (farm_plot, profile, …). `long` is an
-- unreserved keyword in PostgreSQL and needs no quoting.
CREATE TABLE IF NOT EXISTS geo.h3_index (
    entity      text NOT NULL,
    entity_id   text NOT NULL,
    h3_res5     text NOT NULL,
    h3_res7     text NOT NULL,
    h3_res9     text NOT NULL,
    lat         double precision NOT NULL,
    long        double precision NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity, entity_id)
);

-- Ring/neighbourhood queries filter on the resolution column then load the
-- entity by id; both hot resolutions are indexed.
CREATE INDEX IF NOT EXISTS h3_index_res5_idx
    ON geo.h3_index (h3_res5);
CREATE INDEX IF NOT EXISTS h3_index_res7_idx
    ON geo.h3_index (h3_res7);

-- Named boundaries (Nigerian states/LGAs/wards or operator-defined custom
-- zones). boundary_geojson holds the raw GeoJSON Polygon/MultiPolygon
-- geometry as JSONB; point-in-boundary checks run in the application layer
-- (ray casting, apps/api/src/modules/geo) — no PostGIS. parent_id links the
-- state → lga → ward hierarchy; NULL for top-level entries. Nothing is
-- seeded: boundaries are managed through POST /geo/boundaries (admin).
CREATE TABLE IF NOT EXISTS geo.geo_boundaries (
    id                text PRIMARY KEY,
    kind              text NOT NULL
                      CHECK (kind IN ('state','lga','ward','custom')),
    name              text NOT NULL,
    parent_id         text REFERENCES geo.geo_boundaries(id),
    boundary_geojson  jsonb NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_boundaries_kind_idx
    ON geo.geo_boundaries (kind);
CREATE INDEX IF NOT EXISTS geo_boundaries_parent_idx
    ON geo.geo_boundaries (parent_id);

COMMIT;
