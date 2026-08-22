-- 018_platform_foundation.sql — Wave P platform innovations.
--
--   1. platform.feature_flags          DB-backed feature flags (enabled,
--                                      role allowlist, percentage rollout).
--   2. identity.auth_sessions          refresh-token rotation metadata
--                                      (family tracking for reuse detection).
--   3. notifications.delivery_logs     retry/backoff + dead-letter columns.
--   4. events.outbox                   dead-letter marking for the sweeper.
--
-- Idempotent: safe to re-run on environments where earlier waves partially
-- applied the columns.

BEGIN;

-- ---------------------------------------------------------------------------
-- platform: cross-cutting platform configuration
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.feature_flags (
    key             text PRIMARY KEY,        -- e.g. 'notifications.sse'
    enabled         boolean NOT NULL DEFAULT false,
    role_allowlist  text[] NOT NULL DEFAULT '{}',  -- empty = all roles
    percentage      integer NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
    description     text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- identity.auth_sessions: refresh-token rotation + reuse detection
-- ---------------------------------------------------------------------------
-- family_id groups every token generation minted from one login; when a
-- revoked (already-rotated) token is presented again the whole family is
-- revoked. generation counts rotations inside the family.
ALTER TABLE identity.auth_sessions
    ADD COLUMN IF NOT EXISTS family_id uuid,
    ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- Pre-existing rows (created before families existed) each form their own
-- single-member family.
-- lint:sql waiver: the DML rule allows ONLY this self-guarding null-backfill
-- shape (SET c = … WHERE c IS NULL) — re-apply is a provable no-op because
-- backfilled rows no longer match the predicate.
UPDATE identity.auth_sessions SET family_id = id WHERE family_id IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_token_hash_idx
    ON identity.auth_sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS auth_sessions_family_idx
    ON identity.auth_sessions (family_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- notifications.delivery_logs: retry with exponential backoff + DLQ
-- ---------------------------------------------------------------------------
ALTER TABLE notifications.delivery_logs
    ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
    ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

CREATE INDEX IF NOT EXISTS delivery_logs_retry_idx
    ON notifications.delivery_logs (next_retry_at)
    WHERE dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- events.outbox: sweeper dead-letter marking
-- ---------------------------------------------------------------------------
ALTER TABLE events.outbox
    ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_dead_letter_idx
    ON events.outbox (occurred_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NOT NULL;

COMMIT;
