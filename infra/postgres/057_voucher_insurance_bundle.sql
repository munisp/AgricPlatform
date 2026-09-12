-- 057_voucher_insurance_bundle.sql — Insurance-in-the-Bag (Stage 27,
-- innovation 3): micro-parametric cover bundled onto input-voucher
-- redemptions (assumes 031 insurance schema + 035/046 input-voucher
-- envelope/funded-float schema applied).
--
-- 1. insurance.programme_riders — one rider per subsidy programme
--    (UNIQUE programme_id). The sponsor defines the bundled product:
--    catalog product code (trigger type), sum insured within the rate-card
--    bounds (₦1,000 … ₦1,000,000 = 100_000 … 100_000_000 kobo) and the
--    premium rate in basis points (bounded, mirrors the premium.ts rate
--    card). flood_band is captured at rider-definition time so redemption-
--    time pricing is deterministic (the stub flood driver is never
--    consulted on the money path).
--
-- 2. insurance.voucher_covers — one cover per voucher (UNIQUE voucher_id,
--    mirroring the redemptions anti-double-spend constraint): the bind is
--    exactly-once per voucher no matter how often redemption resumes. The
--    premium is debited from the programme's encumbered envelope in the
--    SAME ledger entry as the voucher redemption (envelope split:
--    supplier receivable + insurer premium payable = face value), so no
--    cover can exist without its premium posting. cover_basis is stamped
--    honestly: 'stub' while the weather provider is the deterministic
--    stub; the payout leg stays externally gated (insurer MOU) — trigger
--    evaluation and payout confirmation flow through the existing
--    fail-closed insurance module path.
--
-- Status machine: quoted (transient — pricing is atomic with binding, so
-- persisted rows start at 'bound') -> bound -> triggered -> paid, or
-- bound -> expired. Transitions are projected from the policy lifecycle
-- events (insurance.trigger.raised / insurance.payout.paid) by the
-- application; no triggers here per repo convention.
--
-- Idempotent per migration policy: IF NOT EXISTS DDL throughout, CHECK
-- constraints inline on CREATE TABLE (no unguarded ADD CONSTRAINT), no
-- triggers.

BEGIN;

CREATE TABLE IF NOT EXISTS insurance.programme_riders (
    id                 text PRIMARY KEY,
    programme_id       text NOT NULL REFERENCES input_vouchers.programmes(id),
    product_code       text NOT NULL,
    sum_insured_kobo   bigint NOT NULL
                       CHECK (sum_insured_kobo >= 100000 AND sum_insured_kobo <= 100000000),
    premium_rate_bps   integer NOT NULL
                       CHECK (premium_rate_bps > 0 AND premium_rate_bps <= 10000),
    flood_band         text NOT NULL DEFAULT 'none'
                       CHECK (flood_band IN ('none','low','moderate','high','severe')),
    status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended')),
    created_by         text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_programme_riders_programme_uq
    ON insurance.programme_riders (programme_id);

CREATE TABLE IF NOT EXISTS insurance.voucher_covers (
    id            text PRIMARY KEY,
    voucher_id    text NOT NULL REFERENCES input_vouchers.vouchers(id),
    policy_id     text NOT NULL,
    programme_id  text NOT NULL REFERENCES input_vouchers.programmes(id),
    plot_id       text NOT NULL,
    farmer_id     text NOT NULL,
    premium_kobo  bigint NOT NULL CHECK (premium_kobo > 0),
    cover_basis   text NOT NULL CHECK (cover_basis IN ('stub','live')),
    status        text NOT NULL DEFAULT 'bound'
                  CHECK (status IN ('quoted','bound','expired','triggered','paid')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_voucher_covers_voucher_uq
    ON insurance.voucher_covers (voucher_id);
CREATE UNIQUE INDEX IF NOT EXISTS insurance_voucher_covers_policy_uq
    ON insurance.voucher_covers (policy_id);
CREATE INDEX IF NOT EXISTS insurance_voucher_covers_programme_idx
    ON insurance.voucher_covers (programme_id, created_at);
CREATE INDEX IF NOT EXISTS insurance_voucher_covers_farmer_idx
    ON insurance.voucher_covers (farmer_id, created_at);

COMMIT;
