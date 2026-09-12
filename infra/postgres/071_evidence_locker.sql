-- 071_evidence_locker.sql — Stage 27 Innovation 13: Evidence Locker
-- (hash-chained dispute evidence packs).
--
-- One-tap evidence capture (photos, weighbridge slips, signed notes) pinned
-- to an escrow/VSLA/insurance/pool case, hash-chained at upload so disputes
-- resolve on tamper-evident records. Postgres holds REFERENCES ONLY — blobs
-- live in S3-compatible object storage (the analytics lakehouse driver
-- path); there are no metadata-without-blob rows that would fabricate
-- provenance (the API confirms the object in storage BEFORE inserting).
--
-- Chain design (mirrors the audit chain doctrine, migrations 002/043/047):
--   * evidence.items rows are hash-chained PER CASE
--     (case_type, case_id): prev_hash -> item_hash, genesis = 64 zeros.
--     item_hash = sha256(canonicalJSON(immutable payload) + prev_hash).
--   * The hashed payload EXCLUDES status: status is the only mutable field
--     (active -> sealed on case seal; active|sealed -> expunged on NDPA
--     erasure) and transitions happen through guarded CAS UPDATEs
--     (WHERE status = <expected>), so mutation never rewrites provenance
--     and the chain stays verifiable across tombstones.
--   * UNIQUE (case_type, case_id, prev_hash) serializes chain extension
--     per case — concurrent uploads claiming the same chain tip collide
--     (SQLSTATE 23505) and the writer retries against the new tip, the
--     same fork guard as migration 043.
--   * UNIQUE (object_key) makes one storage object map to exactly one
--     evidence row (confirm retries replay instead of double-recording).
--   * CHECK (size_bytes > 0): zero-byte blobs are never evidence.
--
-- Append-only posture: this table has no UPDATE/DELETE path in the
-- application other than the two guarded CAS status transitions above
-- (repository-level, per the platform's no-trigger migration policy).
-- Hash-chain verification (GET .../chain) detects any out-of-band rewrite
-- or delete; sealing a case freezes its chain head hash into the platform
-- audit chain (admin.audit_events, itself anchor-notarized per migration
-- 047), bounding the truncation window for sealed cases.
--
-- NDPA expunge: the object is deleted from storage and the row stays as a
-- hash tombstone with status='expunged' — chain continuity is preserved
-- (mirrors the privacy export/delete doctrine: erase personal data, keep
-- tamper-evident structure).
--
-- 'pool' is admitted in the case_type vocabulary ahead of the pool-settlement
-- surface landing; the case-participant guard fails CLOSED for pool cases
-- (no pool registry exists in this tree yet) rather than admitting uploads
-- against an unverifiable case.
--
-- Idempotent per migration policy (IF NOT EXISTS / guarded DO blocks).

BEGIN;

CREATE SCHEMA IF NOT EXISTS evidence;

CREATE TABLE IF NOT EXISTS evidence.items (
    id           text PRIMARY KEY,
    case_type    text NOT NULL,
    case_id      text NOT NULL,
    uploader_id  text NOT NULL,
    object_key   text NOT NULL,
    sha256       char(64) NOT NULL,
    prev_hash    char(64) NOT NULL,
    item_hash    char(64) NOT NULL,
    captured_at  timestamptz,
    uploaded_at  timestamptz NOT NULL DEFAULT now(),
    mime         text NOT NULL,
    size_bytes   bigint NOT NULL,
    status       text NOT NULL DEFAULT 'active'
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_items_case_type_vocab'
    ) THEN
        ALTER TABLE evidence.items
            ADD CONSTRAINT evidence_items_case_type_vocab
            CHECK (case_type IN ('escrow','vsla','insurance','pool'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_items_status_vocab'
    ) THEN
        ALTER TABLE evidence.items
            ADD CONSTRAINT evidence_items_status_vocab
            CHECK (status IN ('active','sealed','expunged'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_items_sha256_format'
    ) THEN
        ALTER TABLE evidence.items
            ADD CONSTRAINT evidence_items_sha256_format
            CHECK (sha256 ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_items_prev_hash_format'
    ) THEN
        ALTER TABLE evidence.items
            ADD CONSTRAINT evidence_items_prev_hash_format
            CHECK (prev_hash ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_items_item_hash_format'
    ) THEN
        ALTER TABLE evidence.items
            ADD CONSTRAINT evidence_items_item_hash_format
            CHECK (item_hash ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'evidence_items_size_positive'
    ) THEN
        ALTER TABLE evidence.items
            ADD CONSTRAINT evidence_items_size_positive
            CHECK (size_bytes > 0);
    END IF;
END $$;

-- One storage object = one evidence row (confirm retries replay).
CREATE UNIQUE INDEX IF NOT EXISTS evidence_items_object_key_uniq
    ON evidence.items (object_key);

-- Per-case chain fork guard: two inserts claiming the same parent hash
-- (including the per-case genesis) collide here; the loser retries against
-- the new tip (mirrors migration 043's UNIQUE(prev_hash) on the audit chain).
CREATE UNIQUE INDEX IF NOT EXISTS evidence_items_chain_link_uniq
    ON evidence.items (case_type, case_id, prev_hash);

CREATE INDEX IF NOT EXISTS evidence_items_case_idx
    ON evidence.items (case_type, case_id, uploaded_at, id);

CREATE INDEX IF NOT EXISTS evidence_items_uploader_idx
    ON evidence.items (uploader_id, uploaded_at DESC);

COMMIT;
