-- 085_programme_funder.sql — FP-2 V-61 (donor reads bound to own funded programmes).
--
-- Any authenticated donor/regulator could read the funding state, voucher
-- lists (which carry farmerId) and reconciliation of EVERY subsidy programme.
-- Programmes now carry an optional funder_id (the donor user funding the
-- programme, set by the admin at creation); donor reads are scoped to
-- programmes they fund. Nullable: pre-082 programmes have no recorded funder
-- and are admin/regulator-only for donors (fail closed).
--
-- Idempotent (IF NOT EXISTS) per migration policy. No triggers, additive
-- only, no edits to merged migrations.

BEGIN;

ALTER TABLE input_vouchers.programmes
    ADD COLUMN IF NOT EXISTS funder_id text;

CREATE INDEX IF NOT EXISTS input_vouchers_programmes_funder_idx
    ON input_vouchers.programmes (funder_id);

COMMIT;
