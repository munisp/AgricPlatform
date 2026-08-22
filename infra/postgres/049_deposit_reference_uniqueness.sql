-- 049_deposit_reference_uniqueness.sql — Stage 24 audit fix A1-2:
-- one verified payment reference credits exactly one order.
--
-- Migration 045 recorded deposit_payment_reference on escrow records but
-- left it non-unique, and no code path looked it up: a buyer could mark N
-- orders deposit_paid with the SAME provider reference (PSSP verify
-- endpoints truthfully answer success for the same charge repeatedly), so a
-- single verified ₦ charge backed N escrows. This partial UNIQUE index
-- makes the reference a one-credit token at the database layer; the service
-- layer (MarketplaceService.verifyDeposit) adds the replay contract on top:
-- same reference + same order replays, same reference + different order is
-- rejected 409, and a concurrent first-use race surfaces as 23505 → 409.
--
-- Partial (WHERE NOT NULL) so legacy rows and declarative non-production
-- holds without a reference stay valid. Idempotent per repo policy
-- (IF NOT EXISTS). No triggers, per repo convention.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS escrow_records_deposit_reference_uq
    ON marketplace.escrow_records (deposit_payment_reference)
    WHERE deposit_payment_reference IS NOT NULL;

COMMIT;
