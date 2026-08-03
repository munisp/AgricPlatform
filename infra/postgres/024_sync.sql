-- 024_sync.sql — record-level offline sync protocol v1 (Wave SYNCSRV).
-- Numbered 024: 020/022/023 are reserved by parallel waves.
--
--   1. sync.entity_versions   per-record version ledger. One row per
--                             (entity, entity_id); `version` increments on
--                             every write, `deleted` marks tombstones,
--                             `owner_id` captures the sync scope key at bump
--                             time so pull scoping still works after the
--                             source row is deleted.
--   2. sync.sync_cursors      server-side copy of each caller's per-entity
--                             pull cursor (clients also send `since`
--                             explicitly on every pull; the ledger row is a
--                             diagnostic/recovery aid, not the source of
--                             truth for authorisation).
--   3. sync.mutations         push idempotency ledger: one row per
--                             (user_id, client_mutation_id) recording the
--                             per-item outcome so client retries replay the
--                             ORIGINAL result instead of re-applying.
--
-- DESIGN NOTE (lint:sql constraint): pgsql-ast-parser cannot parse
-- CREATE TRIGGER / CREATE FUNCTION (see the note in
-- 003_commerce_finance.sql), so this migration deliberately ships NO
-- generic bump trigger. Version bumps are performed by application code
-- (EntityVersionRepository.bump / bumpExpected, wired into entity services
-- via SyncVersioningService) — the same pattern the finance schema adopted
-- for its deferred constraint trigger. Do not add triggers here until the
-- migration linter supports them.
--
-- Idempotent per migration policy: safe to re-run.

BEGIN;

CREATE SCHEMA IF NOT EXISTS sync;

-- ---------------------------------------------------------------------------
-- entity_versions: monotonic per-record versions (optimistic-concurrency
-- counters for push baseVersion checks; pull orders by version).
-- `version` is per-record, NOT a global sequence — pull cursors advance
-- over the max version SEEN in the caller's scope, which is monotonic even
-- though version numbers are shared across records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync.entity_versions (
    entity     text NOT NULL,
    entity_id  text NOT NULL,
    version    bigint NOT NULL,
    owner_id   text,                       -- scope key captured at bump time
    updated_by text REFERENCES identity.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (entity, entity_id)
);
CREATE INDEX IF NOT EXISTS sync_entity_versions_pull_idx
    ON sync.entity_versions (entity, owner_id, version);

-- ---------------------------------------------------------------------------
-- sync_cursors: last pull cursor the server handed to each (user, entity).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync.sync_cursors (
    user_id    text NOT NULL,
    entity     text NOT NULL,
    cursor     bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, entity)
);

-- ---------------------------------------------------------------------------
-- mutations: push dedup ledger (events.processed_events pattern, but the
-- recorded outcome is replayed to the caller on retry). Exactly-once
-- semantics: the insert is atomic on (user_id, client_mutation_id); a
-- conflicting concurrent insert replays the stored result.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync.mutations (
    user_id            text NOT NULL,
    client_mutation_id text NOT NULL,
    entity             text NOT NULL,
    entity_id          text NOT NULL,
    op                 text NOT NULL CHECK (op IN ('upsert', 'delete')),
    status             text NOT NULL CHECK (status IN ('applied', 'conflict', 'error')),
    new_version        bigint,
    detail             jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, client_mutation_id)
);
CREATE INDEX IF NOT EXISTS sync_mutations_entity_idx
    ON sync.mutations (entity, entity_id);

COMMIT;
