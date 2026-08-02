-- 016_funds_hardening.sql — Funds-flow integrity hardening wave.
-- 1. Escrow pending provider-call states ('releasing'/'refunding'): the
--    transition intent is persisted BEFORE the payment provider is called so
--    a crash mid-call leaves a resumable record, never a double-release.
-- 2. Escrow expiry: held_until deadline; expired holds are auto-refunded by
--    the deterministic sweeper (EscrowService.expireHeldEscrows).
-- 3. Borrower-declared installment payments: 'declared' status carries the
--    payment reference until a lender-side actor (admin) confirms; only a
--    confirmed payment posts to the ledger (CRIT-1: no unilateral write-off).
-- Idempotent (IF NOT EXISTS / IF EXISTS throughout) per migration policy.

BEGIN;

-- ---------------------------------------------------------------------------
-- marketplace: escrow pending states + expiry deadline
-- ---------------------------------------------------------------------------
ALTER TABLE marketplace.escrow_records
    DROP CONSTRAINT IF EXISTS escrow_records_status_check;
ALTER TABLE marketplace.escrow_records
    ADD CONSTRAINT escrow_records_status_check
    CHECK (status IN ('held','releasing','released','refunding','refunded','disputed'));
ALTER TABLE marketplace.escrow_records
    ADD COLUMN IF NOT EXISTS held_until timestamptz;
CREATE INDEX IF NOT EXISTS escrow_records_expiry_idx
    ON marketplace.escrow_records (held_until) WHERE status = 'held';

-- ---------------------------------------------------------------------------
-- finance: borrower-declared installment payments pending confirmation
-- ---------------------------------------------------------------------------
ALTER TABLE finance.repayment_installments
    DROP CONSTRAINT IF EXISTS repayment_installments_status_check;
ALTER TABLE finance.repayment_installments
    ADD CONSTRAINT repayment_installments_status_check
    CHECK (status IN ('pending','declared','paid','late'));
ALTER TABLE finance.repayment_installments
    ADD COLUMN IF NOT EXISTS payment_reference text;
ALTER TABLE finance.repayment_installments
    ADD COLUMN IF NOT EXISTS declared_by text;
ALTER TABLE finance.repayment_installments
    ADD COLUMN IF NOT EXISTS declared_at timestamptz;

COMMIT;
