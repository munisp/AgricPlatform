-- 027_voice.sql — wave VOICE "Voice Agronomist" (voice schema).
-- IVR/USSD-first AI agronomy advisory sessions with human escalation:
-- voice_sessions (state machine INTAKE→TRIAGE→ADVISORY→ESCALATED|RESOLVED),
-- voice_turns (transcript with RAG citations), agent_cases (escalation
-- queue with SLA + assignment). All statements are idempotent
-- (IF NOT EXISTS) so the migration is safe to re-apply. No triggers —
-- updated_at is maintained by application code, per repo convention.

BEGIN;

CREATE SCHEMA IF NOT EXISTS voice;

-- One advisory conversation over IVR (voice), USSD or an agent-assisted
-- channel. `state` rides the aggregate state machine; `menu_state` is the
-- opaque USSD menu-engine blob (the engine stays a pure function).
-- nin_ref is an OPTIONAL, unverified national-ID reference the farmer
-- dictates — it is stored for the agent, never treated as verified KYC.
CREATE TABLE IF NOT EXISTS voice.voice_sessions (
    id               text PRIMARY KEY,
    channel          text NOT NULL,           -- ivr | ussd | assisted
    state            text NOT NULL,           -- intake | triage | advisory | escalated | resolved
    phone            text NOT NULL,
    nin_ref          text,
    farmer_user_id   text REFERENCES identity.users(id),
    locale           text NOT NULL DEFAULT 'en',  -- en | ha | yo | ig
    crop             text,
    symptom_category text,
    menu_state       jsonb NOT NULL DEFAULT '{}'::jsonb,
    active_case_id   text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_sessions_phone_idx
    ON voice.voice_sessions (phone);

CREATE INDEX IF NOT EXISTS voice_sessions_farmer_idx
    ON voice.voice_sessions (farmer_user_id)
    WHERE farmer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS voice_sessions_state_idx
    ON voice.voice_sessions (state);

-- Transcript turns. cited_chunk_ids is the RAG grounding contract: every
-- assistant advisory turn carries the corpus chunk ids it is grounded in
-- (empty only for menu prompts and the safe fallback, never for agronomy
-- advice).
CREATE TABLE IF NOT EXISTS voice.voice_turns (
    id              text PRIMARY KEY,
    session_id      text NOT NULL REFERENCES voice.voice_sessions(id) ON DELETE CASCADE,
    turn_index      integer NOT NULL,
    speaker         text NOT NULL,            -- farmer | assistant | agent
    text            text NOT NULL,
    cited_chunk_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence      double precision,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_turns_session_idx
    ON voice.voice_turns (session_id, turn_index);

-- Human-escalation queue. Created on manual escalation, low-confidence
-- retrieval or no grounding; agents (agronomist/admin role) work the queue
-- against sla_due_at. suggested_answer + citation_chunk_ids pre-fill the
-- agent-assist console with the retrieval that triggered the case.
CREATE TABLE IF NOT EXISTS voice.agent_cases (
    id                  text PRIMARY KEY,
    session_id          text NOT NULL REFERENCES voice.voice_sessions(id) ON DELETE CASCADE,
    farmer_user_id      text REFERENCES identity.users(id),
    phone               text NOT NULL,
    channel             text NOT NULL,
    status              text NOT NULL,        -- open | assigned | responded | resolved
    reason              text NOT NULL,        -- requested | low_confidence | no_grounding
    priority            text NOT NULL DEFAULT 'normal',  -- normal | high
    sla_due_at          timestamptz NOT NULL,
    assigned_agent_id   text REFERENCES identity.users(id),
    suggested_answer    text,
    citation_chunk_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    response            text,
    responded_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Agent queue polling: open/assigned cases ordered by SLA age.
CREATE INDEX IF NOT EXISTS agent_cases_status_sla_idx
    ON voice.agent_cases (status, sla_due_at);

CREATE INDEX IF NOT EXISTS agent_cases_session_idx
    ON voice.agent_cases (session_id);

CREATE INDEX IF NOT EXISTS agent_cases_agent_idx
    ON voice.agent_cases (assigned_agent_id)
    WHERE assigned_agent_id IS NOT NULL;

COMMIT;
