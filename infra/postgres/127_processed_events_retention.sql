-- no-transaction
-- 127_processed_events_retention.sql — GAP-L11: retention for the
-- consumer-side idempotency ledger events.processed_events. Every other
-- durable ledger has a retention handler (118: integrations.inbound_events,
-- events.outbox; 122: events.outbox_dead_letters); the dedupe markers
-- (consumer, event_id, processed_at) accumulated without bound. The
-- compliance retention sweep now supports the 'events.processed_events'
-- entity key, keyed on processed_at. The rows carry no payload and no PII,
-- so there is nothing to anonymize — they are hard-purged past the window
-- (anonymize_not_delete has no effect for this entity). The 90-day default
-- aligns with events.outbox (118): once the outbox row itself is pruned,
-- its dedupe marker can never be consulted again. The sweeper deletes in
-- ctid-batches (PROCESSED_EVENTS_PURGE_BATCH_SIZE, default 500) and the
-- window is overridable via PROCESSED_EVENTS_RETENTION_DAYS.
--
-- This file carries the `-- no-transaction` first-line marker (see
-- apps/api/src/database/migrate.ts): CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block, so the runner applies each statement
-- individually without an enclosing BEGIN/COMMIT. Every statement is
-- idempotent, so a failed run can be re-driven safely.

-- events.processed_events(processed_at) — platform.pg-repository.ts
-- countProcessedBefore / purgeProcessedBefore (compliance retention sweep)
-- predicate processed_at < cutoff; the table's only index is the
-- (consumer, event_id) primary key, which cannot serve it. processed_at is
-- NOT NULL, so a plain (non-partial) index covers every row.
CREATE INDEX CONCURRENTLY IF NOT EXISTS processed_events_processed_at_idx
    ON events.processed_events (processed_at);

INSERT INTO compliance.retention_policies (entity, retain_days, anonymize_not_delete)
VALUES
    ('events.processed_events', 90, false)
ON CONFLICT (entity) DO NOTHING;
