-- 040_warehouse_certification_basis.sql — wave WAREHOUSE certification basis.
-- refreshCertification persisted certificationStatus from the (possibly
-- stub) operator feed without recording the basis of the check, and
-- createDeposit gated on the bare status: a stub-derived 'certified' could
-- unblock deposits/pledges. Adds a nullable certification_basis column
-- ('stub' | 'live'; NULL for legacy rows / pending warehouses) so the basis
-- always travels with the status it produced and production can fail closed
-- on stub-derived certifications.
-- Idempotent per migration policy (IF NOT EXISTS). No triggers, per repo
-- convention.

BEGIN;

ALTER TABLE warehouse.warehouses
    ADD COLUMN IF NOT EXISTS certification_basis text;

COMMIT;
