-- 023_field_agents.sql — Wave AGENTS: field-agent (enumerator) assignments
-- and activity trail. Enumerators are field staff who capture farmer data on
-- behalf of farmer users; admins and chapter leads hand out assignments and
-- track per-agent productivity.
--
--   1. agents.agent_assignments   unit of field work (target count vs
--                                 completed count; auto-completes at target).
--   2. agents.agent_activity_log  append-only trail of every agent action
--                                 (assignment lifecycle + on-behalf capture).
--
-- Idempotent per migration policy: safe to re-run.

BEGIN;

CREATE SCHEMA IF NOT EXISTS agents;

-- ---------------------------------------------------------------------------
-- agent_assignments: one row per unit of field work. farmer_user_id is
-- nullable (area-level assignments target a state/lga, not one farmer);
-- chapter_id scopes the assignment to a chapter for chapter-lead oversight.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents.agent_assignments (
    id              text PRIMARY KEY,
    agent_user_id   text NOT NULL REFERENCES identity.users(id),
    farmer_user_id  text REFERENCES identity.users(id),
    chapter_id      text,
    state           text NOT NULL,
    lga             text NOT NULL,
    ward            text,
    purpose         text NOT NULL,
    target_count    integer NOT NULL DEFAULT 1 CHECK (target_count >= 1),
    completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    status          text NOT NULL DEFAULT 'assigned'
                    CHECK (status IN ('assigned', 'in_progress', 'completed', 'cancelled')),
    due_at          timestamptz,
    created_by      text NOT NULL REFERENCES identity.users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_assignments_agent_idx
    ON agents.agent_assignments (agent_user_id);
CREATE INDEX IF NOT EXISTS agent_assignments_farmer_idx
    ON agents.agent_assignments (farmer_user_id)
    WHERE farmer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_assignments_chapter_idx
    ON agents.agent_assignments (chapter_id)
    WHERE chapter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_assignments_status_idx
    ON agents.agent_assignments (status);
CREATE INDEX IF NOT EXISTS agent_assignments_state_idx
    ON agents.agent_assignments (state, lga);

-- ---------------------------------------------------------------------------
-- agent_activity_log: append-only. Every assignment lifecycle transition and
-- every on-behalf capture writes one row; meta carries the action-specific
-- context (progress delta, consent id, capture fields, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents.agent_activity_log (
    id              text PRIMARY KEY,
    agent_user_id   text NOT NULL REFERENCES identity.users(id),
    assignment_id   text REFERENCES agents.agent_assignments(id),
    action          text NOT NULL,
    subject_user_id text,
    meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_activity_log_agent_idx
    ON agents.agent_activity_log (agent_user_id);
CREATE INDEX IF NOT EXISTS agent_activity_log_assignment_idx
    ON agents.agent_activity_log (assignment_id)
    WHERE assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_activity_log_subject_idx
    ON agents.agent_activity_log (subject_user_id)
    WHERE subject_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_activity_log_action_idx
    ON agents.agent_activity_log (action, created_at);

COMMIT;
