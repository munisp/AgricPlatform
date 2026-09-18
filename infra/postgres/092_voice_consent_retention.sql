-- 092_voice_consent_retention.sql — FP-2 W2 V-69 (voice consent + retention).
--
-- Voice sessions captured NO consent and transcripts/dtmf histories were
-- retained verbatim forever (NDPA 2023). Sessions now carry a consent flag
-- (captured at session start via the IVR consent prompt / gateway flag);
-- retention is enforced service-side by sweeps (voice_turns purge past
-- VOICE_TRANSCRIPT_RETENTION_MS; ivr_calls.dtmf_history blanked past
-- IVR_DTMF_RETENTION_MS) — purges need no DDL. Pre-092 rows default
-- consent_captured = false (fail closed: no recorded consent on file).
--
-- Idempotent per migration policy. No triggers, additive only, no edits to
-- merged migrations.

BEGIN;

ALTER TABLE voice.voice_sessions
    ADD COLUMN IF NOT EXISTS consent_captured boolean NOT NULL DEFAULT false;

COMMIT;
