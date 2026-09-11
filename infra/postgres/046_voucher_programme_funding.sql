-- 046_voucher_programme_funding.sql — Stage 23: funded-float backing for
-- voucher issuance (stage-21 audit C3 follow-up; assumes 035 + 042 applied).
--
-- Keyless issuance previously created signed, money-bearing vouchers checked
-- only against the programme budget NUMBER (input_vouchers.programmes
-- .budget_kobo) — never against actually-funded money. This migration adds
-- the funded-float state that closes that gap:
--
-- 1. input_vouchers.programme_funding — one row per programme tracking the
--    funded float and its disposition, all in integer kobo:
--      funded_kobo   — money actually topped up into the programme float
--      reserved_kobo — face value reserved by live vouchers
--                      (ISSUED / REDEEMING / EXPIRING / VOIDING)
--      settled_kobo  — face value paid out on REDEEMED vouchers
--    Backing invariant (CHECK programme_funding_backed):
--      reserved_kobo + settled_kobo <= funded_kobo
--    so outstanding + already-settled face value can NEVER exceed funded
--    money. Issuance reserves atomically
--    (UPDATE ... WHERE funded_kobo - reserved_kobo - settled_kobo >= $amount,
--    zero rows ⇒ 422, nothing signed); redemption moves reserved → settled;
--    expiry/void releases the reservation. The float is consumed by
--    settlement — redeemed value only becomes issuable again after a new
--    top-up.
--
-- 2. input_vouchers.programme_funding_events — append-only funding event
--    log. idempotency_key is UNIQUE and serves two audiences:
--      top_up  : the MANDATORY client idempotency key — a transport retry
--                replays the original credit instead of double-funding
--                (mirrors 038/042 idempotency doctrine).
--      settle  : system marker input-voucher-funding-settle:<voucherId> —
--      release : system marker input-voucher-funding-release:<voucherId> —
--                the marker insert + the funding UPDATE happen in ONE
--                statement, so a crash-resume or concurrent retry can never
--                double-settle or double-release a voucher's reservation.
--
-- Legacy note: vouchers issued BEFORE this migration carry no reservation;
-- their settle/release markers apply as no-ops against the funding row (the
-- conditional UPDATEs simply match nothing to move). New issuance after this
-- migration is fail-closed: no funded float, no voucher.
--
-- Idempotent per migration policy: IF NOT EXISTS DDL plus
-- pg_constraint-guarded DO blocks for the CHECK constraints (no unguarded
-- ADD CONSTRAINT). No triggers, per repo convention.

BEGIN;

CREATE TABLE IF NOT EXISTS input_vouchers.programme_funding (
    programme_id    text PRIMARY KEY REFERENCES input_vouchers.programmes(id),
    funded_kobo     bigint NOT NULL DEFAULT 0,
    reserved_kobo   bigint NOT NULL DEFAULT 0,
    settled_kobo    bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS input_vouchers.programme_funding_events (
    id               text PRIMARY KEY,
    programme_id     text NOT NULL REFERENCES input_vouchers.programmes(id),
    kind             text NOT NULL,  -- top_up | settle | release
    amount_kobo      bigint NOT NULL,
    idempotency_key  text NOT NULL,
    reference        text,
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS input_vouchers_funding_events_key_uq
    ON input_vouchers.programme_funding_events (idempotency_key);

CREATE INDEX IF NOT EXISTS input_vouchers_funding_events_programme_idx
    ON input_vouchers.programme_funding_events (programme_id, created_at);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'programme_funding_amounts_nonnegative'
    ) THEN
        ALTER TABLE input_vouchers.programme_funding
            ADD CONSTRAINT programme_funding_amounts_nonnegative
            CHECK (funded_kobo >= 0 AND reserved_kobo >= 0 AND settled_kobo >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'programme_funding_backed'
    ) THEN
        ALTER TABLE input_vouchers.programme_funding
            ADD CONSTRAINT programme_funding_backed
            CHECK (reserved_kobo + settled_kobo <= funded_kobo);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'programme_funding_events_amount_positive'
    ) THEN
        ALTER TABLE input_vouchers.programme_funding_events
            ADD CONSTRAINT programme_funding_events_amount_positive
            CHECK (amount_kobo > 0);
    END IF;
END $$;

COMMIT;
