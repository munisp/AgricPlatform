-- 055_credit_seasonal_schedules.sql — SeasonSync: harvest-linked loan
-- repayment schedules (innovation wave 27, batch 1 #1).
--
-- A seasonal schedule reshapes a credit loan's installment CALENDAR to the
-- borrower's crop season: grace through the growing season, then 1–3
-- harvest-weighted balloon installments inside the expected harvest window.
-- The pinned row is an immutable snapshot of the crop-calendar inputs
-- (immutable-snapshot doctrine, same as traceability geolocation): later
-- edits to the farm plot or its plantings can never rewrite agreed terms.
-- Only the due-date/amount SOURCE differs from the equal-installment path
-- (migration 025 credit.loan_repayments) — the repayment posting path,
-- read-time late marking and PAR reporting are unchanged.
--
-- Plain idempotent SQL — no triggers. Safe to re-apply (IF NOT EXISTS
-- throughout). Numbered 055 because 053/054 are reserved by in-flight PRs.

BEGIN;

CREATE TABLE IF NOT EXISTS credit.seasonal_schedules (
    id                   text PRIMARY KEY,
    loan_id              text NOT NULL REFERENCES credit.loan_applications(id) ON DELETE CASCADE,
    -- Informational link back to the plot whose planting produced the
    -- calendar; NULL when the calendar was captured explicitly at preview
    -- time (plot without a recorded crop calendar). The terms below are
    -- copied onto this row, so SET NULL can never rewrite them.
    plot_id              text REFERENCES farms.farm_plots(id) ON DELETE SET NULL,
    crop                 text NOT NULL,
    planting_date        date NOT NULL,
    harvest_window_start date NOT NULL,
    harvest_window_end   date NOT NULL,
    -- [{sequence, dueAt, amountKobo}] — integer kobo, sums to
    -- principal + interest exactly (largest-remainder rounding).
    installments         jsonb NOT NULL,
    version              integer NOT NULL CHECK (version > 0),
    -- previewed → accepted | superseded (accepted is terminal; a re-preview
    -- creates a new version rather than mutating this row).
    status               text NOT NULL DEFAULT 'previewed'
                         CHECK (status IN ('previewed','accepted','superseded')),
    created_by           text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    accepted_at          timestamptz,
    CHECK (harvest_window_end > harvest_window_start)
);

-- Version pinning: re-previews append a new version per loan.
CREATE UNIQUE INDEX IF NOT EXISTS seasonal_schedules_loan_version_uq
    ON credit.seasonal_schedules (loan_id, version);
-- Exactly one accepted seasonal schedule per loan (the accept CAS target).
CREATE UNIQUE INDEX IF NOT EXISTS seasonal_schedules_one_accepted_uq
    ON credit.seasonal_schedules (loan_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS seasonal_schedules_loan_idx
    ON credit.seasonal_schedules (loan_id);

COMMIT;
