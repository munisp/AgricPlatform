-- 104_agent_devices.sql — W2-C2 agent device binding + remote freeze/revoke
-- (V-41; agent_banking schema).
-- Agents transact from bound devices only: the raw device token is NEVER
-- persisted — only a keyed SHA-256 hash (same hash-at-rest doctrine as the
-- V-60 shared-device PIN work), so a stolen row cannot replay the token.
-- Once an agent has at least one ACTIVE binding, the cash endpoints require
-- a presented token that hashes to an ACTIVE row; a token hashing to a
-- REVOKED row (remote freeze after theft/SIM-swap) is rejected, and binding
-- an additional/new device is audited as a re-enrolment event.
-- Re-apply-safe per scripts/lint-migrations.mjs.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_banking.devices (
    id                  text PRIMARY KEY,
    agent_id            text NOT NULL REFERENCES agent_banking.agents(id),
    device_token_hash   text NOT NULL,
    label               text,
    status              text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | REVOKED
    bound_by            text NOT NULL,
    revoked_by          text,
    revoked_at          timestamptz,
    revoke_reason       text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- One row per (agent, device): re-binding the same device replays.
CREATE UNIQUE INDEX IF NOT EXISTS agent_banking_devices_token_idx
    ON agent_banking.devices (agent_id, device_token_hash);

CREATE INDEX IF NOT EXISTS agent_banking_devices_agent_idx
    ON agent_banking.devices (agent_id, status);

COMMIT;
