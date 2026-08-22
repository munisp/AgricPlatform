-- 048_escrow_payouts.sql — Stage 23 escrow residual: provider-backed
-- release/refund rails pending a PSSP disbursement API.
--
-- Money OUT of escrow (release to seller / refund to buyer) now goes through
-- the ESCROW_PAYOUT_DRIVER port, and every payout attempt is recorded here
-- BEFORE/AFTER the driver call: idempotency key, integer kobo amount,
-- provider reference, status. The escrow record only reaches its terminal
-- state after the recorded attempt succeeds; a driver failure leaves the
-- escrow in its pending state ('releasing'/'refunding') with the attempt
-- marked 'failed' so a retry converges instead of double-paying.
--
-- Idempotency contract (mirrors the Idempotency-Key interceptor): the key is
-- unique; a retry with the same key AND the same payload hash replays the
-- stored attempt, while the same key with a different payload is rejected
-- (409) by the service layer.
--
-- Idempotent per migration policy (IF NOT EXISTS / pg_constraint guard).
-- No triggers, per repo convention. Money is integer kobo (CHECK > 0).

BEGIN;

CREATE TABLE IF NOT EXISTS marketplace.escrow_payouts (
    id               text PRIMARY KEY,
    escrow_id        text NOT NULL,
    order_id         text NOT NULL,
    kind             text NOT NULL CHECK (kind IN ('release','refund')),
    amount_kobo      bigint NOT NULL CHECK (amount_kobo > 0),
    idempotency_key  text NOT NULL,
    payload_hash     text NOT NULL,          -- sha256 of the payout payload
    provider         text NOT NULL,          -- payout driver name ('stub'|'live')
    provider_reference text,                 -- set once the driver succeeds
    status           text NOT NULL DEFAULT 'recorded'
                     CHECK (status IN ('recorded','succeeded','failed')),
    failure_reason   text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'escrow_payouts_escrow_fkey'
    ) THEN
        ALTER TABLE marketplace.escrow_payouts
            ADD CONSTRAINT escrow_payouts_escrow_fkey
            FOREIGN KEY (escrow_id)
            REFERENCES marketplace.escrow_records (id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS escrow_payouts_idempotency_key_uq
    ON marketplace.escrow_payouts (idempotency_key);

CREATE INDEX IF NOT EXISTS escrow_payouts_escrow_idx
    ON marketplace.escrow_payouts (escrow_id);

CREATE INDEX IF NOT EXISTS escrow_payouts_status_idx
    ON marketplace.escrow_payouts (status);

COMMIT;
