-- 123_sync_version_bump_retries.sql — GAP-M11: reconciliation ledger for
-- failed sync version bumps. SyncVersioningService.recordChange is
-- deliberately non-fatal — a version-ledger failure must never break the
-- entity write — but the failed bump previously left the write
-- sync-INVISIBLE until the record changed again (accepted L-10, no
-- reconciliation). Now the failed change is enqueued here (one row per
-- entity/entity_id, upserted on repeated failure) and the reconciliation
-- pass (POST /admin/sweeps/sync-version-retries) re-applies the bump with
-- a bounded attempt budget:
--   * attempts >= 8  -> exhausted: the row is KEPT for ops inspection and
--     surfaced loudly (ERROR log + reconcile result), never silently
--     dropped — a dropped row would be permanent sync invisibility.
--   * a successful re-bump removes the row; the bump is the unconditional
--     INSERT ... ON CONFLICT DO UPDATE form, so re-application is safe
--     (it only advances the version, restoring pull visibility).
-- Idempotent per migration policy: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS sync.version_bump_retries (
    entity      text NOT NULL,
    entity_id   text NOT NULL,
    owner_id    text,
    actor_id    text,
    deleted     boolean NOT NULL DEFAULT false,
    attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity, entity_id)
);

CREATE INDEX IF NOT EXISTS version_bump_retries_updated_idx
    ON sync.version_bump_retries (updated_at);

COMMIT;
