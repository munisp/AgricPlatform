-- 125_webhook_secret_rotation.sql — GAP-M23: partner webhook secret
-- rotation (docs/security/key-rotation.md). Adds the dual-accept grace
-- slots to partners.webhook_subscriptions: on rotation the current secret
-- moves to secret_prev with a grace deadline (secret_prev_until, default
-- 24h, max 7d) and outbound deliveries dual-sign (x-agric-signature with
-- the new secret + x-agric-signature-previous with the old) until the
-- deadline, so partners cut over without dropped events. Acceptance of the
-- previous secret is TIME-GATED at delivery; the slots are overwritten on
-- the next rotation. Secrets are never logged; the new secret is returned
-- exactly once by POST /partner/webhooks/:id/rotate-secret.
-- Idempotent: safe to re-apply.

BEGIN;

ALTER TABLE partners.webhook_subscriptions
    ADD COLUMN IF NOT EXISTS secret_prev       text,        -- previous HMAC secret during the rotation grace window
    ADD COLUMN IF NOT EXISTS secret_prev_until timestamptz; -- dual-accept grace deadline

COMMIT;
