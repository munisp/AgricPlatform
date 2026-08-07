-- ---------------------------------------------------------------------------
-- Wave WAREHOUSE (Innovation #5): electronic warehouse receipts (e-WHR).
-- Admin-managed certified warehouse registry (H3 cells computed in the app
-- layer — no PostGIS), farmer crop-lot deposits with quality grading,
-- HMAC-signed receipts, pledge/lien collateral records (mirroring the
-- livestock lien precedent), an append-only ownership-transfer audit trail,
-- and the withdrawal/redeem flow. Money stays in the finance ledger — these
-- tables hold operational records only. No triggers anywhere.
-- Idempotent: CREATE … IF NOT EXISTS throughout; safe to re-apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE SCHEMA IF NOT EXISTS warehouse;

CREATE TABLE IF NOT EXISTS warehouse.warehouses (
    id                    text PRIMARY KEY,
    name                  text NOT NULL,
    state                 text NOT NULL,
    lga                   text NOT NULL,
    latitude              double precision NOT NULL
                          CHECK (latitude BETWEEN -90 AND 90),
    longitude             double precision NOT NULL
                          CHECK (longitude BETWEEN -180 AND 180),
    h3_cell               text NOT NULL,
    capacity_tonnes       numeric(12,2) NOT NULL CHECK (capacity_tonnes > 0),
    certification_status  text NOT NULL DEFAULT 'pending'
                          CHECK (certification_status IN ('pending','certified','suspended')),
    operator_license_ref  text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warehouse_warehouses_state_idx
    ON warehouse.warehouses (state, lga, certification_status);
CREATE INDEX IF NOT EXISTS warehouse_warehouses_h3_idx
    ON warehouse.warehouses (h3_cell);

CREATE TABLE IF NOT EXISTS warehouse.deposits (
    id            text PRIMARY KEY,
    warehouse_id  text NOT NULL REFERENCES warehouse.warehouses(id),
    farmer_id     text NOT NULL REFERENCES identity.users(id),
    -- Optional link to traceability.commodity_lots (no FK: additive link).
    lot_id        text,
    crop          text NOT NULL,
    status        text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','graded','issued','withdrawn')),
    grading       jsonb,                    -- WarehouseGrading
    receipt_id    text,                     -- set at e-WHR issuance (idempotent)
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warehouse_deposits_farmer_idx
    ON warehouse.deposits (farmer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS warehouse_deposits_warehouse_idx
    ON warehouse.deposits (warehouse_id, status);
CREATE INDEX IF NOT EXISTS warehouse_deposits_lot_idx
    ON warehouse.deposits (lot_id) WHERE lot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS warehouse.receipts (
    id              text PRIMARY KEY,
    receipt_number  text NOT NULL UNIQUE,
    deposit_id      text NOT NULL REFERENCES warehouse.deposits(id),
    warehouse_id    text NOT NULL REFERENCES warehouse.warehouses(id),
    owner_id        text NOT NULL REFERENCES identity.users(id),
    crop            text NOT NULL,
    grade           text NOT NULL CHECK (grade IN ('A','B','C')),
    bag_count       integer NOT NULL CHECK (bag_count > 0),
    weight_kg       numeric(12,2) NOT NULL CHECK (weight_kg > 0),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','pledged','released','redeemed')),
    nonce           text NOT NULL,
    signature       text NOT NULL,          -- HMAC-SHA256 hex (server-side secret)
    issued_at       timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_receipts_deposit_idx
    ON warehouse.receipts (deposit_id);
CREATE INDEX IF NOT EXISTS warehouse_receipts_owner_idx
    ON warehouse.receipts (owner_id, status);
CREATE INDEX IF NOT EXISTS warehouse_receipts_warehouse_idx
    ON warehouse.receipts (warehouse_id, status);

CREATE TABLE IF NOT EXISTS warehouse.pledges (
    id              text PRIMARY KEY,
    receipt_id      text NOT NULL REFERENCES warehouse.receipts(id),
    lender_id       text NOT NULL REFERENCES identity.users(id),
    borrower_id     text NOT NULL REFERENCES identity.users(id),
    principal_kobo  bigint NOT NULL CHECK (principal_kobo > 0),
    terms           text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released')),
    -- External collateral-registry reference; STUB-labelled until the
    -- national collateral registry integration gate is cleared.
    registry_ref    text,
    registry_basis  text NOT NULL DEFAULT 'stub'
                    CHECK (registry_basis IN ('stub','live')),
    registered_at   timestamptz NOT NULL DEFAULT now(),
    released_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- At most one active pledge per receipt (partial unique index, no trigger).
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_pledges_one_active_idx
    ON warehouse.pledges (receipt_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS warehouse_pledges_lender_idx
    ON warehouse.pledges (lender_id, status);
CREATE INDEX IF NOT EXISTS warehouse_pledges_borrower_idx
    ON warehouse.pledges (borrower_id, status);

-- Append-only ownership-transfer audit trail (never updated or deleted).
CREATE TABLE IF NOT EXISTS warehouse.transfers (
    id              text PRIMARY KEY,
    receipt_id      text NOT NULL REFERENCES warehouse.receipts(id),
    from_owner_id   text NOT NULL REFERENCES identity.users(id),
    to_owner_id     text NOT NULL REFERENCES identity.users(id),
    transferred_by  text NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warehouse_transfers_receipt_idx
    ON warehouse.transfers (receipt_id, created_at);
CREATE INDEX IF NOT EXISTS warehouse_transfers_to_owner_idx
    ON warehouse.transfers (to_owner_id);

COMMIT;
