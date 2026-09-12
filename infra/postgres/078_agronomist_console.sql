-- 078_agronomist_console.sql — Stage 27 innovation #19 "Agronomist SLA
-- Console" (spec migration 071 renumbered: 053–077 are reserved by
-- in-flight Stage-27 innovation branches; 078 is the next free number on
-- this branch's base).
--
-- The voice agronomist (migration 027) already emits escalation agent
-- cases; this migration adds the OPERATED console queue those escalations
-- land in: voice.escalation_cases with business-hours SLA deadlines,
-- exactly-one-winner claim (the migration-052 claim-lease doctrine:
-- assignment is a single guarded UPDATE with status='queued' as the CAS
-- precondition, so two concurrent agronomists can never both win), honest
-- answer delivery tracking (a case can only reach 'answered' when the
-- farmer's channel confirmed delivery — the CHECK below makes the
-- fail-closed rule a database invariant, not just a service convention),
-- and supervisor quality sampling.
--
-- Idempotent per repo policy (IF NOT EXISTS). No triggers, per repo
-- convention — updated_at and every transition are maintained by
-- application code.

BEGIN;

CREATE TABLE IF NOT EXISTS voice.escalation_cases (
    id                 text PRIMARY KEY,
    -- Originating voice session (027). CASCADE mirrors voice_turns: a
    -- session purge removes its escalation cases with it.
    session_id         text NOT NULL REFERENCES voice.voice_sessions(id) ON DELETE CASCADE,
    -- Link back to the wave-VOICE agent case this console case mirrors
    -- (voice.agent_cases, migration 027); NULL for manually opened cases.
    agent_case_id      text,
    -- Farmer identity when the session phone resolved to a registered user.
    user_id            text REFERENCES identity.users(id),
    -- Reply channel coordinates captured at enqueue time (immutable
    -- snapshot: the answer must reach the SAME phone the farmer called
    -- from, even if the session row is later edited).
    phone              text NOT NULL,
    channel            text NOT NULL DEFAULT 'sms',
    -- Programme cohort tag for the per-cohort SLA deliverable export.
    cohort             text,
    topic              text,
    locale             text NOT NULL DEFAULT 'en',
    priority           text NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('normal', 'high')),
    status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'assigned', 'answered', 'closed')),
    -- Business-hours-aware deadline computed by the service (config-driven:
    -- AGRONOMIST_SLA_* env, see .env.example).
    sla_due_at         timestamptz NOT NULL,
    -- Set by the SLA breacher sweep the first time the deadline passes with
    -- the case still un answered; doubles as the dedupe marker so the sweep
    -- emits voice.escalation.sla_breached exactly once per case.
    sla_breached_at    timestamptz,
    assigned_to        text,
    assigned_at        timestamptz,
    answer_text        text,
    answered_at        timestamptz,
    -- Honest delivery state of the answer push to the farmer's channel:
    -- pending (not yet attempted), delivered (channel confirmed), failed
    -- (stub/unreachable — retried by the sweep, NEVER fabricated).
    delivery_status    text NOT NULL DEFAULT 'pending'
                       CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
    delivery_attempts  integer NOT NULL DEFAULT 0,
    delivery_note      text,
    delivered_at       timestamptz,
    quality_score      integer CHECK (quality_score BETWEEN 1 AND 5),
    quality_scored_by  text,
    quality_scored_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Fail-closed honesty invariant: 'answered' means the farmer's channel
    -- CONFIRMED delivery. An answer recorded while delivery failed keeps
    -- status 'assigned' (with delivery_status 'failed') until a retry
    -- succeeds — this row can never claim the farmer was answered when the
    -- channel did not confirm.
    CONSTRAINT escalation_cases_answered_requires_delivery
        CHECK (status <> 'answered' OR (
            answer_text IS NOT NULL
            AND answered_at IS NOT NULL
            AND delivery_status = 'delivered'
        )),
    -- Claim invariant: assignment always carries the claimant + timestamp.
    CONSTRAINT escalation_cases_assignment_consistency
        CHECK ((status <> 'assigned' AND status <> 'answered' AND status <> 'closed')
               OR (assigned_to IS NOT NULL AND assigned_at IS NOT NULL))
);

-- Queue scan: the console lists queued cases by soonest SLA deadline.
CREATE INDEX IF NOT EXISTS escalation_cases_queue_idx
    ON voice.escalation_cases (status, sla_due_at);

-- An agronomist's workload view.
CREATE INDEX IF NOT EXISTS escalation_cases_assignee_idx
    ON voice.escalation_cases (assigned_to)
    WHERE assigned_to IS NOT NULL;

-- Per-cohort programme SLA reporting.
CREATE INDEX IF NOT EXISTS escalation_cases_cohort_idx
    ON voice.escalation_cases (cohort)
    WHERE cohort IS NOT NULL;

-- Idempotent enqueue: one console case per originating agent case.
CREATE UNIQUE INDEX IF NOT EXISTS escalation_cases_agent_case_uidx
    ON voice.escalation_cases (agent_case_id)
    WHERE agent_case_id IS NOT NULL;

COMMIT;
