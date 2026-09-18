-- 087_assisted_accounts.sql — W2-FP1 V-44 (shared-phone households /
-- assisted accounts, dim04-H2).
--
-- identity.users.phone stays mandatory + globally unique for self-service
-- accounts. Assisted (phoneless / shared-SIM) identities carry a synthetic
-- `assisted:<id>` phone and the real SHARED contact phone lives on the
-- guardian link below — two farmers, one contact phone, distinct identities.
-- Every link requires a presence proof (the guardian/custodian agent
-- physically attested the dependent at onboarding).
--
-- Idempotent per migration policy. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS identity.guardian_links (
    id                 text PRIMARY KEY,
    dependent_user_id  text NOT NULL REFERENCES identity.users(id),
    guardian_user_id   text REFERENCES identity.users(id),
    custodian_agent_id text REFERENCES identity.users(id),
    kind               text NOT NULL CHECK (kind IN ('guardian','agent_custody')),
    relationship       text NOT NULL,
    contact_phone      text NOT NULL,
    presence_proof     jsonb NOT NULL,        -- { method, ref, attestedAt }
    created_at         timestamptz NOT NULL DEFAULT now(),
    revoked_at         timestamptz,
    -- Exactly one custodian: a guardian OR an agent, never both/neither.
    CHECK (
        (guardian_user_id IS NOT NULL AND custodian_agent_id IS NULL AND kind = 'guardian')
        OR (guardian_user_id IS NULL AND custodian_agent_id IS NOT NULL AND kind = 'agent_custody')
    )
);

CREATE INDEX IF NOT EXISTS guardian_links_dependent_idx
    ON identity.guardian_links (dependent_user_id);
CREATE INDEX IF NOT EXISTS guardian_links_guardian_idx
    ON identity.guardian_links (guardian_user_id);
CREATE INDEX IF NOT EXISTS guardian_links_agent_idx
    ON identity.guardian_links (custodian_agent_id);
CREATE INDEX IF NOT EXISTS guardian_links_contact_phone_idx
    ON identity.guardian_links (contact_phone);

COMMIT;
