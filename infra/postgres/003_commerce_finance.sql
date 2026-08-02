-- 003_commerce_finance.sql — Wave P2a: Produce Marketplace depth
-- (escrow, invoicing, logistics) + Finance/Credit (ledger hardening,
-- versioned credit scores, lender directory, loan workflows).
-- Idempotent (IF NOT EXISTS throughout) per migration policy; 001/002 stay
-- untouched. Text PKs match the app-generated id contract ('escrow-<uuid>',
-- 'loan-<uuid>', …). Cross-domain references stay plain text columns (no
-- cross-schema foreign keys); intra-schema FKs reference 001_init.sql tables.

BEGIN;

-- ---------------------------------------------------------------------------
-- marketplace: escrow records (HELD → RELEASED | REFUNDED | DISPUTED)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.escrow_records (
    id              text PRIMARY KEY,
    order_id        text NOT NULL UNIQUE REFERENCES marketplace.orders(id),
    amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
    status          text NOT NULL DEFAULT 'held'
                    CHECK (status IN ('held','released','refunded','disputed')),
    provider_reference text,                 -- opaque payment-provider reference
    held_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escrow_records_status_idx ON marketplace.escrow_records (status);

-- ---------------------------------------------------------------------------
-- marketplace: invoicing (per-seller number sequence, VAT 7.5%, kobo totals)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.invoice_counters (
    seller_id       text PRIMARY KEY,
    next            integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS marketplace.invoices (
    id              text PRIMARY KEY,
    invoice_number  text UNIQUE NOT NULL,    -- INV-<seller>-000042
    order_id        text NOT NULL REFERENCES marketplace.orders(id),
    seller_id       text NOT NULL,
    buyer_id        text NOT NULL,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','issued','paid','cancelled')),
    currency        char(3) NOT NULL DEFAULT 'NGN',
    subtotal_kobo   bigint NOT NULL CHECK (subtotal_kobo >= 0),
    vat_kobo        bigint NOT NULL CHECK (vat_kobo >= 0),
    total_kobo      bigint NOT NULL CHECK (total_kobo >= 0),
    line_items      jsonb NOT NULL DEFAULT '[]'::jsonb,
    issued_at       timestamptz,
    paid_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_seller_idx ON marketplace.invoices (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_buyer_idx ON marketplace.invoices (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_order_idx ON marketplace.invoices (order_id);

-- ---------------------------------------------------------------------------
-- marketplace: logistics coordination (one shipment per order)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.shipments (
    id              text PRIMARY KEY,
    order_id        text NOT NULL UNIQUE REFERENCES marketplace.orders(id),
    status          text NOT NULL DEFAULT 'pickup_scheduled'
                    CHECK (status IN ('pickup_scheduled','in_transit','delivered','confirmed','failed')),
    carrier         text,
    tracking_reference text,
    scheduled_pickup_at timestamptz,
    picked_up_at    timestamptz,
    delivered_at    timestamptz,
    confirmed_at    timestamptz,
    failure_reason  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipments_status_idx ON marketplace.shipments (status);

-- ---------------------------------------------------------------------------
-- finance: versioned credit scores (credit-score/v1, deterministic)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.credit_scores (
    user_id         text PRIMARY KEY,
    version         text NOT NULL,
    score           smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
    components      jsonb NOT NULL DEFAULT '{}'::jsonb,
    computed_at     timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- finance: lender directory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.lenders (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    product         text NOT NULL,
    min_ticket_kobo bigint NOT NULL CHECK (min_ticket_kobo >= 0),
    max_ticket_kobo bigint NOT NULL CHECK (max_ticket_kobo >= min_ticket_kobo),
    min_score       smallint NOT NULL DEFAULT 0 CHECK (min_score BETWEEN 0 AND 100),
    criteria        text[] NOT NULL DEFAULT '{}',
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lenders_active_idx ON finance.lenders (is_active, min_score);

-- ---------------------------------------------------------------------------
-- finance: loan applications + equal-installment repayment calendar
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.loan_applications (
    id              text PRIMARY KEY,
    applicant_id    text NOT NULL,
    lender_id       text NOT NULL REFERENCES finance.lenders(id),
    product_name    text,
    amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
    term_months     integer NOT NULL CHECK (term_months > 0),
    annual_rate_bps integer NOT NULL CHECK (annual_rate_bps >= 0),
    purpose         text,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','submitted','under_review','approved',
                                      'declined','disbursed','repaying','closed','defaulted')),
    submitted_at    timestamptz,
    decided_at      timestamptz,
    disbursed_at    timestamptz,
    closed_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_applications_applicant_idx
    ON finance.loan_applications (applicant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS loan_applications_status_idx ON finance.loan_applications (status);

CREATE TABLE IF NOT EXISTS finance.repayment_installments (
    id              text PRIMARY KEY,
    loan_id         text NOT NULL REFERENCES finance.loan_applications(id) ON DELETE CASCADE,
    sequence        integer NOT NULL CHECK (sequence > 0),
    due_date        date NOT NULL,
    principal_kobo  bigint NOT NULL CHECK (principal_kobo > 0),
    interest_kobo   bigint NOT NULL CHECK (interest_kobo >= 0),
    total_kobo      bigint NOT NULL CHECK (total_kobo = principal_kobo + interest_kobo),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','late')),
    paid_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (loan_id, sequence)
);
CREATE INDEX IF NOT EXISTS repayment_installments_loan_idx
    ON finance.repayment_installments (loan_id, sequence);

-- Reversal linkage for counter-entries (posting immutability: corrections
-- append a reversal entry referencing the original, never UPDATE/DELETE).
ALTER TABLE finance.ledger_transfers
    ADD COLUMN IF NOT EXISTS reverses_transfer_id uuid REFERENCES finance.ledger_transfers(id);

-- ---------------------------------------------------------------------------
-- finance: double-entry ledger hardening (tables from 001_init.sql)
--
-- The SUM(debits) = SUM(credits) invariant is enforced by the API before any
-- entry is inserted and remains verifiable in SQL through
-- finance.transfer_is_balanced() (001). A deferred constraint trigger is the
-- intended second line of defence but cannot be expressed in linted
-- migrations (pgsql-ast-parser does not parse CREATE TRIGGER); until it is
-- applied out-of-band, this view surfaces any violation for monitoring.
-- Journal postings are immutable at the API layer: corrections only ever
-- append reversal entries, never UPDATE/DELETE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW finance.unbalanced_transfers AS
    SELECT transfer_id,
           COALESCE(sum(amount_kobo) FILTER (WHERE direction = 'debit'), 0)  AS debits_kobo,
           COALESCE(sum(amount_kobo) FILTER (WHERE direction = 'credit'), 0) AS credits_kobo
      FROM finance.ledger_entries
     GROUP BY transfer_id
    HAVING COALESCE(sum(amount_kobo) FILTER (WHERE direction = 'debit'), 0)
        <> COALESCE(sum(amount_kobo) FILTER (WHERE direction = 'credit'), 0);

-- Platform ledger accounts used by loan disbursement / repayment posting.
-- Codes are the natural keys referenced by the API (owner_id stays NULL for
-- platform accounts).
INSERT INTO finance.ledger_accounts (code, account_type) VALUES
    ('platform:cash', 'asset'),
    ('platform:interest_income', 'revenue')
ON CONFLICT (code) DO NOTHING;

COMMIT;
