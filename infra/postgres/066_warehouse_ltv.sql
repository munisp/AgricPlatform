-- ---------------------------------------------------------------------------
-- Stage 27 / Innovation 8: Receipt LTV Guardian — live collateral monitoring
-- for warehouse-receipt-backed loans (warehouse schema, extends migration
-- 034). Converts a static e-WHR pledge into a managed collateral position:
--   - warehouse.collateral_positions — one LIVE-monitored position per
--     receipt (partial unique index, mirroring the 034 pledges precedent);
--     status state machine active → margin_call → cured | liquidated.
--   - warehouse.ltv_observations — append-only observation log (evidence
--     doctrine): every evaluated price tick with its honest basis label.
--     The service layer exposes NO update or delete path for this table.
-- Money doctrine: the outstanding loan balance is NEVER copied onto these
-- rows. Positions store only the ledger account code to read it from
-- (finance ledger = single source of truth) at evaluation time.
-- Fail-closed: price_basis is 'live' or 'stub'; a position whose price feed
-- is unavailable is flagged price_stale for human review and skipped — no
-- observation, margin call or liquidation is ever derived from a missing or
-- fabricated price.
-- Idempotent: CREATE … IF NOT EXISTS throughout; safe to re-apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse.collateral_positions (
    id                    text PRIMARY KEY,
    receipt_id            text NOT NULL REFERENCES warehouse.receipts(id),
    loan_id               text NOT NULL,
    lender_id             text NOT NULL REFERENCES identity.users(id),
    borrower_id           text NOT NULL REFERENCES identity.users(id),
    -- Ledger account whose debit-positive balance IS the outstanding loan
    -- balance (e.g. member:<user>:loans_receivable). Read at evaluation
    -- time; the outstanding kobo is never stored on this row.
    ledger_account_code   text NOT NULL,
    pledged_qty_kg        numeric(12,2) NOT NULL CHECK (pledged_qty_kg > 0),
    commodity             text NOT NULL,
    haircut_bps           integer NOT NULL CHECK (haircut_bps BETWEEN 0 AND 9999),
    ltv_limit_bps         integer NOT NULL CHECK (ltv_limit_bps BETWEEN 1 AND 10000),
    margin_call_bps       integer NOT NULL CHECK (margin_call_bps BETWEEN 1 AND 10000),
    status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','margin_call','cured','liquidated')),
    -- Fail-closed honesty flag: set when the commodity-price driver is
    -- unavailable so the position surfaces for human review instead of
    -- being evaluated on nothing.
    price_stale           boolean NOT NULL DEFAULT false,
    opened_at             timestamptz NOT NULL DEFAULT now(),
    closed_at             timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (margin_call_bps >= ltv_limit_bps)
);

-- At most one LIVE-monitored position per receipt (partial unique index, no
-- trigger): cured/liquidated positions remain as history and the receipt
-- can be monitored again afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_collateral_positions_one_active_idx
    ON warehouse.collateral_positions (receipt_id) WHERE status IN ('active','margin_call');
CREATE INDEX IF NOT EXISTS warehouse_collateral_positions_loan_idx
    ON warehouse.collateral_positions (loan_id);
CREATE INDEX IF NOT EXISTS warehouse_collateral_positions_lender_idx
    ON warehouse.collateral_positions (lender_id, status);
CREATE INDEX IF NOT EXISTS warehouse_collateral_positions_live_idx
    ON warehouse.collateral_positions (status) WHERE status IN ('active','margin_call');

-- Append-only LTV observation log. Every evaluated price tick is recorded
-- with its honest basis; 'unavailable' is never a row (no price, no
-- observation — the position is flagged price_stale instead).
CREATE TABLE IF NOT EXISTS warehouse.ltv_observations (
    id                  text PRIMARY KEY,
    position_id         text NOT NULL REFERENCES warehouse.collateral_positions(id),
    price_per_kg_kobo   bigint NOT NULL CHECK (price_per_kg_kobo > 0),
    price_basis         text NOT NULL CHECK (price_basis IN ('live','stub')),
    outstanding_kobo    bigint NOT NULL CHECK (outstanding_kobo >= 0),
    ltv_bps             integer NOT NULL CHECK (ltv_bps >= 0),
    observed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warehouse_ltv_observations_position_idx
    ON warehouse.ltv_observations (position_id, observed_at);

COMMIT;
