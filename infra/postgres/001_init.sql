-- AgricPlatform Phase 1 database bootstrap.
-- Runs once via docker-entrypoint-initdb.d on first postgres container start.
-- One schema per bounded domain (no cross-domain foreign keys; cross-domain
-- references are plain UUID columns resolved through the API layer).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- identity: users, roles, sessions
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_subject text UNIQUE,              -- Keycloak sub claim
    phone           text UNIQUE,
    email           text UNIQUE,
    full_name       text NOT NULL,
    preferred_language text NOT NULL DEFAULT 'en',
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deactivated','pending_deletion')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.roles (
    code            text PRIMARY KEY           -- farmer|student|buyer|supplier|chapter_lead|partner|admin
);

CREATE TABLE identity.user_roles (
    user_id         uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    role_code       text NOT NULL REFERENCES identity.roles(code),
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    assigned_by     uuid,
    PRIMARY KEY (user_id, role_code)
);

CREATE TABLE identity.auth_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    refresh_token_hash text NOT NULL,
    ip_address      inet,
    user_agent      text,
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO identity.roles (code) VALUES
    ('farmer'), ('student'), ('buyer'), ('supplier'),
    ('chapter_lead'), ('partner'), ('admin');

-- ---------------------------------------------------------------------------
-- profiles: progressive member profiles
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS profiles;

CREATE TABLE profiles.member_profiles (
    user_id         uuid PRIMARY KEY,          -- identity.users.id
    state           text,
    lga             text,
    ward            text,
    farm_size_hectares numeric(10,2),
    primary_crops   text[],
    years_experience smallint,
    education_level text,
    completion_score smallint NOT NULL DEFAULT 0 CHECK (completion_score BETWEEN 0 AND 100),
    verification_status text NOT NULL DEFAULT 'unverified'
                    CHECK (verification_status IN ('unverified','pending','verified','rejected')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles.profile_completion_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    section         text NOT NULL,
    score_before    smallint NOT NULL,
    score_after     smallint NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- privacy: NDPR/NDPA consent, export, deletion
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE privacy.consent_records (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    purpose         text NOT NULL,             -- e.g. marketing_sms, data_sharing_partner
    source          text NOT NULL,             -- web, ussd, agent, import
    granted         boolean NOT NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    evidence        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX consent_user_purpose_idx ON privacy.consent_records (user_id, purpose, granted_at DESC);

CREATE TABLE privacy.data_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    request_type    text NOT NULL CHECK (request_type IN ('export','deletion','rectification')),
    status          text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','in_progress','fulfilled','rejected')),
    requested_at    timestamptz NOT NULL DEFAULT now(),
    fulfilled_at    timestamptz,
    notes           text
);

CREATE TABLE privacy.processing_register (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain          text NOT NULL,
    data_category   text NOT NULL,
    lawful_basis    text NOT NULL,
    retention_days  integer,
    third_parties   text[],
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- learning: courses, enrolments, certificates, Moodle bridge
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS learning;

CREATE TABLE learning.courses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text UNIQUE NOT NULL,
    title           text NOT NULL,
    description     text,
    language        text NOT NULL DEFAULT 'en',
    moodle_course_id bigint,                   -- external reference only
    published       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning.enrolments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    course_id       uuid NOT NULL REFERENCES learning.courses(id),
    status          text NOT NULL DEFAULT 'enrolled'
                    CHECK (status IN ('enrolled','in_progress','completed','dropped')),
    progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    enrolled_at     timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    UNIQUE (user_id, course_id)
);

CREATE TABLE learning.certificates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enrolment_id    uuid NOT NULL REFERENCES learning.enrolments(id),
    verification_code text UNIQUE NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz
);

-- ---------------------------------------------------------------------------
-- community: forums, groups, mentorship, Discourse bridge
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS community;

CREATE TABLE community.groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text UNIQUE NOT NULL,
    name            text NOT NULL,
    description     text,
    discourse_category_id bigint,              -- external reference only
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community.group_members (
    group_id        uuid NOT NULL REFERENCES community.groups(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL,
    role            text NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator','mentor')),
    joined_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE community.mentorship_pairs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mentor_id       uuid NOT NULL,
    mentee_id       uuid NOT NULL,
    status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','active','completed','cancelled')),
    started_at      timestamptz,
    ended_at        timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community.moderation_reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     uuid NOT NULL,
    target_type     text NOT NULL,             -- post|topic|user|group
    target_ref      text NOT NULL,
    reason          text NOT NULL,
    status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','actioned','dismissed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- opportunities: directory, applications, programme cohorts
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS opportunities;

CREATE TABLE opportunities.opportunities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_ref     uuid,                      -- partner organisation reference
    type            text NOT NULL,             -- grant|loan|training|job|market_linkage
    title           text NOT NULL,
    description     text,
    eligibility     jsonb NOT NULL DEFAULT '{}'::jsonb,
    location_states text[],
    deadline        date,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','open','closed','archived')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opportunities.applications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  uuid NOT NULL REFERENCES opportunities.opportunities(id),
    user_id         uuid NOT NULL,
    idempotency_key text UNIQUE,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','under_review','shortlisted','accepted','rejected','withdrawn')),
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    decided_at      timestamptz
);
CREATE INDEX applications_user_idx ON opportunities.applications (user_id, submitted_at DESC);

CREATE TABLE opportunities.programme_cohorts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  uuid NOT NULL REFERENCES opportunities.opportunities(id),
    name            text NOT NULL,
    starts_on       date,
    ends_on         date
);

-- ---------------------------------------------------------------------------
-- chapters: hierarchy, members, events, attendance, announcements
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS chapters;

CREATE TABLE chapters.chapters (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       uuid REFERENCES chapters.chapters(id),
    level           text NOT NULL CHECK (level IN ('national','state','lga','ward')),
    name            text NOT NULL,
    state           text,
    lga             text,
    ward            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (level, name)
);

CREATE TABLE chapters.chapter_members (
    chapter_id      uuid NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL,
    role            text NOT NULL DEFAULT 'member' CHECK (role IN ('member','lead','secretary')),
    joined_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chapter_id, user_id)
);

