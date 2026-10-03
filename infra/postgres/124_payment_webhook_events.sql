-- 124_payment_webhook_events.sql — GAP-L05: durable reconciliation store
-- for payment-provider webhooks (paystack/flutterwave). Verified payment
-- callbacks were fanned out as integration.webhook.received with NO domain
-- consumer; this table is the minimal fail-closed reconciliation
-- structure: the RAW payload plus a reconciliation status, deduped
-- atomically on (provider, dedupe_key) so sweeper re-drives and provider
-- retries replay as no-ops.
--
--   * status 'received'  — persisted, awaiting reconciliation (the only
--     status the listener writes; matching a callback to an escrow/order is
--     deliberately NOT fabricated here — a future reconciliation worker
--     flips rows to 'reconciled'/'ignored').
--   * dedupe_key         — provider payment reference when extractable,
--     else a sha256 of the raw payload (listener-computed).
--   * payload jsonb NOT NULL — the verified raw provider payload.
--
-- Idempotent per migration policy: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS integrations.payment_webhook_events (
    id           text PRIMARY KEY,
    provider     text NOT NULL,
    event_type   text NOT NULL,
    reference    text,
    dedupe_key   text NOT NULL,
    payload      jsonb NOT NULL,
    status       text NOT NULL DEFAULT 'received'
                 CHECK (status IN ('received', 'reconciled', 'ignored')),
    received_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, dedupe_key)
);

CREATE INDEX IF NOT EXISTS payment_webhook_events_reference_idx
    ON integrations.payment_webhook_events (reference)
    WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_webhook_events_status_idx
    ON integrations.payment_webhook_events (status, received_at);

COMMIT;
