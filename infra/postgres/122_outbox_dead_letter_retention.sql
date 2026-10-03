-- 122_outbox_dead_letter_retention.sql — GAP-M20: retention policy for
-- dead-lettered outbox rows. Dead letters keep published_at NULL forever, so
-- the V-27 published-row retention handler (118) never matches them and
-- their full payloads (potentially PII) accumulate without bound — an NDPA
-- retention gap. The compliance retention sweep now supports the
-- 'events.outbox_dead_letters' entity key, keyed on dead_lettered_at:
--   * anonymize_not_delete = false (default here): the payload is tombstoned
--     to '{}' FIRST (jsonb NOT NULL — never NULL) and the row is then
--     hard-pruned 30 days after dead_lettered_at;
--   * anonymize_not_delete = true: only the payload tombstone runs and the
--     row metadata survives for redrive forensics.
-- Unpublished/unprocessed rows are NEVER matched — only rows whose relay
-- was exhausted (dead_lettered_at set). Idempotent: safe to re-apply.

BEGIN;

INSERT INTO compliance.retention_policies (entity, retain_days, anonymize_not_delete)
VALUES
    ('events.outbox_dead_letters', 30, false)
ON CONFLICT (entity) DO NOTHING;

COMMIT;
