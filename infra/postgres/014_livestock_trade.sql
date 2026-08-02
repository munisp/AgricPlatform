-- 014_livestock_trade.sql — wave L1c Africa Livestock Trust Platform (ALTP).
-- Certified trade (F4): certified listings, off-take templates/contracts,
-- AfCFTA export document payloads. Livestock finance (F5): liens, insurance
-- policies/claims, donor disbursements. Compliance (F6) reads registry
-- tables directly; partner aggregation (F7) adds aggregation points and
-- cold-chain telemetry. All statements are idempotent (IF NOT EXISTS).

BEGIN;

CREATE SCHEMA IF NOT EXISTS livestock;

-- Certified marketplace listing referencing an animal or lot from the
-- registry. subject_id is polymorphic (animals or lots) so it carries no
-- FK; provenance is a jsonb snapshot captured at certification time.
CREATE TABLE IF NOT EXISTS livestock.certified_listings (
    id              text PRIMARY KEY,
    subject_type    text NOT NULL CHECK (subject_type IN ('animal','lot')),
    subject_id      text NOT NULL,
    seller_user_id  text NOT NULL REFERENCES identity.users(id),
    species         text NOT NULL,
    breed           text,
    quantity        integer,
    asking_price_kobo bigint CHECK (asking_price_kobo IS NULL OR asking_price_kobo >= 0),
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','sold','withdrawn','revoked')),
    provenance      jsonb NOT NULL,
    revoked_by_user_id text,
    revoked_at      timestamptz,
    revocation_reason text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS certified_listings_subject_idx
    ON livestock.certified_listings (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS certified_listings_seller_idx
    ON livestock.certified_listings (seller_user_id);
CREATE INDEX IF NOT EXISTS certified_listings_status_idx
    ON livestock.certified_listings (status);

-- Off-take contract templates (admin/partner-managed). Variable slots are
-- the default_* columns; instantiation may override them.
CREATE TABLE IF NOT EXISTS livestock.offtake_templates (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    description     text,
    species         text NOT NULL
                    CHECK (species IN ('cattle','sheep','goat','chicken','pig')),
    default_quantity integer CHECK (default_quantity IS NULL OR default_quantity > 0),
    default_price_per_unit_kobo bigint
                    CHECK (default_price_per_unit_kobo IS NULL OR default_price_per_unit_kobo >= 0),
    delivery_window_days integer NOT NULL CHECK (delivery_window_days > 0),
    default_quality_grade text,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','archived')),
    created_by_user_id text NOT NULL REFERENCES identity.users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Instantiated off-take contracts between a farmer and a buyer. Status
-- transitions are audited via the audit log + domain events.
CREATE TABLE IF NOT EXISTS livestock.offtake_contracts (
    id              text PRIMARY KEY,
    template_id     text NOT NULL REFERENCES livestock.offtake_templates(id),
    farmer_user_id  text NOT NULL REFERENCES identity.users(id),
    buyer_user_id   text NOT NULL REFERENCES identity.users(id),
    species         text NOT NULL
                    CHECK (species IN ('cattle','sheep','goat','chicken','pig')),
    quantity        integer NOT NULL CHECK (quantity > 0),
    price_per_unit_kobo bigint NOT NULL CHECK (price_per_unit_kobo >= 0),
    total_kobo      bigint NOT NULL CHECK (total_kobo >= 0),
    delivery_window_start timestamptz NOT NULL,
    delivery_window_end timestamptz NOT NULL,
    quality_grade   text,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','fulfilled','breached','terminated')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offtake_contracts_farmer_idx
    ON livestock.offtake_contracts (farmer_user_id);
CREATE INDEX IF NOT EXISTS offtake_contracts_buyer_idx
    ON livestock.offtake_contracts (buyer_user_id);

-- AfCFTA / cross-border export document payloads. Structured JSON ready
-- for PDF rendering; always DRAFT (no authority submission). Version is
-- 1-based per (document_type, subject_type, subject_id).
CREATE TABLE IF NOT EXISTS livestock.export_documents (
    id              text PRIMARY KEY,
    document_type   text NOT NULL
                    CHECK (document_type IN ('certificate_of_origin','sanitary_certificate','consignment_note')),
    subject_type    text NOT NULL CHECK (subject_type IN ('animal','lot')),
    subject_id      text NOT NULL,
    version         integer NOT NULL CHECK (version >= 1),
    status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
    payload         jsonb NOT NULL,
    created_by_user_id text NOT NULL REFERENCES identity.users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_type, subject_type, subject_id, version)
);

CREATE INDEX IF NOT EXISTS export_documents_subject_idx
    ON livestock.export_documents (subject_type, subject_id);

-- ⚖ LEGAL ACTIVATION REQUIRED: lender liens over livestock collateral.
-- This table (and the transfer-blocking guard wired from it) must not be
-- activated in production without qualified Nigerian legal/regulatory
-- review of secured-transaction, collateral-registry and enforcement
-- obligations. At most one active lien per subject (partial unique index).
CREATE TABLE IF NOT EXISTS livestock.liens (
    id              text PRIMARY KEY,
    subject_type    text NOT NULL CHECK (subject_type IN ('animal','lot')),
    subject_id      text NOT NULL,
    lender_user_id  text NOT NULL REFERENCES identity.users(id),
    borrower_user_id text NOT NULL REFERENCES identity.users(id),
    principal_kobo  bigint NOT NULL CHECK (principal_kobo > 0),
    terms           text NOT NULL,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','discharged','defaulted')),
    registered_at   timestamptz NOT NULL,
    discharged_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS liens_one_active_per_subject
    ON livestock.liens (subject_type, subject_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS liens_lender_idx
    ON livestock.liens (lender_user_id);

-- Livestock insurance policies (quote → bind → lapse/cancel).
CREATE TABLE IF NOT EXISTS livestock.insurance_policies (
    id              text PRIMARY KEY,
    holder_user_id  text NOT NULL REFERENCES identity.users(id),
    insurer_user_id text REFERENCES identity.users(id),
    subject_type    text NOT NULL CHECK (subject_type IN ('animal','lot')),
    subject_id      text NOT NULL,
    species         text NOT NULL
                    CHECK (species IN ('cattle','sheep','goat','chicken','pig')),
    premium_kobo    bigint NOT NULL CHECK (premium_kobo > 0),
    coverage_kobo   bigint NOT NULL CHECK (coverage_kobo > 0),
    status          text NOT NULL DEFAULT 'quote'
                    CHECK (status IN ('quote','bound','lapsed','cancelled')),
    starts_at       timestamptz,
    ends_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insurance_policies_holder_idx
    ON livestock.insurance_policies (holder_user_id);
CREATE INDEX IF NOT EXISTS insurance_policies_subject_idx
    ON livestock.insurance_policies (subject_type, subject_id, status);

-- Insurance claims. trigger 'recall' rows are auto-drafted by the
-- livestock.recall.initiated subscriber (idempotent per policy+recall).
CREATE TABLE IF NOT EXISTS livestock.insurance_claims (
    id              text PRIMARY KEY,
    policy_id       text NOT NULL REFERENCES livestock.insurance_policies(id),
    claimant_user_id text NOT NULL REFERENCES identity.users(id),
    trigger         text NOT NULL CHECK (trigger IN ('manual','recall')),
    recall_id       text,
    animal_ids      text[] NOT NULL DEFAULT '{}',
    amount_kobo     bigint CHECK (amount_kobo IS NULL OR amount_kobo >= 0),
    status          text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('draft','submitted','assessed','paid','rejected')),
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_claims_recall_dedup
    ON livestock.insurance_claims (policy_id, recall_id) WHERE recall_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS insurance_claims_policy_idx
    ON livestock.insurance_claims (policy_id);

-- Donor disbursements linked to programmes. The unique triple
-- (programme, milestone, beneficiary) makes release idempotent: the same
-- milestone can never be paid twice to the same beneficiary.
CREATE TABLE IF NOT EXISTS livestock.disbursements (
    id              text PRIMARY KEY,
    donor_user_id   text NOT NULL REFERENCES identity.users(id),
    programme_id    text NOT NULL,
    milestone       text NOT NULL
                    CHECK (milestone IN ('enrolment','registration','vaccination')),
    amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
    beneficiary_user_id text NOT NULL REFERENCES identity.users(id),
    status          text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','released','confirmed')),
    released_at     timestamptz,
    confirmed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (programme_id, milestone, beneficiary_user_id)
);

CREATE INDEX IF NOT EXISTS disbursements_donor_idx
    ON livestock.disbursements (donor_user_id);
CREATE INDEX IF NOT EXISTS disbursements_beneficiary_idx
    ON livestock.disbursements (beneficiary_user_id);

-- F7 aggregation points (collection hubs managed by partners). Assigned
-- lots are held as an id array; the service enforces single-species
-- consistency and capacity on assignment.
CREATE TABLE IF NOT EXISTS livestock.aggregation_points (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    state           text NOT NULL,
    lga             text NOT NULL,
    manager_user_id text NOT NULL REFERENCES identity.users(id),
    capacity        integer CHECK (capacity IS NULL OR capacity > 0),
    lot_ids         text[] NOT NULL DEFAULT '{}',
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','inactive')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aggregation_points_manager_idx
    ON livestock.aggregation_points (manager_user_id);
CREATE INDEX IF NOT EXISTS aggregation_points_state_idx
    ON livestock.aggregation_points (state);

-- Cold-chain telemetry for aggregation points. Ingestion goes through the
-- provider adapter; the default stub fails closed without configuration.
CREATE TABLE IF NOT EXISTS livestock.cold_chain_logs (
    id              text PRIMARY KEY,
    point_id        text NOT NULL REFERENCES livestock.aggregation_points(id) ON DELETE CASCADE,
    recorded_at     timestamptz NOT NULL,
    temperature_celsius double precision NOT NULL,
    humidity_percent double precision,
    source          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cold_chain_logs_point_idx
    ON livestock.cold_chain_logs (point_id, recorded_at);

COMMIT;
