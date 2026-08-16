-- AgricPlatform Phase 1 database bootstrap.
-- Runs once via docker-entrypoint-initdb.d on first postgres container start.
-- One schema per bounded domain (no cross-domain foreign keys; cross-domain
-- references are plain text columns resolved through the API layer).
--
-- Persistence wave alignment (docs/roadmap/persistence-wave-plan.md §4):
-- API-owned tables use app-generated text PKs (e.g. 'user-adamu') matching the
-- seed/API id contract, and every table maps 1:1 to a TypeScript domain
-- contract consumed by the pg repositories.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() for non-API tables

-- ---------------------------------------------------------------------------
-- identity: users, roles, sessions
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS identity;

-- Drift item 1: text PK, kyc_tier, is_verified, last_active_at.
CREATE TABLE IF NOT EXISTS identity.users (
    id              text PRIMARY KEY,
    external_subject text UNIQUE,              -- Keycloak sub claim
    phone           text UNIQUE,
    email           text UNIQUE,
    full_name       text NOT NULL,
    preferred_language text NOT NULL DEFAULT 'en'
                    CHECK (preferred_language IN ('en','ha','yo','ig')),
    kyc_tier        text NOT NULL DEFAULT 'tier_0'
                    CHECK (kyc_tier IN ('tier_0','tier_1','tier_2','tier_3')),
    is_verified     boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deactivated','pending_deletion')),
    last_active_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity.roles (
    code            text PRIMARY KEY           -- farmer|student|buyer|supplier|chapter_lead|partner|admin
);

CREATE TABLE IF NOT EXISTS identity.user_roles (
    user_id         text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    role_code       text NOT NULL REFERENCES identity.roles(code),
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    assigned_by     text,
    PRIMARY KEY (user_id, role_code)
);

CREATE TABLE IF NOT EXISTS identity.auth_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
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

-- Drift item 2: text PK, value_chains, bio, badges, primary_crops renamed to
-- farming_interests, latitude/longitude.
CREATE TABLE IF NOT EXISTS profiles.member_profiles (
    user_id         text PRIMARY KEY,          -- identity.users.id
    state           text,
    lga             text,
    ward            text,
    latitude        numeric(9,6),
    longitude       numeric(9,6),
    farm_size_hectares numeric(10,2),
    farming_interests text[] NOT NULL DEFAULT '{}',
    value_chains    text[] NOT NULL DEFAULT '{}',
    bio             text,
    years_experience smallint,
    completion_score smallint NOT NULL DEFAULT 0 CHECK (completion_score BETWEEN 0 AND 100),
    badges          text[] NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles.profile_completion_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         text NOT NULL,
    section         text NOT NULL,
    score_before    smallint NOT NULL,
    score_after     smallint NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- privacy: NDPR/NDPA consent, export, deletion
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE IF NOT EXISTS privacy.consent_records (
    id              text PRIMARY KEY,
    user_id         text NOT NULL,
    purpose         text NOT NULL,             -- e.g. marketing_sms, data_sharing_partner
    source          text NOT NULL,             -- web, ussd, agent, import
    granted         boolean NOT NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    evidence        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX consent_user_purpose_idx ON privacy.consent_records (user_id, purpose, granted_at DESC);

-- Drift item 3: status vocabulary aligned to the DeletionRequest contract;
-- fulfilled_at renamed to completed_at.
CREATE TABLE IF NOT EXISTS privacy.data_requests (
    id              text PRIMARY KEY,
    user_id         text NOT NULL,
    request_type    text NOT NULL CHECK (request_type IN ('export','deletion','rectification')),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed')),
    requested_at    timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    notes           text
);

CREATE TABLE IF NOT EXISTS privacy.processing_register (
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

-- Drift item 4: category, level, duration_minutes, enrolment_count,
-- offline_available; slug nullable; text PK.
CREATE TABLE IF NOT EXISTS learning.courses (
    id              text PRIMARY KEY,
    slug            text UNIQUE,
    title           text NOT NULL,
    category        text NOT NULL DEFAULT 'general',
    level           text NOT NULL DEFAULT 'beginner'
                    CHECK (level IN ('beginner','intermediate','advanced')),
    duration_minutes integer NOT NULL DEFAULT 0,
    language        text NOT NULL DEFAULT 'en'
                    CHECK (language IN ('en','ha','yo','ig')),
    enrolment_count integer NOT NULL DEFAULT 0,
    offline_available boolean NOT NULL DEFAULT false,
    description     text,
    moodle_course_id bigint,                   -- external reference only
    published       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Drift item 5: text PKs; status superset (incl. 'dropped') is safe.
CREATE TABLE IF NOT EXISTS learning.enrolments (
    id              text PRIMARY KEY,
    user_id         text NOT NULL,
    course_id       text NOT NULL REFERENCES learning.courses(id),
    status          text NOT NULL DEFAULT 'enrolled'
                    CHECK (status IN ('enrolled','in_progress','completed','dropped')),
    progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    enrolled_at     timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    UNIQUE (user_id, course_id)
);

-- Drift item 6: user_id/course_id/verification_url; enrolment_id dropped.
CREATE TABLE IF NOT EXISTS learning.certificates (
    id              text PRIMARY KEY,
    user_id         text NOT NULL,
    course_id       text NOT NULL REFERENCES learning.courses(id),
    verification_code text UNIQUE NOT NULL,
    verification_url text,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz
);

-- Certificate code sequence (NYFN-CERT-YYYY-####) allocated with
-- UPDATE … RETURNING so concurrent issuances cannot collide.
CREATE TABLE IF NOT EXISTS learning.certificate_counters (
    year            integer PRIMARY KEY,
    next            integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- community: forums, groups, mentorship, Discourse bridge
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS community;

-- Drift item 7: forum topics backing the community service.
CREATE TABLE IF NOT EXISTS community.forum_topics (
    id          text PRIMARY KEY,
    title       text NOT NULL,
    category    text NOT NULL,
    author_id   text NOT NULL,
    state       text,
    crop        text,
    reply_count integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forum_topics_filter_idx ON community.forum_topics (category, state, crop);

-- Drift item 8: mentor requests (mentorship_pairs kept for future pairing).
CREATE TABLE IF NOT EXISTS community.mentor_requests (
    id          text PRIMARY KEY,
    user_id     text NOT NULL,
    crop        text,
    state       text,
    challenge   text NOT NULL,
    status      text NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','matched','closed')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Drift item 9: topic flags for the moderation review queue.
CREATE TABLE IF NOT EXISTS community.topic_flags (
    id          text PRIMARY KEY,
    topic_id    text NOT NULL REFERENCES community.forum_topics(id) ON DELETE CASCADE,
    reporter_id text NOT NULL,
    reason      text NOT NULL,
    status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','resolved')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community.groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text UNIQUE NOT NULL,
    name            text NOT NULL,
    description     text,
    discourse_category_id bigint,              -- external reference only
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community.group_members (
    group_id        uuid NOT NULL REFERENCES community.groups(id) ON DELETE CASCADE,
    user_id         text NOT NULL,
    role            text NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator','mentor')),
    joined_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS community.mentorship_pairs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mentor_id       text NOT NULL,
    mentee_id       text NOT NULL,
    status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','active','completed','cancelled')),
    started_at      timestamptz,
    ended_at        timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community.moderation_reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     text NOT NULL,
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

-- Drift item 10: TS type vocabulary, value_chains, eligibility text[],
-- partner_id text, is_active, timestamptz deadline, text PK.
CREATE TABLE IF NOT EXISTS opportunities.opportunities (
    id              text PRIMARY KEY,
    partner_id      text,                      -- partner organisation reference
    type            text NOT NULL
                    CHECK (type IN ('grant','loan','programme','job','internship','competition','equipment','land')),
    title           text NOT NULL,
    description     text NOT NULL DEFAULT '',
    states          text[] NOT NULL DEFAULT '{}',
    value_chains    text[] NOT NULL DEFAULT '{}',
    eligibility     text[] NOT NULL DEFAULT '{}',
    deadline        timestamptz,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunities_partner_idx ON opportunities.opportunities (partner_id);

-- Drift item 11: TS status vocabulary, notes, partial unique index backing
-- the one-active-application rule.
CREATE TABLE IF NOT EXISTS opportunities.applications (
    id              text PRIMARY KEY,
    opportunity_id  text NOT NULL REFERENCES opportunities.opportunities(id),
    user_id         text NOT NULL,
    idempotency_key text UNIQUE,
    notes           text,
    status          text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','under_review','successful','unsuccessful','withdrawn')),
    submitted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_user_idx ON opportunities.applications (user_id, submitted_at DESC);
CREATE UNIQUE INDEX applications_active_unique
    ON opportunities.applications (opportunity_id, user_id) WHERE status <> 'withdrawn';

CREATE TABLE IF NOT EXISTS opportunities.programme_cohorts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  text NOT NULL REFERENCES opportunities.opportunities(id),
    name            text NOT NULL,
    starts_on       date,
    ends_on         date
);

-- ---------------------------------------------------------------------------
-- chapters: hierarchy, members, events, attendance, announcements
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS chapters;

-- Drift item 12: lead_user_id, member_count, active; text PK.
CREATE TABLE IF NOT EXISTS chapters.chapters (
    id              text PRIMARY KEY,
    parent_id       text REFERENCES chapters.chapters(id),
    level           text NOT NULL CHECK (level IN ('national','state','lga','ward')),
    name            text NOT NULL,
    state           text NOT NULL DEFAULT '',
    lga             text,
    ward            text,
    lead_user_id    text,
    member_count    integer NOT NULL DEFAULT 0,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (level, name)
);

CREATE TABLE IF NOT EXISTS chapters.chapter_members (
    chapter_id      text NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    user_id         text NOT NULL,
    role            text NOT NULL DEFAULT 'member' CHECK (role IN ('member','lead','secretary')),
    joined_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chapter_id, user_id)
);

-- Drift item 13: event type, venue renamed to location, rsvp/attendance
-- counters maintained atomically by the repository.
CREATE TABLE IF NOT EXISTS chapters.events (
    id              text PRIMARY KEY,
    chapter_id      text NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    title           text NOT NULL,
    type            text NOT NULL DEFAULT 'meeting'
                    CHECK (type IN ('meeting','training','field_visit','programme')),
    starts_at       timestamptz NOT NULL,
    location        text NOT NULL DEFAULT '',
    rsvp_count      integer NOT NULL DEFAULT 0,
    attendance_count integer NOT NULL DEFAULT 0,
    description     text,
    ends_at         timestamptz,
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Drift item 14: single participation row per (event, user) replacing the
-- separate event_rsvps/event_attendance tables.
CREATE TABLE IF NOT EXISTS chapters.event_participation (
    id          text PRIMARY KEY,
    event_id    text NOT NULL REFERENCES chapters.events(id) ON DELETE CASCADE,
    user_id     text NOT NULL,
    status      text NOT NULL CHECK (status IN ('rsvp','attended')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, user_id)
);

-- Drift item 15: text PK; mapper handles authorId ↔ published_by.
CREATE TABLE IF NOT EXISTS chapters.announcements (
    id              text PRIMARY KEY,
    chapter_id      text NOT NULL REFERENCES chapters.chapters(id) ON DELETE CASCADE,
    title           text NOT NULL,
    body            text NOT NULL,
    published_by    text,
    published_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- advisory: unified items + ingest snapshot tables
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS advisory;

-- Drift item 16: unified advisory items backing the API; the specialized
-- snapshot tables below stay for ingest pipelines.
CREATE TABLE IF NOT EXISTS advisory.items (
    id          text PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('crop_calendar','pest_alert','weather','price','guide')),
    title       text NOT NULL,
    summary     text NOT NULL,
    state       text,
    crop        text,
    severity    text CHECK (severity IN ('info','warning','critical')),
    published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advisory_items_filter_idx ON advisory.items (kind, state, crop);

CREATE TABLE IF NOT EXISTS advisory.crop_calendar_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    crop            text NOT NULL,
    state           text,
    activity        text NOT NULL,             -- land_prep|planting|weeding|harvest...
    window_start    date NOT NULL,
    window_end      date NOT NULL,
    guidance        text
);

CREATE TABLE IF NOT EXISTS advisory.pest_alerts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pest            text NOT NULL,
    affected_states text[],
    severity        text NOT NULL CHECK (severity IN ('low','moderate','high','critical')),
    advisory        text NOT NULL,
    source          text,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz
);

CREATE TABLE IF NOT EXISTS advisory.weather_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    state           text NOT NULL,
    lga             text,
    source          text NOT NULL,             -- NiMet|OpenMeteo|stub
    forecast_date   date NOT NULL,
    payload         jsonb NOT NULL,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (state, lga, source, forecast_date)
);

CREATE TABLE IF NOT EXISTS advisory.price_snapshots (
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

-- Drift item 17: 6-value kind vocabulary, type→kind, commodity→crop,
-- ward/latitude/longitude location columns, is_active, harvest_date, text PK.
CREATE TABLE IF NOT EXISTS marketplace.listings (
    id              text PRIMARY KEY,
    seller_id       text NOT NULL,
    kind            text NOT NULL
                    CHECK (kind IN ('produce','input','service','equipment','storage','transport')),
    title           text NOT NULL,
    description     text,
    crop            text,
    quantity        numeric(14,2),
    unit            text,
    price_ngn       numeric(14,2),
    location_state  text,
    location_lga    text,
    location_ward   text,
    location_latitude numeric(9,6),
    location_longitude numeric(9,6),
    harvest_date    date,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_search_idx ON marketplace.listings (crop, location_state) WHERE is_active;

CREATE TABLE IF NOT EXISTS marketplace.buyer_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id        text NOT NULL,
    commodity       text NOT NULL,
    quantity        numeric(14,2),
    unit            text,
    max_price_ngn   numeric(14,2),
    location_state  text,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','closed')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Drift item 18: 9-value TS status vocabulary, seller_id, escrow_required,
-- total_naira, created_at, idempotency_key, text PK.
CREATE TABLE IF NOT EXISTS marketplace.orders (
    id              text PRIMARY KEY,
    listing_id      text NOT NULL REFERENCES marketplace.listings(id),
    buyer_id        text NOT NULL,
    seller_id       text NOT NULL,
    idempotency_key text UNIQUE,
    quantity        numeric(14,2) NOT NULL,
    total_naira     numeric(14,2) NOT NULL,
    status          text NOT NULL DEFAULT 'requested' CHECK (status IN
                    ('requested','negotiating','confirmed','deposit_paid','in_fulfilment',
                     'delivered','completed','disputed','cancelled')),
    escrow_required boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_buyer_idx ON marketplace.orders (buyer_id, created_at DESC);
CREATE INDEX orders_seller_idx ON marketplace.orders (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace.order_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        text NOT NULL REFERENCES marketplace.orders(id) ON DELETE CASCADE,
    event_type      text NOT NULL,
    actor_id        text,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- Drift item 19: reviewer_id renamed to author_id; text PK.
CREATE TABLE IF NOT EXISTS marketplace.reviews (
    id              text PRIMARY KEY,
    order_id        text NOT NULL REFERENCES marketplace.orders(id),
    author_id       text NOT NULL,
    rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, author_id)
);

-- ---------------------------------------------------------------------------
-- finance: credit readiness, document vault, KYC, double-entry ledger
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS finance;

-- Drift item 20: credit readiness signal columns; kyc_tier is deprecated
-- here (canonical value lives on identity.users).
CREATE TABLE IF NOT EXISTS finance.credit_profiles (
    user_id         text PRIMARY KEY,
    score           smallint CHECK (score BETWEEN 0 AND 100),
    training_signals smallint NOT NULL DEFAULT 0,
    transaction_signals smallint NOT NULL DEFAULT 0,
    production_signals smallint NOT NULL DEFAULT 0,
    document_count  smallint NOT NULL DEFAULT 0,
    improvement_actions text[] NOT NULL DEFAULT '{}',
    kyc_tier        smallint NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 3),  -- deprecated
    bvn_verified    boolean NOT NULL DEFAULT false,
    nin_verified    boolean NOT NULL DEFAULT false,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Drift item 21: doc_type renamed to kind with the 6-value TS vocabulary;
-- storage_ref nullable; file_name required.
CREATE TABLE IF NOT EXISTS finance.documents (
    id              text PRIMARY KEY,
    user_id         text NOT NULL,
    kind            text NOT NULL
                    CHECK (kind IN ('national_id','land_title','farm_photo','certificate','business_plan','utility_bill')),
    file_name       text NOT NULL,
    storage_ref     text,                      -- object-store key, never inline PII blobs
    status          text NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('uploaded','verified','rejected','expired')),
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    verified_at     timestamptz
);

CREATE TABLE IF NOT EXISTS finance.kyc_records (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         text NOT NULL,
    tier            smallint NOT NULL,
    provider        text NOT NULL,             -- paystack|dojah|manual|stub
    provider_ref    text,
    status          text NOT NULL CHECK (status IN ('pending','passed','failed')),
    attempted_at    timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS finance.lender_matches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         text NOT NULL,
    lender_ref      text NOT NULL,
    match_score     smallint,
    status          text NOT NULL DEFAULT 'suggested'
                    CHECK (status IN ('suggested','introduced','applied','funded','declined')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Double-entry ledger (Phase 1 financial simplification; TigerBeetle adapter later).
-- Every transfer posts balanced entries: sum(debits) = sum(credits) per transfer.
CREATE TABLE IF NOT EXISTS finance.ledger_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text UNIQUE NOT NULL,      -- e.g. escrow:order:<uuid>, platform:fees
    owner_id        text,                      -- nullable for platform accounts
    account_type    text NOT NULL
                    CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
    currency        char(3) NOT NULL DEFAULT 'NGN',
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.ledger_transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key text UNIQUE NOT NULL,
    reference_type  text,                      -- marketplace_order|payout|fee...
    reference_id    text,
    description     text,
    posted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance.ledger_entries (
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

CREATE TABLE IF NOT EXISTS notifications.notification_templates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text UNIQUE NOT NULL,      -- e.g. opportunity.deadline_reminder
    channel         text NOT NULL CHECK (channel IN ('in_app','sms','whatsapp','email','push')),
    locale          text NOT NULL DEFAULT 'en',
    subject         text,
    body            text NOT NULL
);

-- Drift item 22: topic dropped; composite PK (user_id, channel).
CREATE TABLE IF NOT EXISTS notifications.user_preferences (
    user_id         text NOT NULL,
    channel         text NOT NULL CHECK (channel IN ('in_app','sms','whatsapp','email','push')),
    enabled         boolean NOT NULL DEFAULT true,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel)
);

-- Drift item 23: TS status vocabulary incl. 'read'; title/body; created_at.
CREATE TABLE IF NOT EXISTS notifications.notifications (
    id              text PRIMARY KEY,
    user_id         text NOT NULL,
    channel         text NOT NULL CHECK (channel IN ('in_app','sms','whatsapp','email','push')),
    title           text NOT NULL,
    body            text NOT NULL,
    idempotency_key text UNIQUE,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','delivered','failed','read','suppressed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    read_at         timestamptz
);
CREATE INDEX notifications_user_idx ON notifications.notifications (user_id, created_at DESC);

-- Drift item 24: text PK/FK; the mapper stores the DeliveryResult JSON in
-- the detail column.
CREATE TABLE IF NOT EXISTS notifications.delivery_logs (
    id              text PRIMARY KEY,
    notification_id text NOT NULL REFERENCES notifications.notifications(id) ON DELETE CASCADE,
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

-- Drift item 25: entity_type/entity_id targets, metadata, created_at.
CREATE TABLE IF NOT EXISTS admin.audit_events (
    id              text PRIMARY KEY,
    actor_id        text,
    actor_role      text,
    action          text NOT NULL,             -- e.g. user.suspend, listing.remove
    entity_type     text,
    entity_id       text,
    ip_address      inet,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_time_idx ON admin.audit_events (created_at DESC);
CREATE INDEX audit_events_actor_idx ON admin.audit_events (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin.review_queue_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    queue           text NOT NULL,             -- verification|moderation|kyc|marketplace
    subject_type    text NOT NULL,
    subject_id      text NOT NULL,
    priority        smallint NOT NULL DEFAULT 2,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','resolved','escalated')),
    claimed_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz
);

CREATE TABLE IF NOT EXISTS admin.platform_kpi_snapshots (
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

CREATE TABLE IF NOT EXISTS analytics.events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         text,
    session_id      text,
    event_name      text NOT NULL,             -- e.g. page_view, search_performed
    properties      jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_time_idx ON analytics.events (event_name, occurred_at DESC);

CREATE TABLE IF NOT EXISTS analytics.export_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by    text,
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

CREATE TABLE IF NOT EXISTS integrations.providers (
    code            text PRIMARY KEY,          -- termii|paystack|moodle|discourse|directus|meilisearch|nimet|openmeteo|fewsnet|farmos
    display_name    text NOT NULL,
    driver          text NOT NULL DEFAULT 'stub' CHECK (driver IN ('stub','sandbox','production')),
    status          text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','enabled','degraded')),
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret config only
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations.webhook_endpoints (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code   text NOT NULL REFERENCES integrations.providers(code),
    path            text NOT NULL,
    signing_secret_ref text NOT NULL,          -- name of secret in secret store, never the value
    enabled         boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations.webhook_deliveries (
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

-- Drift item 26: event_type renamed to name, aggregate_id text NULL,
-- actor_id added, text PK.
CREATE TABLE IF NOT EXISTS events.outbox (
    id              text PRIMARY KEY,
    name            text NOT NULL,             -- {domain}.{entity}.{verb}
    aggregate_type  text,
    aggregate_id    text,
    actor_id        text,
    payload         jsonb NOT NULL,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,               -- NULL until relayed to consumers
    attempts        integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished_idx ON events.outbox (occurred_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS events.processed_events (         -- consumer-side idempotency
    consumer        text NOT NULL,
    event_id        text NOT NULL,
    processed_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

COMMIT;

-- ---------------------------------------------------------------------------
-- Seed reference data (demo rows are owned by apps/api seed.ts)
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

COMMIT;
