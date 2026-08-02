-- 002_audit_hash_chain.sql — tamper-evident audit trail (observability plan §A.6).
-- Adds the hash-chain columns to admin.audit_events. All statements are
-- idempotent (IF NOT EXISTS) so the migration is safe to re-apply.
-- 001_init.sql is left untouched per migration policy.

BEGIN;

ALTER TABLE admin.audit_events
    ADD COLUMN IF NOT EXISTS prev_hash  text,   -- hash of the previous event (genesis = 64 zeros)
    ADD COLUMN IF NOT EXISTS hash       text,   -- sha256(canonicalJSON(event) + prev_hash)
    ADD COLUMN IF NOT EXISTS request_id text;   -- correlates with the HTTP request id

COMMIT;
