-- 094_credit_lifecycle_extensions.sql — Wave-2 credit design gaps
-- (V-04 restructure, V-05 cure/settlement, V-28 guarantor demands,
--  V-29 partial payments, V-31 collateral↔warehouse linkage).
--
--   - loan_applications.status gains 'consolidated' (V-30 top-up terminal
--     state for the folded loan).
--   - loan_repayments.status gains 'superseded' (replaced schedule rows are
--     immutable audit history) and gains schedule_version + a NOT NULL
--     paid_amount_kobo (V-29: per-installment balance tracking; the
--     accumulation CAS needs a non-nullable precondition column).
--   - guarantors.status gains the demand lifecycle ('called','liable',
--     'settled') plus the demand columns (V-28).
--   - collateral gains optional warehouse pledge/receipt references (V-31).
--
-- Idempotent (IF NOT EXISTS / IF EXISTS throughout) per migration policy.

BEGIN;

-- ---------------------------------------------------------------------------
-- Status enum expansion (inline CHECK constraints from 025 are replaced)
-- ---------------------------------------------------------------------------
ALTER TABLE credit.loan_applications
    DROP CONSTRAINT IF EXISTS loan_applications_status_check;
ALTER TABLE credit.loan_applications
    ADD CONSTRAINT loan_applications_status_check
    CHECK (status IN ('draft','submitted','scoring','approved','rejected',
                      'disbursed','repaying','repaid','defaulted',
                      'written_off','consolidated'));

ALTER TABLE credit.loan_repayments
    DROP CONSTRAINT IF EXISTS loan_repayments_status_check;
ALTER TABLE credit.loan_repayments
    ADD CONSTRAINT loan_repayments_status_check
    CHECK (status IN ('pending','paid','late','missed','superseded'));

ALTER TABLE credit.guarantors
    DROP CONSTRAINT IF EXISTS guarantors_status_check;
ALTER TABLE credit.guarantors
    ADD CONSTRAINT guarantors_status_check
    CHECK (status IN ('invited','accepted','declined','called','liable','settled'));

-- ---------------------------------------------------------------------------
-- V-29: per-installment balance tracking. Existing unpaid rows get 0 so the
-- partial-payment CAS (expected paid_amount_kobo) has a concrete value.
-- ---------------------------------------------------------------------------
UPDATE credit.loan_repayments SET paid_amount_kobo = 0 WHERE paid_amount_kobo IS NULL;
ALTER TABLE credit.loan_repayments
    ALTER COLUMN paid_amount_kobo SET DEFAULT 0;
ALTER TABLE credit.loan_repayments
    ALTER COLUMN paid_amount_kobo SET NOT NULL;

-- V-04: schedule generation (1 = approval-time schedule; each restructure
-- or consolidation appends the next version).
ALTER TABLE credit.loan_repayments
    ADD COLUMN IF NOT EXISTS schedule_version integer NOT NULL DEFAULT 1
    CHECK (schedule_version > 0);

-- ---------------------------------------------------------------------------
-- V-28: guarantor demand lifecycle columns
-- ---------------------------------------------------------------------------
ALTER TABLE credit.guarantors
    ADD COLUMN IF NOT EXISTS demand_amount_kobo bigint CHECK (demand_amount_kobo >= 0),
    ADD COLUMN IF NOT EXISTS demanded_at timestamptz,
    ADD COLUMN IF NOT EXISTS liability_accepted_at timestamptz,
    ADD COLUMN IF NOT EXISTS settled_at timestamptz,
    -- Recorded consent reference when a settlement debits the guarantor's
    -- savings account; NULL means no savings debit happened.
    ADD COLUMN IF NOT EXISTS consent_ref text;
CREATE INDEX IF NOT EXISTS guarantors_status_idx ON credit.guarantors (status);

-- ---------------------------------------------------------------------------
-- V-31: warehouse pledge/receipt references on collateral rows
-- ---------------------------------------------------------------------------
ALTER TABLE credit.collateral
    ADD COLUMN IF NOT EXISTS warehouse_pledge_id text,
    ADD COLUMN IF NOT EXISTS warehouse_receipt_id text;

COMMIT;
