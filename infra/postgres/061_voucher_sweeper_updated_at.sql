-- 061_voucher_sweeper_updated_at.sql — WP-G12 stuck-voucher sweeper state
-- clock.
--
-- The voucher status machine (ISSUED → REDEEMING/EXPIRING/VOIDING → terminal)
-- records only created_at; a pending claim left by a crash mid-posting is
-- indistinguishable from one entered a second ago, so no sweeper can apply a
-- stuck TTL honestly. This migration adds updated_at, stamped by every
-- guarded status write (the pg repository sets updated_at = now() inside
-- updateExpected), so the sweeper can age VOIDING/REDEEMING claims.
--
-- Idempotent per repo policy (IF NOT EXISTS / self-guarding null-backfill,
-- the 018 pattern). No triggers, per repo convention. Additive only: no
-- constraint or type change on existing columns.

BEGIN;

ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Self-guarding backfill: existing rows inherit created_at (provable no-op
-- on re-apply — after the first run no updated_at IS NULL rows remain that
-- predate this migration).
UPDATE input_vouchers.vouchers SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE input_vouchers.vouchers
    ALTER COLUMN updated_at SET DEFAULT now();

-- Sweeper batch selection: due expiries per status + expiry clock.
CREATE INDEX IF NOT EXISTS input_vouchers_vouchers_status_expires_idx
    ON input_vouchers.vouchers (status, expires_at);

COMMIT;
