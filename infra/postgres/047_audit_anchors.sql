-- 047_audit_anchors.sql — anchoring checkpoints for the tamper-evident
-- audit hash chain (Stage 23, closes the migration 043 residual).
--
-- Migration 043 made the event chain fork-proof, but documented the
-- remaining hole: an attacker (or bug) with DB write can TRUNCATE/DELETE the
-- chain tail and re-extend from an earlier prefix — the shortened chain is
-- still internally valid and nothing detects the missing tail events.
--
-- This migration adds audit.anchors: periodic checkpoints that notarize the
-- chain tip (event id + tip hash + event count) at anchor time. Anchors form
-- their own hash chain (prev_anchor_hash → anchor_hash, genesis = 64 zeros)
-- so anchor history itself is tamper-evident, and UNIQUE(prev_anchor_hash)
-- serializes anchor creation the same way 043 serializes event appends.
-- Verification compares the live chain against the latest anchor: a missing
-- anchor-tip event, a mismatched tip hash, or an event-count regression is
-- reported as a truncation gap.
--
-- anchored_through_event_id is a soft reference (no enforced FK) to
-- admin.audit_events: a hard FK would block legitimate administrative
-- cleanup/retention deletes of anchored rows, and detection — not write
-- blocking — is the checkpoint's job. The column is NULL for a genesis
-- anchor taken over an empty chain.
--
-- BOUND (honest residual): anchors that live only in this same database
-- bound the truncation window to the last checkpoint but do not eliminate it
-- — an attacker with DB write can still delete the anchors themselves. Ship
-- anchors off-box (AUDIT_ANCHOR_SINK=file:<path> JSONL, or a fully external
-- anchoring service / timestamping authority) to close that window; the
-- external anchor is an ops follow-up.
--
-- Idempotent per migration policy (IF NOT EXISTS / guarded DO blocks).

BEGIN;

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.anchors (
    id                        uuid PRIMARY KEY,
    anchored_through_event_id text,               -- chain tip event id; NULL = empty-chain anchor
    tip_hash                  char(64) NOT NULL,  -- hash of the tip event (genesis = 64 zeros)
    event_count               bigint NOT NULL,    -- chain length at anchor time
    prev_anchor_hash          char(64) NOT NULL,  -- previous anchor in the anchor chain
    anchor_hash               char(64) NOT NULL,  -- sha256(canonicalJSON(payload) + prev_anchor_hash)
    created_at                timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anchors_tip_hash_format'
    ) THEN
        ALTER TABLE audit.anchors
            ADD CONSTRAINT anchors_tip_hash_format
            CHECK (tip_hash ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anchors_prev_anchor_hash_format'
    ) THEN
        ALTER TABLE audit.anchors
            ADD CONSTRAINT anchors_prev_anchor_hash_format
            CHECK (prev_anchor_hash ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anchors_anchor_hash_format'
    ) THEN
        ALTER TABLE audit.anchors
            ADD CONSTRAINT anchors_anchor_hash_format
            CHECK (anchor_hash ~ '^[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anchors_event_count_nonnegative'
    ) THEN
        ALTER TABLE audit.anchors
            ADD CONSTRAINT anchors_event_count_nonnegative
            CHECK (event_count >= 0);
    END IF;
END $$;

-- Anchor-chain fork rejection: one child per parent anchor hash. Concurrent
-- anchor creation claiming the same parent collides here (SQLSTATE 23505)
-- and the loser retries against the new tip, mirroring 043's event guard.
CREATE UNIQUE INDEX IF NOT EXISTS audit_anchors_prev_anchor_hash_uniq
    ON audit.anchors (prev_anchor_hash);

CREATE INDEX IF NOT EXISTS audit_anchors_time_idx
    ON audit.anchors (created_at DESC);

COMMIT;
