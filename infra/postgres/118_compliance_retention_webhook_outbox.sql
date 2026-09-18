-- 118_compliance_retention_webhook_outbox.sql — V-27: retention policies for
-- the PII-bearing webhook/outbox payload stores.
--   * integrations.inbound_events — processed inbound webhook rows keep their
--     metadata (system, dedupe_key, received/processed timestamps) as the
--     processing audit trail; the payload is scrubbed to an empty-object
--     tombstone after 90 days (anonymize_not_delete = true; the column is
--     jsonb NOT NULL, so the tombstone is '{}', never NULL);
--   * events.outbox — published outbox rows are relay history with no
--     evidence value once delivered; rows are hard-pruned 90 days after
--     published_at (anonymize_not_delete = false).
-- Unpublished/unprocessed rows are NEVER matched by these handlers — only
-- rows whose processing completed (processed_at / published_at set).
-- Idempotent: safe to re-apply.

BEGIN;

INSERT INTO compliance.retention_policies (entity, retain_days, anonymize_not_delete)
VALUES
    ('integrations.inbound_events', 90, true),
    ('events.outbox', 90, false)
ON CONFLICT (entity) DO NOTHING;

COMMIT;
