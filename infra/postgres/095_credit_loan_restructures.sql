-- 095_credit_loan_restructures.sql — V-04: loan restructure audit trail.
--
-- A restructure regenerates a repaying loan's schedule from its outstanding
-- balance (old open installments are superseded, never mutated — 094 adds
-- the 'superseded' status). This table is the immutable, append-only record
-- of each restructure: the replaced schedule is pinned as a JSONB snapshot
-- (immutable-snapshot doctrine, same as 055 seasonal schedules) so later
-- edits can never rewrite what the borrower agreed to.
--
-- Idempotent (IF NOT EXISTS throughout) per migration policy.

BEGIN;

CREATE TABLE IF NOT EXISTS credit.loan_restructures (
    id                    text PRIMARY KEY,
    loan_id               text NOT NULL REFERENCES credit.loan_applications(id) ON DELETE CASCADE,
    -- 1-based per-loan restructure version; re-restructures append.
    version               integer NOT NULL CHECK (version > 0),
    reason                text NOT NULL,
    -- Outstanding balance carried into the replacement schedule.
    outstanding_kobo      bigint NOT NULL CHECK (outstanding_kobo >= 0),
    -- [{repaymentId, sequence, dueAt, amountKobo, paidAmountKobo}] — the
    -- pinned snapshot of the superseded open installments.
    superseded_schedule   jsonb NOT NULL,
    -- Replacement installment count; 0 for top-up consolidation folds
    -- (V-30), where the replacement schedule lives on the NEW loan.
    new_installment_count integer NOT NULL CHECK (new_installment_count >= 0),
    -- Credit score recomputed at restructure time (score-factor hook).
    score_after           integer CHECK (score_after BETWEEN 0 AND 1000),
    created_by            text NOT NULL REFERENCES identity.users(id),
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- Append-only versions per loan (claim-first CAS backstop: a concurrent
-- restructure reusing the version loses on this constraint).
CREATE UNIQUE INDEX IF NOT EXISTS loan_restructures_loan_version_uq
    ON credit.loan_restructures (loan_id, version);
CREATE INDEX IF NOT EXISTS loan_restructures_loan_idx
    ON credit.loan_restructures (loan_id);

COMMIT;
