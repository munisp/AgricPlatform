-- 068_chapter_map_snapshots.sql — Innovation 10 (Stage 27): Chapter Map
-- geospatial operations view. Spec: stage27 innovations-spec.md #10
-- (migration renumbered 062 -> 068; 062 is reserved for WP-G18).
--
-- Recomputable per-chapter H3 res-7 metric snapshots backing
-- GET /api/chapters/:id/map. This table is a CACHE: the source of truth
-- stays in the domain tables (chapters.chapter_members, geo.h3_index,
-- farms.plots, input_vouchers.redemptions, mechanization.equipment_listings,
-- marketplace.escrow_records) and POST /api/chapters/:id/map/recompute
-- rebuilds rows idempotently via the composite-PK upsert.
--
-- Privacy doctrine (hard invariant): rows are k-anonymised AGGREGATES ONLY
-- — no farmer identifiers, no raw coordinates. The service layer suppresses
-- every cell whose member_count is below the k-anonymity floor (5) from API
-- responses, and a pg contract test scans this column set against a PII
-- denylist (test/pg/chapter-map.pg.spec.ts).
--
-- Idempotent per repo policy (IF NOT EXISTS). No triggers, per repo
-- convention. No PostGIS: cells are h3-js strings computed in the app layer.

BEGIN;

CREATE SCHEMA IF NOT EXISTS geo_intel;

CREATE TABLE IF NOT EXISTS geo_intel.chapter_map_snapshots (
    chapter_id      text NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    h3_res7         text NOT NULL,
    metric          text NOT NULL
                    CHECK (metric IN (
                        'member_count',
                        'plot_count',
                        'plot_area_hectares',
                        'voucher_redemptions',
                        'mechanization_coverage',
                        'pending_escrow_kobo'
                    )),
    value_numeric   numeric NOT NULL CHECK (value_numeric >= 0),
    computed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chapter_id, h3_res7, metric)
);

-- Dashboard reads filter by chapter (and usually one metric) and join on the
-- cell; the PK already covers (chapter_id, h3_res7, metric) lookups, so only
-- the per-chapter recency scan gets a supporting index.
CREATE INDEX IF NOT EXISTS chapter_map_snapshots_computed_idx
    ON geo_intel.chapter_map_snapshots (chapter_id, computed_at);

COMMIT;
