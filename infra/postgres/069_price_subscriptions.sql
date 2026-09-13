-- 069_price_subscriptions.sql — Stage 27, innovation 11: Price Wire
-- (farmer-subscribed crop-price ticker over SMS/USSD/WhatsApp).
--
-- Spec: /mnt/agents/output/stage27/innovations-spec.md §11 proposes migration
-- 063; numbered 069 here per lead assignment (053–068 taken by sibling
-- Stage-27 innovations). Content matches the spec: advisory.price_subscriptions
-- with UNIQUE (user_id, commodity, market_id, channel), plus a dispatch log
-- mirroring the advisory_dispatches pattern (delivered-dedupe + basis
-- honesty labelling).
--
-- Fail-closed doctrine: advisory.price_dispatches.basis is 'live' ONLY when
-- the rendered price came from a fresh live feed observation (FEWS NET /
-- NiMet ingestion or a keyed provider adapter). Feed keys absent → provider
-- port is STUB → quotes carry basis='stub' and dispatches are SUPPRESSED in
-- production (a fabricated or stale price is never SMSed to a farmer about
-- to sell); feed outages record basis='unavailable'.
--
-- Idempotent per repo policy (IF NOT EXISTS / pg_constraint DO blocks).
-- No triggers, per repo convention.

BEGIN;

CREATE TABLE IF NOT EXISTS advisory.price_subscriptions (
    id               text PRIMARY KEY,
    user_id          text NOT NULL,           -- subscriber (identity.users.id logical ref)
    commodity        text NOT NULL,           -- canonical commodity key (lowercase)
    market_id        text NOT NULL,           -- market name (advisory.commodity_prices.market logical ref)
    channel          text NOT NULL,           -- sms | ussd | whatsapp
    cadence          text NOT NULL DEFAULT 'weekly',  -- weekly | daily
    last_sent_at     timestamptz,
    status           text NOT NULL DEFAULT 'active',  -- active | stopped
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'price_subscriptions_channel_check'
    ) THEN
        ALTER TABLE advisory.price_subscriptions
            ADD CONSTRAINT price_subscriptions_channel_check
            CHECK (channel IN ('sms','ussd','whatsapp'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'price_subscriptions_cadence_check'
    ) THEN
        ALTER TABLE advisory.price_subscriptions
            ADD CONSTRAINT price_subscriptions_cadence_check
            CHECK (cadence IN ('weekly','daily'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'price_subscriptions_status_check'
    ) THEN
        ALTER TABLE advisory.price_subscriptions
            ADD CONSTRAINT price_subscriptions_status_check
            CHECK (status IN ('active','stopped'));
    END IF;
END $$;

-- Spec dedupe key: one subscription per (user, commodity, market, channel),
-- covering stopped rows too — re-subscribing revives the stopped row instead
-- of inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS price_subscriptions_dedupe_key
    ON advisory.price_subscriptions (user_id, commodity, market_id, channel);

CREATE INDEX IF NOT EXISTS price_subscriptions_user_idx
    ON advisory.price_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS price_subscriptions_due_idx
    ON advisory.price_subscriptions (status, cadence, last_sent_at);

CREATE TABLE IF NOT EXISTS advisory.price_dispatches (
    id               text PRIMARY KEY,
    subscription_id  text NOT NULL REFERENCES advisory.price_subscriptions(id),
    quote_as_of      timestamptz,             -- observation time of the quoted price
    body_hash        text,                    -- sha256 of the rendered message body
    channel          text NOT NULL,
    basis            text NOT NULL,           -- live | stub | unavailable
    delivery_status  text NOT NULL,           -- suppressed | failed | delivered
    detail           text,                    -- honest reason / driver note (no PII)
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'price_dispatches_basis_check'
    ) THEN
        ALTER TABLE advisory.price_dispatches
            ADD CONSTRAINT price_dispatches_basis_check
            CHECK (basis IN ('live','stub','unavailable'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'price_dispatches_status_check'
    ) THEN
        ALTER TABLE advisory.price_dispatches
            ADD CONSTRAINT price_dispatches_status_check
            CHECK (delivery_status IN ('suppressed','failed','delivered'));
    END IF;
END $$;

-- Delivery dedupe: at most ONE 'delivered' row per (subscription, body) —
-- the same price quote is never re-sent. Failed attempts are NOT
-- unique-constrained so the next run's retry of an unchanged quote is free
-- to record a new attempt row.
CREATE UNIQUE INDEX IF NOT EXISTS price_dispatches_delivered_key
    ON advisory.price_dispatches (subscription_id, body_hash)
    WHERE delivery_status = 'delivered';

CREATE INDEX IF NOT EXISTS price_dispatches_subscription_idx
    ON advisory.price_dispatches (subscription_id, created_at);

COMMIT;
