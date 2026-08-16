-- 043_audit_chain_fork_guard.sql — fork-proof tamper-evident audit chain
-- (audit C2-11).
--
-- The 002 hash chain could fork under concurrent/multi-replica writers:
-- record() read the tail, computed prev_hash, then inserted in separate
-- steps, so two writers could claim the same parent; the per-process
-- lastHash cache made every HPA replica an independent fork source. This
-- migration makes the database itself reject forks:
--   * prev_hash/hash become NOT NULL with a 64-char lowercase-hex CHECK;
--   * a UNIQUE index on prev_hash serializes chain extension — two inserts
--     claiming the same parent collide (SQLSTATE 23505), and the writer
--     (PgAuditRepository.append, guarded INSERT … SELECT that re-reads the
--     tail in-statement) retries against the new tail.
--
-- Existing data is validated first by a guarded DO block that FAILS LOUDLY
-- (aborting the whole migration) if any legacy row is unchained/malformed or
-- the persisted history already forked, instead of silently skipping the
-- constraints. The current writer always persists non-null, well-formed
-- chain fields, so a violation here means out-of-band tampering or legacy
-- rows that must be backfilled/purged deliberately.
--
-- RESIDUAL RISK (documented, out of scope): deleting the last N rows still
-- leaves a valid shorter chain — the chain has no length checkpoint. Closing
-- that hole requires an external anchoring checkpoint (periodically
-- notarizing tail hash + event count outside the database); tracked as a
-- follow-up to audit C2-11.
--
-- Idempotent per migration policy (guarded DO blocks / IF NOT EXISTS).

BEGIN;

-- 1. Validate existing history before constraining it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM admin.audit_events WHERE prev_hash IS NULL OR hash IS NULL
    ) THEN
        RAISE EXCEPTION '043: admin.audit_events has rows with NULL prev_hash/hash — backfill or purge unchained rows before applying the fork guard';
    END IF;
    IF EXISTS (
        SELECT 1 FROM admin.audit_events
        WHERE prev_hash !~ '^[0-9a-f]{64}$' OR hash !~ '^[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION '043: admin.audit_events has malformed prev_hash/hash values (expected 64 lowercase hex chars)';
    END IF;
    IF EXISTS (
        SELECT prev_hash FROM admin.audit_events GROUP BY prev_hash HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION '043: admin.audit_events history already contains a fork (duplicate prev_hash) — investigate before constraining';
    END IF;
END $$;

-- 2. Chain fields are mandatory and well-formed from now on.
ALTER TABLE admin.audit_events
    ALTER COLUMN prev_hash SET NOT NULL,
    ALTER COLUMN hash SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_prev_hash_format'
    ) THEN
        ALTER TABLE admin.audit_events
            ADD CONSTRAINT audit_events_prev_hash_format
            CHECK (prev_hash ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_hash_format'
    ) THEN
        ALTER TABLE admin.audit_events
            ADD CONSTRAINT audit_events_hash_format
            CHECK (hash ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- 3. Fork rejection: one child per parent hash. Concurrent appends claiming
--    the same tail collide here (SQLSTATE 23505) and the loser retries.
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_prev_hash_uniq
    ON admin.audit_events (prev_hash);

COMMIT;