CREATE TABLE chapters.events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id      uuid NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    title           text NOT NULL,
    description     text,
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz,
    venue           text,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chapters.event_rsvps (
    event_id        uuid NOT NULL REFERENCES chapters.events(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL,
    response        text NOT NULL CHECK (response IN ('yes','no','maybe')),
    responded_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);

CREATE TABLE chapters.event_attendance (
    event_id        uuid NOT NULL REFERENCES chapters.events(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL,
    checked_in_at   timestamptz NOT NULL DEFAULT now(),
    recorded_by     uuid,
    PRIMARY KEY (event_id, user_id)
);

CREATE TABLE chapters.announcements (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id      uuid NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    title           text NOT NULL,
    body            text NOT NULL,
    published_by    uuid,
    published_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- advisory: crop calendar, pest alerts, weather/price snapshots
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS advisory;

CREATE TABLE advisory.crop_calendar_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    crop            text NOT NULL,
    state           text,
    activity        text NOT NULL,             -- land_prep|planting|weeding|harvest...
    window_start    date NOT NULL,
    window_end      date NOT NULL,
    guidance        text
);

CREATE TABLE advisory.pest_alerts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pest            text NOT NULL,
    affected_states text[],
    severity        text NOT NULL CHECK (severity IN ('low','moderate','high','critical')),
    advisory        text NOT NULL,
    source          text,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz
);

CREATE TABLE advisory.weather_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state           text NOT NULL,
    lga             text,
    source          text NOT NULL,             -- NiMet|OpenMeteo|stub
    forecast_date   date NOT NULL,
    payload         jsonb NOT NULL,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (state, lga, source, forecast_date)
);

CREATE TABLE advisory.price_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    commodity       text NOT NULL,
    market          text NOT NULL,
    source          text NOT NULL,             -- FEWS NET|manual|stub
    price_ngn_per_unit numeric(14,2) NOT NULL,
    unit            text NOT NULL,
    observed_on     date NOT NULL,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (commodity, market, source, observed_on)
);

COMMIT;

-- ---------------------------------------------------------------------------
-- marketplace: listings, buyer requests, orders, reviews
-- ---------------------------------------------------------------------------
BEGIN;

CREATE SCHEMA IF NOT EXISTS marketplace;

CREATE TABLE marketplace.listings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id       uuid NOT NULL,
    type            text NOT NULL CHECK (type IN ('produce','service','input')),
    title           text NOT NULL,
    description     text,
    commodity       text,
    quantity        numeric(14,2),
    unit            text,
    price_ngn       numeric(14,2),
    location_state  text,
    location_lga    text,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','paused','sold_out','removed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_search_idx ON marketplace.listings (commodity, location_state) WHERE status = 'active';

CREATE TABLE marketplace.buyer_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id        uuid NOT NULL,
    commodity       text NOT NULL,
    quantity        numeric(14,2),
    unit            text,
    max_price_ngn   numeric(14,2),
    location_state  text,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','closed')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace.orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id      uuid NOT NULL REFERENCES marketplace.listings(id),
    buyer_id        uuid NOT NULL,
    idempotency_key text UNIQUE,
    quantity        numeric(14,2) NOT NULL,
    total_ngn       numeric(14,2) NOT NULL,
    status          text NOT NULL DEFAULT 'placed'
                    CHECK (status IN ('placed','paid','in_escrow','fulfilled','disputed','cancelled','refunded')),
    placed_at       timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace.order_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        uuid NOT NULL REFERENCES marketplace.orders(id) ON DELETE CASCADE,
    event_type      text NOT NULL,
    actor_id        uuid,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace.reviews (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        uuid NOT NULL REFERENCES marketplace.orders(id),
    reviewer_id     uuid NOT NULL,
    rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, reviewer_id)
);

