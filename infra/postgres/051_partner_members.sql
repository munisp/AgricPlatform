-- 051_partner_members.sql — Stage 24 partner tenant binding (audit A2-1/A2-2).
-- partners.partner_members binds platform users (role `partner`) to the
-- partner organisation slug they may act for; PartnerService refuses
-- non-admin callers without a membership row (fail closed). Memberships are
-- admin-managed (PUT/DELETE /admin/users/:id/partner-memberships/:partnerId).
-- partners.partner_clients.partner_id binds an M2M client to one partner
-- organisation so client-credentials tokens carry the tenant claim and
-- `:partnerId` routes/disbursement writes are scoped to it.
-- All statements are idempotent (IF NOT EXISTS / pg_constraint DO block) so
-- the migration is safe to re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS partners;

-- User ↔ partner-organisation membership (admin-managed tenant binding).
CREATE TABLE IF NOT EXISTS partners.partner_members (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    partner_id  text NOT NULL,
    created_by  text NOT NULL,          -- admin user id that granted the binding
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- One membership row per (user, partner) pair, added idempotently.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'partner_members_user_partner_key'
    ) THEN
        ALTER TABLE partners.partner_members
            ADD CONSTRAINT partner_members_user_partner_key UNIQUE (user_id, partner_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS partner_members_user_idx
    ON partners.partner_members (user_id);
CREATE INDEX IF NOT EXISTS partner_members_partner_idx
    ON partners.partner_members (partner_id);

-- Tenant binding for M2M partner clients (nullable: pre-Stage-24 rows are
-- unbound and fail closed on tenant-parameterised routes until rebound).
ALTER TABLE partners.partner_clients ADD COLUMN IF NOT EXISTS partner_id text;

CREATE INDEX IF NOT EXISTS partner_clients_partner_idx
    ON partners.partner_clients (partner_id);

COMMIT;
