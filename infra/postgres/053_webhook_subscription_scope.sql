-- 053_webhook_subscription_scope.sql — Stage 27 WP-G3 (V3 middleware audit):
-- tenant scoping for outbound webhook subscriptions.
--
-- The webhook dispatcher fanned every mapped domain event out to every
-- active subscription filtered by event type ONLY. partner.* events carry
-- partnerId + member PII (userId, amountNgn) and were POSTed to every
-- subscriber regardless of ownership — a cross-tenant data leak.
--
-- This migration adds the ownership key and the explicit cross-tenant
-- opt-in:
--   partner_id   — owning partner organisation, copied from the bound M2M
--                  client (051 added partners.partner_clients.partner_id).
--                  NULL marks a platform-level subscription, which only
--                  receives events that carry no partnerId (e.g. learning
--                  events) — fail closed.
--   cross_tenant — platform/admin opt-in to receive cross-tenant traffic.
--                  Defaults to false (scoped) and is never settable through
--                  the partner API; flipping it is an operator action.
--
-- Idempotent per repo policy (IF NOT EXISTS); the backfill UPDATE is a
-- no-op on re-apply. No triggers, per repo convention.

BEGIN;

ALTER TABLE partners.webhook_subscriptions
    ADD COLUMN IF NOT EXISTS partner_id text;

ALTER TABLE partners.webhook_subscriptions
    ADD COLUMN IF NOT EXISTS cross_tenant boolean NOT NULL DEFAULT false;

-- Backfill ownership from the bound client. Subscriptions whose client is
-- unbound (pre-Stage-24 rows) stay NULL → platform scope, matching the
-- fail-closed convention on partner_clients.
UPDATE partners.webhook_subscriptions ws
    SET partner_id = pc.partner_id
    FROM partners.partner_clients pc
    WHERE ws.client_id = pc.client_id
      AND ws.partner_id IS NULL
      AND pc.partner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_subscriptions_partner_idx
    ON partners.webhook_subscriptions (partner_id);

COMMIT;
