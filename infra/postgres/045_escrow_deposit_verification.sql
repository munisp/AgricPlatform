-- 045_escrow_deposit_verification.sql — Stage 22 audit fix C2:
-- verify-before-credit for the marketplace payment/escrow lifecycle.
-- The deposit_paid transition now carries the buyer's payment reference,
-- verified with the configured payment provider (Paystack/Flutterwave)
-- before escrow is held. The escrow record persists that evidence:
-- deposit_payment_reference is always recorded when supplied, and
-- deposit_verified_at is set only when a provider confirmed the charge
-- (status success + exact kobo amount). Auto-release on order completion
-- refuses holds without deposit_verified_at whenever verification is
-- required (provider wired or production); such legacy/unverified holds
-- resolve through the admin-mediated path.
--
-- Numbering note: 041 ships with PR #35 and 042-044 are pending in
-- parallel branches; this migration is idempotent per repo policy
-- (IF NOT EXISTS throughout) so apply order against them is safe.
-- No triggers, per repo convention. Nullable columns keep legacy rows
-- valid (NULL = no verified deposit evidence).

BEGIN;

ALTER TABLE marketplace.escrow_records
    ADD COLUMN IF NOT EXISTS deposit_payment_reference text,
    ADD COLUMN IF NOT EXISTS deposit_verified_at timestamptz;

COMMIT;
