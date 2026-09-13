-- 061_idempotency_payload_hash.sql — Stage 27 WP-G11 (V2 idempotency-consistency audit).
--
-- Same-key/different-payload misuse of a client idempotency key previously
-- REPLAYED the original record silently on the VSLA contribution, agent
-- cash-in/out, float top-up, voucher-issue and marketplace order paths —
-- the caller believed a new/different operation succeeded. Following the
-- escrow payout rail's payloadHash doctrine (048) and the Idempotency-Key
-- interceptor's request-hash envelope, each idempotency-keyed operational
-- record now stores a canonical payload fingerprint at insert time; the
-- service replays on hash equality and fails closed with 409
-- IDEMPOTENCY_PAYLOAD_MISMATCH on divergence.
--
-- marketplace.orders already carries idempotency_key (UNIQUE, 001); this
-- migration only adds the fingerprint columns. All columns are nullable so
-- pre-061 rows need no backfill — rows without a hash replay as legacy
-- records (the same doctrine as the interceptor's pre-envelope entries).
--
-- Idempotent (IF NOT EXISTS) per migration policy. No triggers, additive
-- only, no edits to merged migrations.

BEGIN;

ALTER TABLE vsla_carbon.vsla_contributions
    ADD COLUMN IF NOT EXISTS payload_hash text;

ALTER TABLE agent_banking.float_topups
    ADD COLUMN IF NOT EXISTS payload_hash text;

ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS payload_hash text;

ALTER TABLE agent_banking.transactions
    ADD COLUMN IF NOT EXISTS payload_hash text;

ALTER TABLE marketplace.orders
    ADD COLUMN IF NOT EXISTS payload_hash text;

COMMIT;
