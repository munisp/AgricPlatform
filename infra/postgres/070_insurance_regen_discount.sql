-- 070_insurance_regen_discount.sql — Regen Discount (Stage 27, innovation
-- 12): carbon-MRV-verified premium discount on parametric policies (assumes
-- 031 insurance schema + 037 vsla_carbon schema applied).
--
-- 1. insurance.regen_discount_rate_card — versioned, append-only admin rate
--    card for the regen discount in basis points of the computed premium.
--    Each admin change INSERTs a new row with a monotonically increasing
--    version (the application reads the max version as current); rows are
--    never updated, so the exact terms that priced any historical policy
--    stay reproducible and the change history is itself audit evidence
--    (each write is also recorded in the hash-chained admin audit log).
--    discount_bps is bounded 0..5000 (0%..50% of the premium) at the
--    database layer, mirroring the premium.ts MAX_REGEN_DISCOUNT_BPS guard.
--
-- 2. insurance.regen_discounts — one discount per policy, ever (UNIQUE
--    policy_id): the discount is pinned at quote time and cannot be
--    re-applied or double-applied. attestation_id is a hard FK to the
--    vsla-carbon seasonal evidence row that established eligibility —
--    eligibility requires a RECORDED attestation (human/enumerator,
--    optionally NDVI-linked), never a fabricated satellite score.
--    evidence_basis is stamped honestly: 'live' only when the attestation
--    carries a live-provider NDVI linkage; 'estimate' for human/evidence-
--    based attestations and stub NDVI (estimate-only carbon figures stay
--    estimate-only). rate_card_version pins the rate-card version that
--    priced the policy (premium rate-card version recording).
--
-- Idempotent per migration policy: IF NOT EXISTS DDL throughout, CHECK
-- constraints inline on CREATE TABLE (no unguarded ADD CONSTRAINT), no
-- triggers.

BEGIN;

CREATE TABLE IF NOT EXISTS insurance.regen_discount_rate_card (
    version      integer PRIMARY KEY CHECK (version > 0),
    discount_bps integer NOT NULL CHECK (discount_bps >= 0 AND discount_bps <= 5000),
    set_by       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insurance.regen_discounts (
    id                 text PRIMARY KEY,
    policy_id          text NOT NULL REFERENCES insurance.policies(id),
    plot_id            text NOT NULL,
    attestation_id     text NOT NULL REFERENCES vsla_carbon.carbon_evidence(id),
    discount_bps       integer NOT NULL CHECK (discount_bps > 0 AND discount_bps <= 5000),
    discount_kobo      bigint NOT NULL CHECK (discount_kobo > 0),
    rate_card_version  integer NOT NULL REFERENCES insurance.regen_discount_rate_card(version),
    evidence_basis     text NOT NULL CHECK (evidence_basis IN ('live','estimate')),
    applied_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_regen_discounts_policy_uq
    ON insurance.regen_discounts (policy_id);
CREATE INDEX IF NOT EXISTS insurance_regen_discounts_attestation_idx
    ON insurance.regen_discounts (attestation_id);
CREATE INDEX IF NOT EXISTS insurance_regen_discounts_plot_idx
    ON insurance.regen_discounts (plot_id, applied_at);

COMMIT;
