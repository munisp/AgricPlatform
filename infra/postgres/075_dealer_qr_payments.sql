-- 075_dealer_qr_payments.sql — Stage 27 Innovation 16 "Dealer QR Pay"
-- (agent_banking schema).
--
-- Mojaloop merchant payments at agro-dealers: a dealer (an ACTIVE agent —
-- the merchant registry reuses the agent organisation model from migration
-- 032) displays an HMAC-signed QR/intent code; a farmer pays (or co-pays a
-- signed offline-voucher balance) from a Mojaloop-connected wallet, and the
-- settlement posts straight into the dealer's ledger receivable
-- (dealer:<agentId>:receivable) ONLY after a switch-confirmed transfer.
--
-- Money movement is NOT stored here: every value transfer posts through the
-- double-entry ledger (finance schema). These tables hold operational
-- records only and reference ledger journal entries by id.
--
-- Idempotency doctrine:
--   - mojaloop_transfer_id is UNIQUE — the switch-level transfer id is the
--     idempotency key for settlement, so a redelivered confirmation
--     (webhook/poller replay) is a no-op, never a double settlement.
--   - idempotency_key carries the client key for POST .../qr/:code/pay
--     (partial UNIQUE, mirroring the 038/042 voucher/top-up pattern) so a
--     transport retry replays the original payment instead of duplicating
--     a money-bearing request.
--   - CHECK (voucher_tender_kobo + wallet_tender_kobo = amount_kobo) pins
--     the co-pay split invariant at the database boundary (integer kobo).
--
-- Idempotent per repo policy (IF NOT EXISTS). No triggers — updated_at is
-- maintained by application code, per repo convention.

BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_banking;

-- Merchant QR/intent codes. payload_hmac is the HMAC-SHA256 over the
-- canonical signed payload {version, qrId, agentOrgId, dealerUserId, label,
-- issuedAt} (voucher-crypto pattern, server-side secret AGENT_QR_SECRET);
-- verification happens server-side only. Status machine: active | revoked.
CREATE TABLE IF NOT EXISTS agent_banking.merchant_qr_codes (
    id              text PRIMARY KEY,
    agent_org_id    text NOT NULL REFERENCES agent_banking.agents(id),
    dealer_user_id  text NOT NULL REFERENCES identity.users(id),
    payload_hmac    text NOT NULL,
    label           text NOT NULL,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','revoked')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_qr_codes_agent_idx
    ON agent_banking.merchant_qr_codes (agent_org_id, status);

-- Merchant payments. Status machine: quoted -> completed | failed
-- (refunded is reserved for a future reversal flow; nothing transitions
-- into it in v1). mojaloop_transfer_id is NULL until the transfer leg is
-- prepared and UNIQUE once set — it is the settlement idempotency key.
-- adapter_basis records which driver produced the quote/transfer (stub |
-- simulator | live): a stub-backed row can NEVER reach completed (fail
-- closed — no QR payment completes without a switch-confirmed transfer).
CREATE TABLE IF NOT EXISTS agent_banking.merchant_payments (
    id                      text PRIMARY KEY,
    qr_id                   text NOT NULL REFERENCES agent_banking.merchant_qr_codes(id),
    mojaloop_transfer_id    text,
    amount_kobo             bigint NOT NULL CHECK (amount_kobo > 0),
    voucher_id              text REFERENCES agent_banking.vouchers(id),
    payer_alias_hmac        text,
    status                  text NOT NULL DEFAULT 'quoted'
                            CHECK (status IN ('quoted','completed','failed','refunded')),
    payer_user_id           text NOT NULL REFERENCES identity.users(id),
    quote_id                text,
    voucher_tender_kobo     bigint NOT NULL DEFAULT 0 CHECK (voucher_tender_kobo >= 0),
    wallet_tender_kobo      bigint NOT NULL DEFAULT 0 CHECK (wallet_tender_kobo >= 0),
    adapter_basis           text NOT NULL
                            CHECK (adapter_basis IN ('stub','simulator','live')),
    idempotency_key         text,
    ledger_entry_id         text,
    failure_reason          text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    completed_at            timestamptz,
    UNIQUE (mojaloop_transfer_id),
    CHECK (voucher_tender_kobo + wallet_tender_kobo = amount_kobo)
);

-- Client idempotency key for the pay endpoint (partial UNIQUE, mirroring
-- the 038 voucher pattern): replays return the original payment row.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_payments_idempotency_idx
    ON agent_banking.merchant_payments (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS merchant_payments_qr_idx
    ON agent_banking.merchant_payments (qr_id, status);

CREATE INDEX IF NOT EXISTS merchant_payments_payer_idx
    ON agent_banking.merchant_payments (payer_user_id, status);

COMMIT;
