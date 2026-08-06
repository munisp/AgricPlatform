-- 029_traceability.sql — EUDR traceability passport (wave-eudr). Commodity
-- lots, the append-only custody-event hash chain and immutable plot-geometry
-- snapshots that anchor lots to production plots (EUDR geolocation evidence).
--
-- Append-only doctrine: custody_events and lot_plot_links are never UPDATEd
-- or DELETEd by application code (the repositories expose no update/remove
-- for them). DB-level immutability would require triggers, which this
-- platform intentionally avoids (portable plain-SQL migrations, no hidden
-- server-side behaviour — see docs/sync-protocol.md and prior waves). The
-- integrity mechanism is therefore app-level append-only + the sha256 hash
-- chain over canonical event JSON: editing a stored event breaks its
-- recomputed hash, and re-forging the hash breaks every descendant link —
-- either way GET /traceability/.../dds/verify surfaces it per event. All statements are
-- idempotent (IF NOT EXISTS) so the migration is safe to re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS traceability;

-- A marketable quantity of one commodity from one harvest window, owned by
-- the farmer (or cooperative) that created it. parent_lot_ids records
-- genealogy: AGGREGATED lots list every parent; SPLIT lots list the single
-- parent they were carved from.
CREATE TABLE IF NOT EXISTS traceability.commodity_lots (
    id                   text PRIMARY KEY,
    owner_user_id        text NOT NULL REFERENCES identity.users(id),
    crop                 text NOT NULL,
    variety              text,
    harvest_window_start timestamptz NOT NULL,
    harvest_window_end   timestamptz NOT NULL,
    quantity             double precision NOT NULL CHECK (quantity > 0),
    unit                 text NOT NULL,
    status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','aggregated','split','shipped','received')),
    parent_lot_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commodity_lots_owner_idx
    ON traceability.commodity_lots (owner_user_id);
CREATE INDEX IF NOT EXISTS commodity_lots_crop_idx
    ON traceability.commodity_lots (crop);
CREATE INDEX IF NOT EXISTS commodity_lots_status_idx
    ON traceability.commodity_lots (status);

-- Append-only custody chain. seq is the per-lot monotonic position; the
-- hash chain is sha256 over the canonical JSON of the event payload +
-- prev_event_hash (genesis prev = 64 zero hex chars). event_hash is UNIQUE
-- so a rewritten history collides on insert. NO updated_at column: rows are
-- never mutated.
CREATE TABLE IF NOT EXISTS traceability.custody_events (
    id              text PRIMARY KEY,
    lot_id          text NOT NULL REFERENCES traceability.commodity_lots(id),
    seq             integer NOT NULL,
    type            text NOT NULL
                    CHECK (type IN ('CREATED','AGGREGATED','SPLIT','TRANSFORMED','SHIPPED','RECEIVED')),
    actor_id        text NOT NULL,
    occurred_at     timestamptz NOT NULL,
    latitude        double precision NOT NULL,
    longitude       double precision NOT NULL,
    h3_cell         text,
    quantity        double precision,
    unit            text,
    parent_lot_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    note            text,
    prev_event_hash text NOT NULL,
    event_hash      text NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lot_id, seq)
);

CREATE INDEX IF NOT EXISTS custody_events_lot_idx
    ON traceability.custody_events (lot_id);
CREATE INDEX IF NOT EXISTS custody_events_type_idx
    ON traceability.custody_events (type);

-- Immutable geolocation evidence: a COPY of the plot's coordinates (and
-- optional H3 cell) taken when the plot is linked to the lot. EUDR Annex II
-- requires geolocations of production plots as they were at due-diligence
-- time — a live FK to farms.farm_plots would let later plot edits rewrite
-- historical evidence, so the snapshot is deliberately denormalised. No
-- UPDATE path exists in application code.
CREATE TABLE IF NOT EXISTS traceability.lot_plot_links (
    id                 text PRIMARY KEY,
    lot_id             text NOT NULL REFERENCES traceability.commodity_lots(id),
    plot_id            text NOT NULL,
    plot_owner_user_id text NOT NULL,
    plot_name          text NOT NULL,
    latitude           double precision NOT NULL,
    longitude          double precision NOT NULL,
    h3_cell            text,
    linked_at          timestamptz NOT NULL DEFAULT now(),
    linked_by          text NOT NULL
);

CREATE INDEX IF NOT EXISTS lot_plot_links_lot_idx
    ON traceability.lot_plot_links (lot_id);
CREATE INDEX IF NOT EXISTS lot_plot_links_plot_idx
    ON traceability.lot_plot_links (plot_id);

COMMIT;