-- ---------------------------------------------------------------------------
-- finance: credit readiness, document vault, KYC, double-entry ledger
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE finance.credit_profiles (
    user_id         uuid PRIMARY KEY,
    kyc_tier        smallint NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 3),
    readiness_score smallint CHECK (readiness_score BETWEEN 0 AND 100),
    bvn_verified    boolean NOT NULL DEFAULT false,
    nin_verified    boolean NOT NULL DEFAULT false,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance.documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    doc_type        text NOT NULL,             -- id_card|cac|farm_photo|bank_statement...
    storage_ref     text NOT NULL,             -- object-store key, never inline PII blobs
    status          text NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('uploaded','verified','rejected','expired')),
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    verified_at     timestamptz
);

CREATE TABLE finance.kyc_records (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    tier            smallint NOT NULL,
    provider        text NOT NULL,             -- paystack|dojah|manual|stub
    provider_ref    text,
    status          text NOT NULL CHECK (status IN ('pending','passed','failed')),
    attempted_at    timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);

CREATE TABLE finance.lender_matches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    lender_ref      text NOT NULL,
    match_score     smallint,
    status          text NOT NULL DEFAULT 'suggested'
                    CHECK (status IN ('suggested','introduced','applied','funded','declined')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Double-entry ledger (Phase 1 financial simplification; TigerBeetle adapter later).
-- Every transfer posts balanced entries: sum(debits) = sum(credits) per transfer.
CREATE TABLE finance.ledger_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text UNIQUE NOT NULL,      -- e.g. escrow:order:<uuid>, platform:fees
    owner_id        uuid,                      -- nullable for platform accounts
    account_type    text NOT NULL
                    CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
    currency        char(3) NOT NULL DEFAULT 'NGN',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance.ledger_transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key text UNIQUE NOT NULL,
    reference_type  text,                      -- marketplace_order|payout|fee...
    reference_id    uuid,
    description     text,
    posted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance.ledger_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id     uuid NOT NULL REFERENCES finance.ledger_transfers(id) ON DELETE CASCADE,
    account_id      uuid NOT NULL REFERENCES finance.ledger_accounts(id),
    direction       text NOT NULL CHECK (direction IN ('debit','credit')),
    amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),  -- minor units only
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON finance.ledger_entries (account_id, created_at);

-- Balance invariant: every transfer must have matching debit/credit totals.
-- The API asserts finance.transfer_is_balanced() after posting entries;
-- a deferred constraint trigger can be added in a later migration if direct
-- SQL writers ever bypass the API.
CREATE OR REPLACE FUNCTION finance.transfer_is_balanced(p_transfer_id uuid) RETURNS boolean AS $$
    SELECT COALESCE(sum(amount_kobo) FILTER (WHERE direction = 'debit'), 0)
         = COALESCE(sum(amount_kobo) FILTER (WHERE direction = 'credit'), 0)
      FROM finance.ledger_entries
     WHERE transfer_id = p_transfer_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- notifications: orchestration, preferences, delivery logs
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE notifications.notification_templates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text UNIQUE NOT NULL,      -- e.g. opportunity.deadline_reminder
    channel         text NOT NULL CHECK (channel IN ('in_app','sms','whatsapp','email','push')),
    locale          text NOT NULL DEFAULT 'en',
    subject         text,
    body            text NOT NULL
);

CREATE TABLE notifications.user_preferences (
    user_id         uuid NOT NULL,
    channel         text NOT NULL CHECK (channel IN ('in_app','sms','whatsapp','email','push')),
    topic           text NOT NULL,             -- e.g. learning, marketplace, advisory
    enabled         boolean NOT NULL DEFAULT true,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel, topic)
);

CREATE TABLE notifications.notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    template_code   text,
    channel         text NOT NULL,
    idempotency_key text UNIQUE,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','delivered','failed','suppressed')),
    queued_at       timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    read_at         timestamptz
);
CREATE INDEX notifications_user_idx ON notifications.notifications (user_id, queued_at DESC);

