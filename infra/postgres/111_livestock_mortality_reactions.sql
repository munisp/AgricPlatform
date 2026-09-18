-- 111_livestock_mortality_reactions.sql — V-11 animal death/theft reactions.
-- Liens gain a 'margin_call' status (set automatically when the collateral
-- animal dies or is stolen; the lien stays enforced — transfer guard and
-- one-lien-per-subject rule both treat it as live). Insurance claims gain
-- the 'mortality' auto-draft trigger. Idempotent: safe to re-apply.

BEGIN;

-- Lien status: widen the CHECK to include 'margin_call'.
ALTER TABLE livestock.liens DROP CONSTRAINT IF EXISTS liens_status_check;
ALTER TABLE livestock.liens
    ADD CONSTRAINT liens_status_check
    CHECK (status IN ('active','margin_call','discharged','defaulted'));

-- One live lien per subject: 'margin_call' is still a live (enforced) lien,
-- so the partial unique index must cover it too.
DROP INDEX IF EXISTS liens_one_active_per_subject;
CREATE UNIQUE INDEX IF NOT EXISTS liens_one_active_per_subject
    ON livestock.liens (subject_type, subject_id) WHERE status IN ('active','margin_call');

-- Claims: mortality auto-draft trigger (animal status_changed → dead|stolen).
ALTER TABLE livestock.insurance_claims DROP CONSTRAINT IF EXISTS insurance_claims_trigger_check;
ALTER TABLE livestock.insurance_claims
    ADD CONSTRAINT insurance_claims_trigger_check
    CHECK (trigger IN ('manual','recall','mortality'));

COMMIT;
