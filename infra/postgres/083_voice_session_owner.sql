-- 083_voice_session_owner.sql — FP-2 V-17 (voice session ownership + ninRef redaction).
--
-- Voice sessions for UNREGISTERED phones (farmer_user_id unset) previously had
-- no owner at all: assertSessionAccess only blocked when farmer_user_id was
-- set, so ANY authenticated user could read the transcript and append turns.
-- Sessions are now bound to the authenticated creator (created_by_user_id) and
-- unidentified sessions require owner-or-agent access. Rows predating this
-- column have no owner and are agent-only (fail closed).
--
-- The dictated NIN reference (nin_ref) was stored PLAINTEXT. Following the
-- input-vouchers NIN doctrine (salted HMAC-SHA256, NDPA 2023), new sessions
-- persist only nin_ref_hash; the raw reference is never written again.
-- nin_ref stays for legacy rows only — no backfill possible (the hash is
-- one-way) and no caller looks sessions up by NIN.
--
-- Idempotent (IF NOT EXISTS) per migration policy. No triggers, additive
-- only, no edits to merged migrations.

BEGIN;

ALTER TABLE voice.voice_sessions
    ADD COLUMN IF NOT EXISTS created_by_user_id text;

ALTER TABLE voice.voice_sessions
    ADD COLUMN IF NOT EXISTS nin_ref_hash text;

CREATE INDEX IF NOT EXISTS voice_sessions_created_by_idx
    ON voice.voice_sessions (created_by_user_id);

COMMIT;