CREATE TABLE notifications.delivery_logs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id uuid NOT NULL REFERENCES notifications.notifications(id) ON DELETE CASCADE,
    provider        text NOT NULL,             -- termii|twilio|mailgun|onesignal|stub
    provider_ref    text,
    status          text NOT NULL,
    detail          jsonb,
    attempted_at    timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- ---------------------------------------------------------------------------
-- admin: review queues, platform KPIs, audit trail
-- ---------------------------------------------------------------------------
BEGIN;

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE admin.audit_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        uuid,
    actor_role      text,
    action          text NOT NULL,             -- e.g. user.suspend, listing.remove
    target_type     text,
    target_id       text,
    ip_address      inet,
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_time_idx ON admin.audit_events (occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON admin.audit_events (actor_id, occurred_at DESC);

CREATE TABLE admin.review_queue_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    queue           text NOT NULL,             -- verification|moderation|kyc|marketplace
    subject_type    text NOT NULL,
    subject_id      text NOT NULL,
    priority        smallint NOT NULL DEFAULT 2,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','resolved','escalated')),
    claimed_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz
);

CREATE TABLE admin.platform_kpi_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    metric          text NOT NULL,             -- dau|enrolments|orders|...
    value           numeric(18,4) NOT NULL,
    dimensions      jsonb NOT NULL DEFAULT '{}'::jsonb,
    captured_on     date NOT NULL,
    UNIQUE (metric, dimensions, captured_on)
);

-- ---------------------------------------------------------------------------
-- analytics: event capture and export staging
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid,
    session_id      text,
    event_name      text NOT NULL,             -- e.g. page_view, search_performed
    properties      jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_time_idx ON analytics.events (event_name, occurred_at DESC);

CREATE TABLE analytics.export_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by    uuid,
    dataset         text NOT NULL,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed')),
    storage_ref     text,
    queued_at       timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- integrations: provider registry, webhooks, ACL adapter state
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS integrations;

CREATE TABLE integrations.providers (
    code            text PRIMARY KEY,          -- termii|paystack|moodle|discourse|directus|meilisearch|nimet|openmeteo|fewsnet|farmos
    display_name    text NOT NULL,
    driver          text NOT NULL DEFAULT 'stub' CHECK (driver IN ('stub','sandbox','production')),
    status          text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','enabled','degraded')),
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret config only
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrations.webhook_endpoints (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code   text NOT NULL REFERENCES integrations.providers(code),
    path            text NOT NULL,
    signing_secret_ref text NOT NULL,          -- name of secret in secret store, never the value
    enabled         boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrations.webhook_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id     uuid NOT NULL REFERENCES integrations.webhook_endpoints(id) ON DELETE CASCADE,
    external_id     text,
    payload_hash    text NOT NULL,
    status          text NOT NULL CHECK (status IN ('received','processed','failed','ignored')),
    received_at     timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    UNIQUE (endpoint_id, external_id)
);

-- ---------------------------------------------------------------------------
-- events: domain event outbox (transactional outbox pattern)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS events;

CREATE TABLE events.outbox (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      text NOT NULL,             -- {domain}.{entity}.{verb}
    aggregate_type  text NOT NULL,
    aggregate_id    uuid NOT NULL,
    payload         jsonb NOT NULL,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,               -- NULL until relayed to consumers
    attempts        integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished_idx ON events.outbox (occurred_at) WHERE published_at IS NULL;

CREATE TABLE events.processed_events (         -- consumer-side idempotency
    consumer        text NOT NULL,
    event_id        uuid NOT NULL,
    processed_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

COMMIT;

-- ---------------------------------------------------------------------------
-- Seed reference data
-- ---------------------------------------------------------------------------
BEGIN;

INSERT INTO integrations.providers (code, display_name, driver, status) VALUES
    ('termii',      'Termii SMS',          'stub', 'enabled'),
    ('whatsapp',    'WhatsApp Business',   'stub', 'enabled'),
    ('mailgun',     'Mailgun Email',       'stub', 'enabled'),
    ('onesignal',   'OneSignal Push',      'stub', 'enabled'),
    ('paystack',    'Paystack Payments',   'stub', 'enabled'),
    ('meilisearch', 'Meilisearch',         'stub', 'enabled'),
    ('moodle',      'Moodle LMS',          'stub', 'enabled'),
    ('discourse',   'Discourse Community', 'stub', 'enabled'),
    ('directus',    'Directus CMS',        'stub', 'enabled'),
    ('nimet',       'NiMet Weather',       'stub', 'enabled'),
    ('openmeteo',   'Open-Meteo Weather',  'stub', 'enabled'),
    ('fewsnet',     'FEWS NET Prices',     'stub', 'enabled'),
    ('farmos',      'farmOS',              'stub', 'disabled');

INSERT INTO chapters.chapters (level, name) VALUES ('national', 'NYFN National');

COMMIT;
