-- 025_credit.sql — Wave CREDIT: microfinance suite (best-of-both merge of
-- farmer-data-collection credit/chama/savings domains into AgricPlatform).
--
-- New schema `credit` with the core loan lifecycle subset:
--   loan_products, loan_applications, loan_repayments, collateral,
--   guarantors, credit_groups, credit_group_members, savings_accounts,
--   savings_transactions.
--
-- Conventions:
--   - Money is bigint kobo with CHECK >= 0 (or > 0) — never floats.
--   - User references are text FKs to identity.users(id).
--   - Disbursement is a recorded event here; actual money movement stays
--     with the hardened funds/escrow flow (no changes to those modules).
-- Idempotent (IF NOT EXISTS throughout) per migration policy.

BEGIN;

CREATE SCHEMA IF NOT EXISTS credit;

-- ---------------------------------------------------------------------------
-- Loan products (admin-managed catalogue, publicly listable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.loan_products (
    id                  text PRIMARY KEY,
    name                text NOT NULL,
    min_principal_kobo  bigint NOT NULL CHECK (min_principal_kobo >= 0),
    max_principal_kobo  bigint NOT NULL CHECK (max_principal_kobo >= 0),
    interest_bps_annual integer NOT NULL CHECK (interest_bps_annual >= 0),
    term_days           integer NOT NULL CHECK (term_days > 0),
    group_lending       boolean NOT NULL DEFAULT false,
    active              boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (max_principal_kobo >= min_principal_kobo)
);

-- ---------------------------------------------------------------------------
-- VSLA / chama groups + members (composite PK on membership)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.credit_groups (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    chapter_id  text,
    created_by  text NOT NULL REFERENCES identity.users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit.credit_group_members (
    group_id    text NOT NULL REFERENCES credit.credit_groups(id) ON DELETE CASCADE,
    user_id     text NOT NULL REFERENCES identity.users(id),
    role        text NOT NULL DEFAULT 'member'
                CHECK (role IN ('member','leader')),
    joined_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS credit_group_members_user_idx
    ON credit.credit_group_members (user_id);

-- ---------------------------------------------------------------------------
-- Loan applications (state machine: draft → submitted → scoring →
-- approved/rejected → disbursed → repaying → repaid/defaulted → written_off)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.loan_applications (
    id                  text PRIMARY KEY,
    applicant_user_id   text NOT NULL REFERENCES identity.users(id),
    product_id          text NOT NULL REFERENCES credit.loan_products(id),
    principal_kobo      bigint NOT NULL CHECK (principal_kobo > 0),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','scoring','approved',
                                          'rejected','disbursed','repaying','repaid',
                                          'defaulted','written_off')),
    credit_score        integer CHECK (credit_score BETWEEN 0 AND 1000),
    score_factors       jsonb,
    purpose             text,
    group_id            text REFERENCES credit.credit_groups(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    decided_at          timestamptz,
    decided_by          text
);
CREATE INDEX IF NOT EXISTS loan_applications_applicant_idx
    ON credit.loan_applications (applicant_user_id);
CREATE INDEX IF NOT EXISTS loan_applications_status_idx
    ON credit.loan_applications (status);
CREATE INDEX IF NOT EXISTS loan_applications_group_idx
    ON credit.loan_applications (group_id) WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Repayment schedule (equal installments generated at approval)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.loan_repayments (
    id                  text PRIMARY KEY,
    loan_id             text NOT NULL REFERENCES credit.loan_applications(id) ON DELETE CASCADE,
    sequence            integer NOT NULL CHECK (sequence > 0),
    due_at              timestamptz NOT NULL,
    amount_kobo         bigint NOT NULL CHECK (amount_kobo >= 0),
    paid_at             timestamptz,
    paid_amount_kobo    bigint CHECK (paid_amount_kobo >= 0),
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','late','missed')),
    UNIQUE (loan_id, sequence)
);
CREATE INDEX IF NOT EXISTS loan_repayments_loan_idx
    ON credit.loan_repayments (loan_id);
-- Overdue-scan index for PAR reporting (read-time late marking).
CREATE INDEX IF NOT EXISTS loan_repayments_due_idx
    ON credit.loan_repayments (due_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Collateral pledged against a loan
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.collateral (
    id                      text PRIMARY KEY,
    loan_id                 text NOT NULL REFERENCES credit.loan_applications(id) ON DELETE CASCADE,
    kind                    text NOT NULL,
    description             text NOT NULL,
    estimated_value_kobo    bigint NOT NULL CHECK (estimated_value_kobo >= 0),
    status                  text NOT NULL DEFAULT 'pledged'
                            CHECK (status IN ('pledged','released','claimed'))
);
CREATE INDEX IF NOT EXISTS collateral_loan_idx ON credit.collateral (loan_id);

-- ---------------------------------------------------------------------------
-- Guarantors (also carries group-loan co-obligors as 'accepted' rows)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.guarantors (
    id                  text PRIMARY KEY,
    loan_id             text NOT NULL REFERENCES credit.loan_applications(id) ON DELETE CASCADE,
    guarantor_user_id   text NOT NULL REFERENCES identity.users(id),
    status              text NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited','accepted','declined')),
    UNIQUE (loan_id, guarantor_user_id)
);
CREATE INDEX IF NOT EXISTS guarantors_loan_idx ON credit.guarantors (loan_id);
CREATE INDEX IF NOT EXISTS guarantors_user_idx ON credit.guarantors (guarantor_user_id);

-- ---------------------------------------------------------------------------
-- Savings accounts (personal or VSLA group; exactly one owner kind)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.savings_accounts (
    id              text PRIMARY KEY,
    user_id         text REFERENCES identity.users(id),
    group_id        text REFERENCES credit.credit_groups(id),
    balance_kobo    bigint NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((user_id IS NOT NULL AND group_id IS NULL)
        OR (user_id IS NULL AND group_id IS NOT NULL))
);
-- One account per user / per group (partial unique indexes keep NULLs free).
CREATE UNIQUE INDEX IF NOT EXISTS savings_accounts_user_uniq
    ON credit.savings_accounts (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS savings_accounts_group_uniq
    ON credit.savings_accounts (group_id) WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Savings transactions (append-only; ref is the idempotency key)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit.savings_transactions (
    id                  text PRIMARY KEY,
    account_id          text NOT NULL REFERENCES credit.savings_accounts(id),
    direction           text NOT NULL CHECK (direction IN ('deposit','withdrawal')),
    amount_kobo         bigint NOT NULL CHECK (amount_kobo > 0),
    balance_after_kobo  bigint NOT NULL CHECK (balance_after_kobo >= 0),
    ref                 text NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS savings_transactions_account_idx
    ON credit.savings_transactions (account_id);

COMMIT;
