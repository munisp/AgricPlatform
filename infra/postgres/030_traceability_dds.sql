-- 030_traceability_dds.sql — EUDR traceability passport (wave-eudr):
-- shipments and their lot composition. A shipment bundles one or more
-- commodity lots into the unit an exporter issues a due-diligence statement
-- (DDS) against. Shipments are mutable only in status
-- ('created' → 'exported'); their lot composition is fixed at creation so a
-- DDS always refers to the same evidence set. Idempotent (IF NOT EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS traceability.shipments (
    id           text PRIMARY KEY,
    creator_id   text NOT NULL,
    creator_kind text NOT NULL DEFAULT 'user'
                 CHECK (creator_kind IN ('user','partner')),
    reference    text,
    status       text NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','exported')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipments_creator_idx
    ON traceability.shipments (creator_id);
CREATE INDEX IF NOT EXISTS shipments_status_idx
    ON traceability.shipments (status);

CREATE TABLE IF NOT EXISTS traceability.shipment_lots (
    id          text PRIMARY KEY,
    shipment_id text NOT NULL REFERENCES traceability.shipments(id) ON DELETE CASCADE,
    lot_id      text NOT NULL REFERENCES traceability.commodity_lots(id),
    position    integer NOT NULL DEFAULT 0,
    UNIQUE (shipment_id, lot_id)
);

CREATE INDEX IF NOT EXISTS shipment_lots_shipment_idx
    ON traceability.shipment_lots (shipment_id);
CREATE INDEX IF NOT EXISTS shipment_lots_lot_idx
    ON traceability.shipment_lots (lot_id);

COMMIT;
