-- 022_farms.sql — farms & crop-production wave. Farm plots (lat/long
-- centroid + GeoJSON boundary kept as JSONB — no PostGIS dependency),
-- crop plantings, harvest records and per-plot expenses. Offline-sync
-- metadata (version, client_id) mirrors the farmer-data-collection source
-- domain so mobile captures merge cleanly. All statements are idempotent
-- (IF NOT EXISTS) so the migration is safe to re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS farms;

-- Registered farm plots. boundary_geojson holds the raw GeoJSON geometry
-- (Polygon/MultiPolygon) captured by walking the perimeter; validated
-- structurally in the service layer. version/client_id support
-- offline-first sync merges.
CREATE TABLE IF NOT EXISTS farms.farm_plots (
    id                text PRIMARY KEY,
    owner_user_id     text NOT NULL REFERENCES identity.users(id),
    name              text NOT NULL,
    state             text NOT NULL,
    lga               text NOT NULL,
    centroid_lat      double precision NOT NULL,
    centroid_long     double precision NOT NULL,
    boundary_geojson  jsonb,
    size_hectares     double precision NOT NULL CHECK (size_hectares > 0),
    soil_type         text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    version           integer NOT NULL DEFAULT 1,
    client_id         text
);

CREATE INDEX IF NOT EXISTS farm_plots_owner_idx
    ON farms.farm_plots (owner_user_id);

-- Crop plantings nested under a plot. Status lifecycle: growing →
-- harvested | failed (both terminal; enforced by the service layer).
CREATE TABLE IF NOT EXISTS farms.crop_plantings (
    id                  text PRIMARY KEY,
    plot_id             text NOT NULL REFERENCES farms.farm_plots(id) ON DELETE CASCADE,
    crop                text NOT NULL,
    variety             text,
    season              text NOT NULL,
    planted_at          timestamptz NOT NULL,
    expected_harvest_at timestamptz,
    status              text NOT NULL DEFAULT 'growing'
                        CHECK (status IN ('growing','harvested','failed')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    version             integer NOT NULL DEFAULT 1,
    client_id           text
);

CREATE INDEX IF NOT EXISTS crop_plantings_plot_idx
    ON farms.crop_plantings (plot_id);
CREATE INDEX IF NOT EXISTS crop_plantings_status_idx
    ON farms.crop_plantings (status);

-- Harvest records nested under a planting (a planting can be harvested in
-- several picks; quantity uses the declared unit per record).
CREATE TABLE IF NOT EXISTS farms.harvest_records (
    id            text PRIMARY KEY,
    planting_id   text NOT NULL REFERENCES farms.crop_plantings(id) ON DELETE CASCADE,
    harvested_at  timestamptz NOT NULL,
    quantity      double precision NOT NULL CHECK (quantity >= 0),
    unit          text NOT NULL
                  CHECK (unit IN ('kg','tonnes','bags','crates','bunches')),
    quality_grade text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS harvest_records_planting_idx
    ON farms.harvest_records (planting_id);

-- Per-plot expenses. Money is stored as integer kobo — never a float.
CREATE TABLE IF NOT EXISTS farms.farm_expenses (
    id          text PRIMARY KEY,
    plot_id     text NOT NULL REFERENCES farms.farm_plots(id) ON DELETE CASCADE,
    category    text NOT NULL
                CHECK (category IN ('seeds','fertilizer','pesticides','labour','equipment','irrigation','transport','other')),
    amount_kobo bigint NOT NULL CHECK (amount_kobo >= 0),
    incurred_at timestamptz NOT NULL,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS farm_expenses_plot_idx
    ON farms.farm_expenses (plot_id);

COMMIT;
