-- 080_sync_change_seq.sql — sync protocol v2 (FP-4 / V-01): global monotonic
-- change sequence for pull cursors.
--
-- v1 ordered pulls by the PER-RECORD `version`, so a cursor (= max version
-- seen) permanently skipped records whose version lagged behind the
-- cursor — silent divergence across devices (docs/sync-protocol.md §6/§9).
-- v2 adds `change_seq`, a GLOBAL monotonic sequence stamped on every
-- version-ledger write. Pull/cursor operate on `change_seq`; `version`
-- remains only as the push CAS counter (baseVersion).
--
-- Backfill: existing rows are numbered in (updated_at, entity, entity_id)
-- order — a faithful replay of the order their last writes landed — and
-- the sequence is advanced past the maximum. The UPDATE is a self-guarding
-- null-backfill (018 pattern): re-applying is a no-op.
--
-- sync_cursors gains a `protocol` marker: rows recorded under v1 keep
-- protocol=1 (stale — never handed out as a v2 cursor), v2 writes stamp 2.
--
-- Idempotent per migration policy: safe to re-run.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS sync.entity_versions_change_seq_seq;

ALTER TABLE sync.entity_versions ADD COLUMN IF NOT EXISTS change_seq bigint;

UPDATE sync.entity_versions ev
   SET change_seq = numbered.rn
  FROM (
        SELECT entity, entity_id,
               row_number() OVER (ORDER BY updated_at, entity, entity_id) AS rn
          FROM sync.entity_versions
         WHERE change_seq IS NULL
       ) AS numbered
 WHERE ev.entity = numbered.entity
   AND ev.entity_id = numbered.entity_id
   AND ev.change_seq IS NULL;

SELECT setval(
  'sync.entity_versions_change_seq_seq',
  GREATEST(COALESCE((SELECT max(change_seq) FROM sync.entity_versions), 0), 1),
  (SELECT max(change_seq) FROM sync.entity_versions) IS NOT NULL
);

ALTER TABLE sync.entity_versions ALTER COLUMN change_seq SET DEFAULT nextval('sync.entity_versions_change_seq_seq');
ALTER TABLE sync.entity_versions ALTER COLUMN change_seq SET NOT NULL;

CREATE INDEX IF NOT EXISTS sync_entity_versions_change_seq_idx
    ON sync.entity_versions (entity, owner_id, change_seq);

ALTER TABLE sync.sync_cursors ADD COLUMN IF NOT EXISTS protocol smallint NOT NULL DEFAULT 1;

COMMIT;
