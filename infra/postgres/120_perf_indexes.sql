-- no-transaction
-- P2 perf recon: indexes on hot lookup/sweep columns that currently
-- seq-scan. Every entry below was verified against migrations 001–119 (no
-- existing index whose leading columns serve the predicate).
--
-- This file carries the `-- no-transaction` first-line marker (see
-- apps/api/src/database/migrate.ts): CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block, so the runner applies each statement
-- individually without an enclosing BEGIN/COMMIT. Consequences:
--   * every statement is idempotent (IF NOT EXISTS) so a failed run can be
--     re-driven safely;
--   * a crashed CONCURRENTLY build can leave an INVALID index behind —
--     DROP INDEX IF EXISTS + re-run per docs/runbooks/ops.md (migrations).
--
-- Run during a low-traffic window: CONCURRENTLY avoids write-blocking
-- locks but still performs a full table scan per index.
--
-- NOTE: finance.ledger_accounts(code) is deliberately NOT indexed here —
-- the column carries an inline UNIQUE constraint (001_init.sql), so the
-- per-posting account lookup is already index-served.

-- identity.auth_sessions(user_id, created_at) — auth-session.pg-repository.ts
-- revokeAllForUser (logout-everywhere / PIN reset) and listForUser (ORDER BY
-- created_at) filter on user_id; existing indexes lead on
-- refresh_token_hash / family_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_sessions_user_idx
    ON identity.auth_sessions (user_id, created_at);

-- events.outbox(published_at) partial — core.pg-repository.ts
-- countPublishedBefore / anonymizePublishedBefore / purgePublishedBefore
-- (compliance retention sweeps) predicate published_at IS NOT NULL AND
-- published_at < cutoff; both existing outbox indexes are partial on
-- published_at IS NULL and cannot serve it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_published_idx
    ON events.outbox (published_at) WHERE published_at IS NOT NULL;

-- integrations.inbound_events(received_at) partial — phase3.pg-repository.ts
-- listUnprocessed poll (processed_at IS NULL, oldest first) for the webhook
-- reprocessor sweep.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_events_unprocessed_idx
    ON integrations.inbound_events (received_at) WHERE processed_at IS NULL;

-- integrations.inbound_events(processed_at) partial — phase3.pg-repository.ts
-- retention count/anonymize/purge by processed_at cutoff.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_events_processed_idx
    ON integrations.inbound_events (processed_at) WHERE processed_at IS NOT NULL;

-- finance.ledger_transfers(reference_type, reference_id, posted_at) —
-- ledger.pg-repository.ts find() journal lookup by business reference,
-- ordered by posted_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_transfers_reference_idx
    ON finance.ledger_transfers (reference_type, reference_id, posted_at);

-- finance.ledger_transfers(reverses_transfer_id) partial —
-- ledger.pg-repository.ts findReversalOf; the column was added in 003
-- without an index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_transfers_reverses_idx
    ON finance.ledger_transfers (reverses_transfer_id)
    WHERE reverses_transfer_id IS NOT NULL;

-- marketplace.offtake_milestones(escrow_id) partial —
-- offtake.pg-repository.ts milestoneByEscrowId (ORDER BY created_at DESC
-- LIMIT 1) on the escrow settlement path; escrow_id is nullable and
-- indexed nowhere (048/067 index their own tables, not milestones).
CREATE INDEX CONCURRENTLY IF NOT EXISTS offtake_milestones_escrow_idx
    ON marketplace.offtake_milestones (escrow_id) WHERE escrow_id IS NOT NULL;

-- sync.mutations(created_at) — sync.pg-repository.ts pruneOlderThan
-- retention sweep deletes oldest-first by created_at; the append-heavy
-- table otherwise seq-scans per sweep.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sync_mutations_created_idx
    ON sync.mutations (created_at);

-- agent_banking.transactions(voucher_id) partial —
-- agent-banking.pg-repository.ts find() voucher_id filter; FK added in 032
-- without an index (agent_id/farmer_id paths are already covered there).
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_banking_transactions_voucher_idx
    ON agent_banking.transactions (voucher_id) WHERE voucher_id IS NOT NULL;
