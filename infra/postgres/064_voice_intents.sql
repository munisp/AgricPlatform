-- 064_voice_intents.sql — Stage 27 innovation "Voice Teller" (voice schema).
-- Transactional read-only voice intents over IVR/USSD-voice: farmers dial in,
-- authenticate with their shared-device PIN, and hear account facts (savings
-- balance, agent float balance, next loan installment, VSLA position,
-- voucher status) READ from the ledger/credit/vsla/voucher read models —
-- never generated. This table is the audit + call-deflection analytics
-- record of every intent attempt.
--
-- Privacy invariant (NDPA 2023, mirroring the NIN doctrine in migration
-- 035): the caller's phone number is NEVER persisted in plaintext — only a
-- salted HMAC-SHA256 (msisdn_hmac). No CHECK on the value itself (any hex
-- digest is legal); the service layer guarantees the HMAC-only write path
-- and the pg contract test asserts the column shape.
--
-- Idempotent (IF NOT EXISTS), no triggers — updated/created timestamps are
-- maintained by application code, per repo convention.

BEGIN;

CREATE SCHEMA IF NOT EXISTS voice;

-- One transactional voice-intent attempt. `intent` is one of the four
-- grammar-slot intents (balance.savings | balance.float |
-- loan.next_installment | vsla.position | voucher.status); `result` is the
-- honest outcome (ok | unavailable | escalated). `user_id` is set only
-- after successful PIN verification; failed/unknown-caller attempts still
-- record the HMAC so deflection analytics and abuse review work without
-- plaintext phone numbers.
CREATE TABLE IF NOT EXISTS voice.intent_sessions (
    id             text PRIMARY KEY,
    user_id        text REFERENCES identity.users(id),
    channel        text NOT NULL,           -- ivr | ussd_voice
    intent         text NOT NULL,           -- grammar-slot intent id
    msisdn_hmac    text NOT NULL,           -- salted HMAC-SHA256 hex, NEVER plaintext
    result         text NOT NULL,           -- ok | unavailable | escalated
    duration_ms    integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Deflection analytics: intents per caller (HMAC) and per intent over time.
CREATE INDEX IF NOT EXISTS intent_sessions_msisdn_idx
    ON voice.intent_sessions (msisdn_hmac, created_at);

CREATE INDEX IF NOT EXISTS intent_sessions_user_idx
    ON voice.intent_sessions (user_id, created_at)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS intent_sessions_intent_idx
    ON voice.intent_sessions (intent, result, created_at);

COMMIT;
