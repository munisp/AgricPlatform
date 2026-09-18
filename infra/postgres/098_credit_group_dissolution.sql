-- 098_credit_group_dissolution.sql — V-46: credit-group lifecycle exit.
--
-- Groups gain a status ('active' → 'dissolved', terminal). Dissolution is
-- blocked while the group has open liabilities (live group loans or
-- unsettled guarantor demands); the service enforces the gate and this
-- column gives it a CAS target (updateExpected on status) so a dissolve
-- racing a new group-loan application cannot both win.
--
-- Idempotent (IF NOT EXISTS throughout) per migration policy.

BEGIN;

ALTER TABLE credit.credit_groups
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','dissolved')),
    ADD COLUMN IF NOT EXISTS dissolved_at timestamptz;

COMMIT;
