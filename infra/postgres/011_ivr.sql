-- 011_ivr.sql — wave P6a IVR voice channel.
-- Africa's Talking Voice call state for the IVR menu (commodity prices,
-- crop advisory, registration/enrolment status, agent escalation).
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe
-- to re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS channels;

-- IVR call state machine rows. Africa's Talking identifies a call by its
-- sessionId; the full call-flow state rides in `state` (jsonb) so the engine
-- stays a pure function over (state, digits, data). dtmf_history is the
-- cumulative `*`-separated input used for idempotent replay on
-- (sessionId, dtmf-history-length). expires_at is the 10-minute inactivity
-- deadline swept by IvrService.sweepExpiredCalls. outcome is NULL while the
-- call is active and one of completed|abandoned|escalated at the end.
CREATE TABLE IF NOT EXISTS channels.ivr_calls (
    session_id    text PRIMARY KEY,
    caller_number text NOT NULL,
    state         jsonb NOT NULL DEFAULT '{}'::jsonb,
    current_menu  text NOT NULL DEFAULT 'main',
    dtmf_history  text NOT NULL DEFAULT '',
    outcome       text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ivr_calls_expiry_idx
    ON channels.ivr_calls (expires_at);

-- Agent-escalation follow-up: support staff poll this partial index for
-- escalated calls that still need a callback.
CREATE INDEX IF NOT EXISTS ivr_calls_outcome_idx
    ON channels.ivr_calls (outcome)
    WHERE outcome IS NOT NULL;

COMMIT;
