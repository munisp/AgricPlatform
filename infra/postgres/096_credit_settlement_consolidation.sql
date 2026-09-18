-- 096_credit_settlement_consolidation.sql — V-05 settlement-for-less and
-- V-30 top-up consolidation bookkeeping on credit.loan_applications.
--
--   settled_amount_kobo / write_down_kobo record the settlement split for
--   loans closed via settlement-for-less (defaulted → written_off with a
--   balanced ledger entry: cash debit + loan-loss debit vs receivable
--   credit; the legs live in the finance ledger, these columns are the
--   loan-side audit).
--   consolidates_loan_id links a top-up application to the repaying loan it
--   will fold at approval (the old loan ends 'consolidated').
--
-- Idempotent (IF NOT EXISTS throughout) per migration policy.

BEGIN;

ALTER TABLE credit.loan_applications
    ADD COLUMN IF NOT EXISTS settled_amount_kobo bigint CHECK (settled_amount_kobo >= 0),
    ADD COLUMN IF NOT EXISTS write_down_kobo bigint CHECK (write_down_kobo >= 0),
    ADD COLUMN IF NOT EXISTS consolidates_loan_id text
        REFERENCES credit.loan_applications(id);

-- At most one consolidation target per source loan: a repaying loan can be
-- folded into exactly one top-up application.
CREATE UNIQUE INDEX IF NOT EXISTS loan_applications_consolidates_uq
    ON credit.loan_applications (consolidates_loan_id)
    WHERE consolidates_loan_id IS NOT NULL;

COMMIT;
