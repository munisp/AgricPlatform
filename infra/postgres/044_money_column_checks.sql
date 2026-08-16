-- 044_money_column_checks.sql — CHECK constraints on money/quantity columns
-- beyond agent_banking (041 covers those). Money columns created by 001, 004,
-- 035 and 037 accepted zero/negative amounts; these CHECKs fail closed at the
-- database layer so a buggy caller can never persist a negative or zero
-- amount where the domain forbids it.
-- Idempotent per migration policy: the sanctioned DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT pattern from 016_funds_hardening.sql (PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS).
--
-- Nullability (verified against the source migrations):
--   marketplace.listings.price_ngn          NULL    (001_init.sql:477)
--   marketplace.buyer_requests.max_price_ngn NULL   (001_init.sql:496)
--   marketplace.orders.quantity             NOT NULL (001_init.sql:510)
--   marketplace.orders.total_naira          NOT NULL (001_init.sql:511)
--   services.offerings.price_naira          NOT NULL (004_engagement.sql:38)
--   services.bookings.quantity              NOT NULL (004_engagement.sql:52)
--   services.bookings.total_naira           NULL    (004_engagement.sql:53)
-- (SQL CHECK is satisfied by NULL, so the IS NULL OR … spelling on nullable
-- columns is documentation-grade explicitness, not a semantic requirement.)

BEGIN;

-- input_vouchers wave (035_input_vouchers.sql) -------------------------------
ALTER TABLE input_vouchers.programmes
    DROP CONSTRAINT IF EXISTS programmes_per_farmer_cap_kobo_check;
ALTER TABLE input_vouchers.programmes
    ADD CONSTRAINT programmes_per_farmer_cap_kobo_check
    CHECK (per_farmer_cap_kobo > 0);

ALTER TABLE input_vouchers.programmes
    DROP CONSTRAINT IF EXISTS programmes_budget_kobo_check;
ALTER TABLE input_vouchers.programmes
    ADD CONSTRAINT programmes_budget_kobo_check
    CHECK (budget_kobo > 0);

ALTER TABLE input_vouchers.vouchers
    DROP CONSTRAINT IF EXISTS vouchers_amount_kobo_check;
ALTER TABLE input_vouchers.vouchers
    ADD CONSTRAINT vouchers_amount_kobo_check
    CHECK (amount_kobo > 0);

ALTER TABLE input_vouchers.redemptions
    DROP CONSTRAINT IF EXISTS redemptions_amount_kobo_check;
ALTER TABLE input_vouchers.redemptions
    ADD CONSTRAINT redemptions_amount_kobo_check
    CHECK (amount_kobo > 0);

-- VSLA wave (037_vsla_carbon.sql) --------------------------------------------
ALTER TABLE vsla_carbon.vsla_contributions
    DROP CONSTRAINT IF EXISTS vsla_contributions_amount_kobo_check;
ALTER TABLE vsla_carbon.vsla_contributions
    ADD CONSTRAINT vsla_contributions_amount_kobo_check
    CHECK (amount_kobo > 0);

ALTER TABLE vsla_carbon.vsla_share_outs
    DROP CONSTRAINT IF EXISTS vsla_share_outs_share_kobo_check;
ALTER TABLE vsla_carbon.vsla_share_outs
    ADD CONSTRAINT vsla_share_outs_share_kobo_check
    CHECK (share_kobo >= 0);

ALTER TABLE vsla_carbon.vsla_share_outs
    DROP CONSTRAINT IF EXISTS vsla_share_outs_contributed_kobo_check;
ALTER TABLE vsla_carbon.vsla_share_outs
    ADD CONSTRAINT vsla_share_outs_contributed_kobo_check
    CHECK (contributed_kobo >= 0);

ALTER TABLE vsla_carbon.vsla_share_outs
    DROP CONSTRAINT IF EXISTS vsla_share_outs_residual_kobo_check;
