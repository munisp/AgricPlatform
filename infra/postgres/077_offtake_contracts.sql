-- 077_offtake_contracts.sql — Stage 27 Batch 3, Innovation 18: Harvest
-- Forward Contracts (milestone-tracked offtake agreements).
--
-- An aggregator (buyer) locks in cooperative supply pre-season: agreed
-- volume/quality/price-band, delivery milestones tracked against
-- traceability lots, auto-invoice and escrow hold per delivery. Money
-- movement never lives here: delivery escrow rides the existing
-- marketplace order/escrow rails (orders, invoices, escrow_records keep
-- their FKs) and milestone postings go through the finance ledger; these
-- tables hold contract/milestone/delivery operational records only.
--
-- Idempotent per repo policy (IF NOT EXISTS throughout). No triggers, per
-- repo convention. Text PKs match the app-generated id contract
-- ('offtake-<uuid>', 'offms-<uuid>', 'offdel-<uuid>'). Cross-domain links
-- (traceability lot, invoice, escrow) stay plain text columns with no
-- cross-schema FK, per the 003_commerce_finance.sql convention; invoice /
-- escrow links point at marketplace tables but stay unenforced so the
-- in-memory and pg paths share identical semantics.

BEGIN;

-- ---------------------------------------------------------------------------
-- marketplace: offtake contracts (two-party handshake draft -> active ->
-- fulfilled | defaulted | cancelled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.offtake_contracts (
    id              text PRIMARY KEY,
    cooperative_id  text NOT NULL,          -- seller side (chapter/cooperative)
    buyer_org_id    text NOT NULL,          -- aggregator/off-taker org
    commodity       text NOT NULL,
    qty_kg          bigint NOT NULL CHECK (qty_kg > 0),
    quality_spec    jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- {floorKoboPerKg, capKoboPerKg} — integer kobo per kg, never floats.
    price_band      jsonb NOT NULL,
    window_start    date NOT NULL,
    window_end      date NOT NULL,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','fulfilled','defaulted','cancelled')),
    -- Retry-safe creation (Idempotency-Key header); replays return the
    -- existing contract instead of duplicating terms.
    idempotency_key text UNIQUE,
    created_by      text NOT NULL,
    accepted_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (window_end > window_start),
    CHECK ((price_band->>'floorKoboPerKg')::bigint > 0),
    CHECK ((price_band->>'capKoboPerKg')::bigint >= (price_band->>'floorKoboPerKg')::bigint)
);
CREATE INDEX IF NOT EXISTS offtake_contracts_coop_idx
    ON marketplace.offtake_contracts (cooperative_id, created_at DESC);
CREATE INDEX IF NOT EXISTS offtake_contracts_buyer_idx
    ON marketplace.offtake_contracts (buyer_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS offtake_contracts_status_idx
    ON marketplace.offtake_contracts (status);

-- ---------------------------------------------------------------------------
-- marketplace: delivery milestones (partial deliveries accumulate;
-- missed only after due_date — enforced by the service-layer guarded CAS)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.offtake_milestones (
    id                  text PRIMARY KEY,
    contract_id         text NOT NULL REFERENCES marketplace.offtake_contracts(id),
    seq                 integer NOT NULL,
    due_date            date NOT NULL,
    qty_kg              bigint NOT NULL CHECK (qty_kg > 0),
    delivered_qty_kg    bigint NOT NULL DEFAULT 0
                        CHECK (delivered_qty_kg >= 0),
    -- Latest delivery's evidence links (full history in offtake_deliveries).
    linked_lot_id       text,
    invoice_id          text,
    escrow_id           text,
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','partial','met','missed')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (contract_id, seq),
    CHECK (delivered_qty_kg <= qty_kg)
);
CREATE INDEX IF NOT EXISTS offtake_milestones_contract_idx
    ON marketplace.offtake_milestones (contract_id, seq);
CREATE INDEX IF NOT EXISTS offtake_milestones_due_idx
    ON marketplace.offtake_milestones (due_date) WHERE status IN ('pending','partial');

-- ---------------------------------------------------------------------------
-- marketplace: recorded deliveries (one row per delivery; the exactly-once
-- arbiter is the UNIQUE idempotency_key claimed in the saga transaction)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.offtake_deliveries (
    id                  text PRIMARY KEY,
    contract_id         text NOT NULL REFERENCES marketplace.offtake_contracts(id),
    milestone_id        text NOT NULL REFERENCES marketplace.offtake_milestones(id),
    lot_id              text NOT NULL,      -- traceability lot: mandatory evidence
    order_id            text NOT NULL,      -- marketplace order riding the escrow rails
    invoice_id          text,
    escrow_id           text,
    qty_kg              bigint NOT NULL CHECK (qty_kg > 0),
    price_kobo_per_kg   bigint NOT NULL CHECK (price_kobo_per_kg > 0),
    amount_kobo         bigint NOT NULL CHECK (amount_kobo > 0),
    ledger_entry_id     text,               -- finance ledger transfer id (plain text, no cross-schema FK)
    idempotency_key     text UNIQUE,
    created_by          text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offtake_deliveries_contract_idx
    ON marketplace.offtake_deliveries (contract_id, created_at);

COMMIT;
