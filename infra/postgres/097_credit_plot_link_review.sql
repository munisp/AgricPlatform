-- 097_credit_plot_link_review.sql — V-03: crop-failure → loan grace path.
--
-- Loan applications can now record the financed plot / planting so the
-- farms planting-failure event (farms.planting.failed) can find the loans
-- it affects. On failure the credit subscriber sets review_flag =
-- 'crop_failure' and aging_suspended_at: pending installments stop aging
-- into 'late' at read time until a reviewer resolves the flag (the
-- restructure path, V-04, clears both).
--
-- plot_id/planting_id are informational links (SET NULL on delete — the
-- loan's terms and history never depend on the farm row surviving).
--
-- Idempotent (IF NOT EXISTS throughout) per migration policy.

BEGIN;

ALTER TABLE credit.loan_applications
    ADD COLUMN IF NOT EXISTS plot_id text
        REFERENCES farms.farm_plots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS planting_id text
        REFERENCES farms.crop_plantings(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS review_flag text,
    ADD COLUMN IF NOT EXISTS aging_suspended_at timestamptz;

-- Subscriber lookup: loans linked to a failed planting / its plot.
CREATE INDEX IF NOT EXISTS loan_applications_planting_idx
    ON credit.loan_applications (planting_id) WHERE planting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loan_applications_plot_idx
    ON credit.loan_applications (plot_id) WHERE plot_id IS NOT NULL;

COMMIT;
