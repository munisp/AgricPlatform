-- 058_advisory_planting_pulse.sql — Stage 27 Batch 1, innovation 4:
-- Planting-Window Pulse (per-plot, per-crop season-countdown advisories over
-- SMS/USSD/WhatsApp generated from the live Open-Meteo driver).
--
-- Spec: /mnt/agents/output/stage27/innovations-spec.md §4 proposes migration
-- 056; numbered 058 here because 053/054 are in-flight PRs and 055–057 are
-- taken by sibling Stage-27 innovations (lead assignment). Content matches
-- the spec: one subscription table (dedupe key plot+channel+crop) and one
-- dispatch log (dedupe + basis honesty labelling).
--
-- Fail-closed doctrine: advisory_dispatches.basis is 'live' ONLY when the
-- message text was generated from a fresh live Open-Meteo forecast; stub or
-- unavailable weather records basis='unavailable' with
-- delivery_status='suppressed' — a stale or fabricated planting window is
-- never sent (agronomic fail-closed).
--
-- Idempotent per repo policy (IF NOT EXISTS / pg_constraint DO blocks).
-- No triggers, per repo convention.

BEGIN;

CREATE TABLE IF NOT EXISTS advisory.plot_advisory_subscriptions (
    id               text PRIMARY KEY,
    plot_id          text NOT NULL,           -- logical ref farms.farm_plots.id
    user_id          text NOT NULL,           -- subscriber (usually plot owner)
    channel          text NOT NULL,           -- sms | ussd | whatsapp | voice
    crop             text NOT NULL,           -- canonical crop (rule table keyed)
    h3_res9          text,                    -- plot centroid snapped to H3 res 9
    locale           text NOT NULL DEFAULT 'en',
    planting_window  jsonb,                   -- last generated window snapshot
    last_sent_at     timestamptz,
    consent_id       text,                    -- NDPA consent record (compliance.consents)
    status           text NOT NULL DEFAULT 'active',  -- active | paused | stopped
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plot_advisory_subscriptions_channel_check'
    ) THEN
        ALTER TABLE advisory.plot_advisory_subscriptions
            ADD CONSTRAINT plot_advisory_subscriptions_channel_check
            CHECK (channel IN ('sms','ussd','whatsapp','voice'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plot_advisory_subscriptions_status_check'
    ) THEN
        ALTER TABLE advisory.plot_advisory_subscriptions
            ADD CONSTRAINT plot_advisory_subscriptions_status_check
            CHECK (status IN ('active','paused','stopped'));
    END IF;
END $$;

-- One ACTIVE subscription per (plot, channel, crop); stopped rows free the
-- key so a farmer can re-subscribe after opting out.
CREATE UNIQUE INDEX IF NOT EXISTS plot_advisory_subscriptions_active_key
    ON advisory.plot_advisory_subscriptions (plot_id, channel, crop)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS plot_advisory_subscriptions_user_idx
    ON advisory.plot_advisory_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS plot_advisory_subscriptions_due_idx
    ON advisory.plot_advisory_subscriptions (status, last_sent_at);

CREATE TABLE IF NOT EXISTS advisory.advisory_dispatches (
    id               text PRIMARY KEY,
    subscription_id  text NOT NULL REFERENCES advisory.plot_advisory_subscriptions(id),
    window_start     text,                    -- ISO date of advised window start
    body_hash        text,                    -- sha256 of the rendered message body
    channel          text NOT NULL,
    basis            text NOT NULL,           -- live | unavailable
    delivery_status  text NOT NULL,           -- suppressed | failed | delivered
    detail           text,                    -- honest reason / driver note (no PII)
    rule_version     text,                    -- crop rule-table version used
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'advisory_dispatches_basis_check'
    ) THEN
        ALTER TABLE advisory.advisory_dispatches
            ADD CONSTRAINT advisory_dispatches_basis_check
            CHECK (basis IN ('live','unavailable'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'advisory_dispatches_status_check'
    ) THEN
        ALTER TABLE advisory.advisory_dispatches
            ADD CONSTRAINT advisory_dispatches_status_check
            CHECK (delivery_status IN ('suppressed','failed','delivered'));
    END IF;
END $$;

-- Delivery dedupe: at most ONE 'delivered' row per (subscription, body) —
-- the same planting window is never re-sent. Failed attempts are NOT
-- unique-constrained so next week's retry of an unchanged forecast is free
-- to record a new attempt row; the service checks this index (via a
-- hasDelivered probe + conflict-safe insert) before sending.
CREATE UNIQUE INDEX IF NOT EXISTS advisory_dispatches_delivered_key
    ON advisory.advisory_dispatches (subscription_id, body_hash)
    WHERE delivery_status = 'delivered';

CREATE INDEX IF NOT EXISTS advisory_dispatches_subscription_idx
    ON advisory.advisory_dispatches (subscription_id, created_at);

COMMIT;
