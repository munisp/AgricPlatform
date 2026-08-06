-- 031_insurance.sql — parametric insurance rail (wave-insurance).
-- Parametric products/policies/trigger events/payout proposals in a new
-- `insurance` schema. Plain idempotent SQL — no triggers, no PostGIS.
-- Safe to re-apply (IF NOT EXISTS throughout). The 3-product catalog is
-- seeded by the application repository layer (not here): migration data is
-- forbidden so re-applying migrations can never resurrect edited products.

BEGIN;

CREATE SCHEMA IF NOT EXISTS insurance;

-- Product catalog. trigger_definition holds the parametric trigger (h3
-- resolution, metric, operator, threshold, observation window, season) and
-- payout_table the graduated bands (breach-ratio -> % of sum insured).
CREATE TABLE IF NOT EXISTS insurance.products (
    id                 text PRIMARY KEY,
    code               text NOT NULL,
    name               text NOT NULL,
    description        text NOT NULL DEFAULT '',
    peril              text NOT NULL
                       CHECK (peril IN ('RAINFALL_DEFICIT','FLOOD','HEAT_STRESS')),
    trigger_definition jsonb NOT NULL,
    payout_table       jsonb NOT NULL,
    premium_rate_bps   integer NOT NULL CHECK (premium_rate_bps > 0),
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_products_code_uq
    ON insurance.products (code);

-- Policies: farmer + plot + product + season. status walks
-- quoted -> active -> triggered -> payout_proposed -> paid, or
-- active -> expired; the service rejects illegal transitions with 409.
CREATE TABLE IF NOT EXISTS insurance.policies (
    id              text PRIMARY KEY,
    farmer_user_id  text NOT NULL,
    plot_id         text NOT NULL,
    product_id      text NOT NULL,
    product_code    text NOT NULL,
    season          text NOT NULL,
    sum_insured_kobo bigint NOT NULL CHECK (sum_insured_kobo > 0),
    premium_kobo    bigint NOT NULL CHECK (premium_kobo >= 0),
    flood_band      text NOT NULL
                    CHECK (flood_band IN ('none','low','moderate','high','severe')),
    pricing_basis   text NOT NULL CHECK (pricing_basis IN ('stub','live')),
    status          text NOT NULL
                    CHECK (status IN ('quoted','active','triggered','payout_proposed','paid','expired')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insurance_policies_farmer_idx
    ON insurance.policies (farmer_user_id);
CREATE INDEX IF NOT EXISTS insurance_policies_status_idx
    ON insurance.policies (status);
CREATE INDEX IF NOT EXISTS insurance_policies_season_idx
    ON insurance.policies (season);

-- Trigger events carry the full evidence payload (observed value, basis
-- flags, threshold, breach margin) so an insurer can reproduce the
-- evaluation. (policy_id, evidence_fingerprint) is unique: re-running the
-- deterministic evaluation with unchanged inputs is a no-op.
CREATE TABLE IF NOT EXISTS insurance.trigger_events (
    id                   text PRIMARY KEY,
    policy_id            text NOT NULL,
    product_id           text NOT NULL,
    farmer_user_id       text NOT NULL,
    evidence             jsonb NOT NULL,
    evidence_fingerprint text NOT NULL,
    payout_percent       integer NOT NULL CHECK (payout_percent > 0 AND payout_percent <= 100),
    payout_kobo          bigint NOT NULL CHECK (payout_kobo >= 0),
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_trigger_events_policy_fp_uq
    ON insurance.trigger_events (policy_id, evidence_fingerprint);
CREATE INDEX IF NOT EXISTS insurance_trigger_events_farmer_idx
    ON insurance.trigger_events (farmer_user_id);
CREATE INDEX IF NOT EXISTS insurance_trigger_events_created_idx
    ON insurance.trigger_events (created_at);

-- Payout proposals settle through the double-entry ledger in STUB execution
-- mode (execution is always 'stub'; real disbursement is gated externally —
-- insurer MOU + payment rail activation, docs/parametric-insurance.md).
CREATE TABLE IF NOT EXISTS insurance.payouts (
    id                         text PRIMARY KEY,
    policy_id                  text NOT NULL,
    trigger_event_id           text NOT NULL,
    farmer_user_id             text NOT NULL,
    amount_kobo                bigint NOT NULL CHECK (amount_kobo > 0),
    status                     text NOT NULL CHECK (status IN ('proposed','paid')),
    execution                  text NOT NULL CHECK (execution IN ('stub')),
    ledger_proposal_entry_id   text,
    ledger_settlement_entry_id text,
    proposed_at                timestamptz NOT NULL DEFAULT now(),
    paid_at                    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_payouts_trigger_event_uq
    ON insurance.payouts (trigger_event_id);
CREATE INDEX IF NOT EXISTS insurance_payouts_farmer_idx
    ON insurance.payouts (farmer_user_id);
CREATE INDEX IF NOT EXISTS insurance_payouts_policy_idx
    ON insurance.payouts (policy_id);

COMMIT;
