-- 037_vsla_carbon.sql — wave VSLACARBON "VSLA groups + carbon MRV" (vsla_carbon schema).
-- Village savings & loan association (VSLA) groups with savings cycles,
-- ledger-backed member contributions, deterministic share-outs and small
-- internal loans — plus carbon MRV for agroforestry/conservation practice
-- plots with seasonal evidence and clearly-labelled ESTIMATE carbon figures.
--
-- Money movement is NOT stored here: every value transfer posts through the
-- double-entry ledger (finance schema, wave P2a). These tables hold the
-- operational records (groups, membership, cycles, contributions, loans,
-- plots, evidence, estimates) that reference ledger journal entries by id.
-- Carbon figures are ESTIMATES from a versioned coefficient table — never
-- verification-grade credits (see docs/vsla-carbon-mrv.md).
--
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-apply. No triggers, no PostGIS — H3 cells are computed in the app
-- layer (h3-js) and stored as text, per repo convention.

BEGIN;

CREATE SCHEMA IF NOT EXISTS vsla_carbon;

-- VSLA group registry. Optionally chapter-linked (chapters model, wave P1);
-- chapter_id is nullable so standalone groups are valid. savings_account_code
-- is the group's pooled-cash ledger sub-account (vsla:<id>:cash) — the money
-- itself is a ledger concept, not a parallel store.
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_groups (
    id                              text PRIMARY KEY,
    name                            text NOT NULL,
    chapter_id                      text,
    lead_user_id                    text NOT NULL,
    status                          text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | DISSOLVED
    savings_account_code            text NOT NULL UNIQUE,
    loans_receivable_account_code   text NOT NULL UNIQUE,
    interest_income_account_code    text NOT NULL UNIQUE,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_carbon_groups_chapter_idx
    ON vsla_carbon.vsla_groups (chapter_id);

CREATE INDEX IF NOT EXISTS vsla_carbon_groups_status_idx
    ON vsla_carbon.vsla_groups (status);

-- Group membership. A member's contributions credit the per-member liability
-- ledger account vsla:<group>:member:<user> so share-outs reconcile against
-- the ledger. Unique (group_id, user_id) keeps re-joins idempotent.
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_members (
    id          text PRIMARY KEY,
    group_id    text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    user_id     text NOT NULL,
    role        text NOT NULL DEFAULT 'member',  -- member | lead
    status      text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | EXITED
    joined_at   timestamptz NOT NULL DEFAULT now(),
    exited_at   timestamptz,
    UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS vsla_carbon_members_user_idx
    ON vsla_carbon.vsla_members (user_id);

-- Savings cycles. At most one OPEN cycle per group (partial unique index);
-- closing computes the deterministic pro-rata share-out and posts the ledger
-- entries (share_out_ledger_entry_ids are recorded per member payout row).
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_cycles (
    id              text PRIMARY KEY,
    group_id        text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    label           text NOT NULL,
    status          text NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED
    opened_at       timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vsla_carbon_cycles_one_open_idx
    ON vsla_carbon.vsla_cycles (group_id) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS vsla_carbon_cycles_group_idx
    ON vsla_carbon.vsla_cycles (group_id, status);

-- Member contributions into the open cycle. The UNIQUE idempotency key makes
-- transport retries replay instead of double-posting; every contribution is
-- cross-referenced to its ledger journal entry.
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_contributions (
    id                  text PRIMARY KEY,
    cycle_id            text NOT NULL REFERENCES vsla_carbon.vsla_cycles(id),
    group_id            text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    member_id           text NOT NULL REFERENCES vsla_carbon.vsla_members(id),
    amount_kobo         bigint NOT NULL,
    idempotency_key     text NOT NULL UNIQUE,
    ledger_entry_id     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_carbon_contributions_cycle_idx
    ON vsla_carbon.vsla_contributions (cycle_id);

CREATE INDEX IF NOT EXISTS vsla_carbon_contributions_member_idx
    ON vsla_carbon.vsla_contributions (member_id);

-- Per-member share-out payout rows written at cycle close. share_kobo is the
-- deterministic pro-rata amount (largest-remainder conservation); the
-- residual liability stays on the member's ledger account when loans are
-- still outstanding against the pool.
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_share_outs (
    id                  text PRIMARY KEY,
    cycle_id            text NOT NULL REFERENCES vsla_carbon.vsla_cycles(id),
    member_id           text NOT NULL REFERENCES vsla_carbon.vsla_members(id),
    share_kobo          bigint NOT NULL,
    contributed_kobo    bigint NOT NULL,
    residual_kobo       bigint NOT NULL,
    ledger_entry_id     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, member_id)
);

-- Small internal loans from the group pool with simple interest. total_due_kobo
-- = principal + principal * interest_rate_bps / 10_000 (integer math).
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_loans (
    id                  text PRIMARY KEY,
    group_id            text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    cycle_id            text NOT NULL REFERENCES vsla_carbon.vsla_cycles(id),
    member_id           text NOT NULL REFERENCES vsla_carbon.vsla_members(id),
    principal_kobo      bigint NOT NULL,
    interest_rate_bps   integer NOT NULL,
    total_due_kobo      bigint NOT NULL,
    repaid_kobo         bigint NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | REPAID
    issued_at           timestamptz NOT NULL DEFAULT now(),
    repaid_at           timestamptz,
    ledger_entry_id     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_carbon_loans_group_idx
    ON vsla_carbon.vsla_loans (group_id, status);

CREATE INDEX IF NOT EXISTS vsla_carbon_loans_member_idx
    ON vsla_carbon.vsla_loans (member_id);

-- Loan repayments. UNIQUE idempotency key → retries replay; each repayment
-- posts DR group cash / CR group loans_receivable in the ledger.
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_loan_repayments (
    id                  text PRIMARY KEY,
    loan_id             text NOT NULL REFERENCES vsla_carbon.vsla_loans(id),
    amount_kobo         bigint NOT NULL,
    idempotency_key     text NOT NULL UNIQUE,
    ledger_entry_id     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_carbon_repayments_loan_idx
    ON vsla_carbon.vsla_loan_repayments (loan_id);

-- Carbon MRV: practice-adoption plots registered by VSLA groups. Geometry is
-- an H3 index at resolution 9 (app-layer h3-js — no PostGIS) plus the
-- centroid for display. hectares is stored as integer centi-hectares
-- (hectares * 100) so estimate math stays exact.
CREATE TABLE IF NOT EXISTS vsla_carbon.carbon_plots (
    id                  text PRIMARY KEY,
    group_id            text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    owner_user_id       text NOT NULL,
    name                text NOT NULL,
    practice_type       text NOT NULL,  -- agroforestry | fmnr | woodlot | conservation_agriculture
    hectares_centi      bigint NOT NULL,
    centroid_lat        double precision NOT NULL,
    centroid_long       double precision NOT NULL,
    h3_res9             text NOT NULL,
    status              text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | RETIRED
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_carbon_plots_group_idx
    ON vsla_carbon.carbon_plots (group_id);

CREATE INDEX IF NOT EXISTS vsla_carbon_plots_h3_idx
    ON vsla_carbon.carbon_plots (h3_res9);

-- Seasonal evidence submissions (enumerator/farmer attestations) with an
-- optional Sentinel-2 NDVI linkage via the crop-ml sidecar contract. The
-- NDVI basis flag ('stub'|'live') is stored verbatim — never upgraded.
CREATE TABLE IF NOT EXISTS vsla_carbon.carbon_evidence (
    id                  text PRIMARY KEY,
    plot_id             text NOT NULL REFERENCES vsla_carbon.carbon_plots(id),
    group_id            text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    season              text NOT NULL,
    submitted_by        text NOT NULL,
    submitter_role      text NOT NULL,  -- farmer | enumerator
    survival_rate_pct   integer,        -- 0-100 observed survival, optional
    notes               text,
    ndvi_health_score   integer,
    ndvi_classification text,
    ndvi_basis          text,           -- stub | live
    idempotency_key     text NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_carbon_evidence_plot_idx
    ON vsla_carbon.carbon_evidence (plot_id, season);

-- Persisted carbon ESTIMATES (deterministic, versioned coefficient table).
-- co2e_milli_tonnes = tonnes CO2e * 1000 (fixed-point). ALWAYS labelled
-- basis 'estimate' — not verification-grade. Unique (plot_id, season,
-- coefficient_version) keeps recomputation idempotent.
CREATE TABLE IF NOT EXISTS vsla_carbon.carbon_estimates (
    id                      text PRIMARY KEY,
    plot_id                 text NOT NULL REFERENCES vsla_carbon.carbon_plots(id),
    group_id                text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    season                  text NOT NULL,
    coefficient_version     text NOT NULL,
    hectares_centi          bigint NOT NULL,
    practice_type           text NOT NULL,
    survival_rate_pct       integer NOT NULL,
    season_count            integer NOT NULL,
    co2e_milli_tonnes       bigint NOT NULL,
    basis                   text NOT NULL DEFAULT 'estimate',  -- always 'estimate'
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plot_id, season, coefficient_version)
);

CREATE INDEX IF NOT EXISTS vsla_carbon_estimates_group_idx
    ON vsla_carbon.carbon_estimates (group_id);

COMMIT;
