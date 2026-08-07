-- 035_input_vouchers.sql — wave NINVOUCHER "NIN-linked input subsidy e-vouchers"
-- (input_vouchers schema).
-- Government input-subsidy e-vouchers: programmes with a budget envelope,
-- NIN-verified beneficiaries, voucher allocation/distribution/redemption at
-- agro-dealers, and settlement reconciliation for regulators/donors.
-- Money movement is NOT stored here: the budget envelope, outstanding
-- liability and supplier receivables post through the double-entry finance
-- ledger (finance schema, wave P2a). These tables hold OPERATIONAL records
-- only and cross-reference ledger journal entries by id.
-- Nigeria data-protection posture: the full NIN is NEVER stored. Only a
-- salted HMAC-SHA256 hash (dedupe) and a last-3 mask (operator display)
-- persist. No triggers — timestamps are maintained by application code.
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS input_vouchers;

-- Subsidy programmes (e.g. "2026 wet-season fertiliser"). The budget
-- envelope is encumbered in the finance ledger on ACTIVATION
-- (DR platform:subsidy_budget / CR programme:<id>:liability); this row is
-- the operational record of the allocation rules.
CREATE TABLE IF NOT EXISTS input_vouchers.programmes (
    id                      text PRIMARY KEY,
    name                    text NOT NULL,
    sponsor                 text NOT NULL,
    description             text,
    status                  text NOT NULL DEFAULT 'DRAFT',  -- DRAFT | ACTIVE | CLOSED
    per_farmer_cap_kobo     bigint NOT NULL,
    budget_kobo             bigint NOT NULL,
    eligible_states         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- empty = all states
    eligible_crops          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- empty = all crops
    liability_account_code  text NOT NULL UNIQUE,
    created_by              text NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS input_vouchers_programmes_status_idx
    ON input_vouchers.programmes (status);

-- NIN-verified beneficiaries. nin_hash is the salted HMAC-SHA256 of the
-- normalised NIN (dedupe key); nin_mask is the last-3 mask for operators.
-- verification_basis is the honest provenance label: 'stub' until a
-- NIMC/licensed vendor contract exists (fail-closed live driver), then 'live'.
CREATE TABLE IF NOT EXISTS input_vouchers.beneficiaries (
    id                  text PRIMARY KEY,
    programme_id        text NOT NULL REFERENCES input_vouchers.programmes(id),
    farmer_id           text NOT NULL REFERENCES identity.users(id),
    nin_hash            text NOT NULL,
    nin_mask            text NOT NULL,
    verification_basis  text NOT NULL,           -- stub | live
    name_match_score    integer,
    state               text,
    primary_crop        text,
    verified_at         timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- One enrolment per farmer per programme; one NIN per farmer per programme.
CREATE UNIQUE INDEX IF NOT EXISTS input_vouchers_beneficiaries_farmer_idx
    ON input_vouchers.beneficiaries (programme_id, farmer_id);

CREATE UNIQUE INDEX IF NOT EXISTS input_vouchers_beneficiaries_nin_idx
    ON input_vouchers.beneficiaries (programme_id, nin_hash);

-- Subsidy vouchers. Anti-double-spend: the status machine
-- ISSUED→REDEEMED/EXPIRED/VOIDED advances via compare-and-set, and the
-- redemptions table carries a UNIQUE voucher_id. idempotency_key is UNIQUE
-- so allocation retries replay, never double-issue.
CREATE TABLE IF NOT EXISTS input_vouchers.vouchers (
    id                  text PRIMARY KEY,
    programme_id        text NOT NULL REFERENCES input_vouchers.programmes(id),
    beneficiary_id      text NOT NULL REFERENCES input_vouchers.beneficiaries(id),
    farmer_id           text NOT NULL REFERENCES identity.users(id),
    amount_kobo         bigint NOT NULL,
    status              text NOT NULL DEFAULT 'ISSUED',  -- ISSUED | REDEEMED | EXPIRED | VOIDED
    idempotency_key     text NOT NULL UNIQUE,
    expires_at          timestamptz NOT NULL,
    distributed_at      timestamptz,
    redeemed_at         timestamptz,
    voided_at           timestamptz,
    ledger_entry_id     text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS input_vouchers_vouchers_programme_idx
    ON input_vouchers.vouchers (programme_id, status);

CREATE INDEX IF NOT EXISTS input_vouchers_vouchers_farmer_idx
    ON input_vouchers.vouchers (farmer_id, status);

-- Redemption log at agro-dealers (supplier role). UNIQUE voucher_id is the
-- hard anti-double-spend constraint behind the status machine; the ledger
-- entry (DR programme liability / CR supplier receivable) is the settlement
-- source of truth, idempotent on input-voucher-redemption:<voucherId>.
CREATE TABLE IF NOT EXISTS input_vouchers.redemptions (
    id                  text PRIMARY KEY,
    voucher_id          text NOT NULL UNIQUE REFERENCES input_vouchers.vouchers(id),
    programme_id        text NOT NULL REFERENCES input_vouchers.programmes(id),
    supplier_id         text NOT NULL REFERENCES identity.users(id),
    invoice_ref         text NOT NULL,
    amount_kobo         bigint NOT NULL,
    idempotency_key     text NOT NULL UNIQUE,
    ledger_entry_id     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS input_vouchers_redemptions_supplier_idx
    ON input_vouchers.redemptions (supplier_id, created_at);

CREATE INDEX IF NOT EXISTS input_vouchers_redemptions_programme_idx
    ON input_vouchers.redemptions (programme_id, created_at);

COMMIT;