ALTER TABLE vsla_carbon.vsla_share_outs
    ADD CONSTRAINT vsla_share_outs_residual_kobo_check
    CHECK (residual_kobo >= 0);

ALTER TABLE vsla_carbon.vsla_loans
    DROP CONSTRAINT IF EXISTS vsla_loans_principal_kobo_check;
ALTER TABLE vsla_carbon.vsla_loans
    ADD CONSTRAINT vsla_loans_principal_kobo_check
    CHECK (principal_kobo > 0);

ALTER TABLE vsla_carbon.vsla_loans
    DROP CONSTRAINT IF EXISTS vsla_loans_interest_rate_bps_check;
ALTER TABLE vsla_carbon.vsla_loans
    ADD CONSTRAINT vsla_loans_interest_rate_bps_check
    CHECK (interest_rate_bps >= 0);

ALTER TABLE vsla_carbon.vsla_loans
    DROP CONSTRAINT IF EXISTS vsla_loans_total_due_kobo_check;
ALTER TABLE vsla_carbon.vsla_loans
    ADD CONSTRAINT vsla_loans_total_due_kobo_check
    CHECK (total_due_kobo > 0);

-- Single CHECK for the repayment invariant: never negative, never more than
-- the total due.
ALTER TABLE vsla_carbon.vsla_loans
    DROP CONSTRAINT IF EXISTS vsla_loans_repaid_kobo_check;
ALTER TABLE vsla_carbon.vsla_loans
    ADD CONSTRAINT vsla_loans_repaid_kobo_check
    CHECK (repaid_kobo >= 0 AND repaid_kobo <= total_due_kobo);

ALTER TABLE vsla_carbon.vsla_loan_repayments
    DROP CONSTRAINT IF EXISTS vsla_loan_repayments_amount_kobo_check;
ALTER TABLE vsla_carbon.vsla_loan_repayments
    ADD CONSTRAINT vsla_loan_repayments_amount_kobo_check
    CHECK (amount_kobo > 0);

-- Naira-denominated marketplace core (001_init.sql) --------------------------
ALTER TABLE marketplace.listings
    DROP CONSTRAINT IF EXISTS listings_price_ngn_check;
ALTER TABLE marketplace.listings
    ADD CONSTRAINT listings_price_ngn_check
    CHECK (price_ngn IS NULL OR price_ngn >= 0);

ALTER TABLE marketplace.buyer_requests
    DROP CONSTRAINT IF EXISTS buyer_requests_max_price_ngn_check;
ALTER TABLE marketplace.buyer_requests
    ADD CONSTRAINT buyer_requests_max_price_ngn_check
    CHECK (max_price_ngn IS NULL OR max_price_ngn >= 0);

ALTER TABLE marketplace.orders
    DROP CONSTRAINT IF EXISTS orders_quantity_check;
ALTER TABLE marketplace.orders
    ADD CONSTRAINT orders_quantity_check
    CHECK (quantity > 0);

ALTER TABLE marketplace.orders
    DROP CONSTRAINT IF EXISTS orders_total_naira_check;
ALTER TABLE marketplace.orders
    ADD CONSTRAINT orders_total_naira_check
    CHECK (total_naira >= 0);

-- Services engagement (004_engagement.sql) -----------------------------------
ALTER TABLE services.offerings
    DROP CONSTRAINT IF EXISTS offerings_price_naira_check;
ALTER TABLE services.offerings
    ADD CONSTRAINT offerings_price_naira_check
    CHECK (price_naira >= 0);

ALTER TABLE services.bookings
    DROP CONSTRAINT IF EXISTS bookings_quantity_check;
ALTER TABLE services.bookings
    ADD CONSTRAINT bookings_quantity_check
    CHECK (quantity > 0);

ALTER TABLE services.bookings
    DROP CONSTRAINT IF EXISTS bookings_total_naira_check;
ALTER TABLE services.bookings
    ADD CONSTRAINT bookings_total_naira_check
    CHECK (total_naira >= 0);

COMMIT;
