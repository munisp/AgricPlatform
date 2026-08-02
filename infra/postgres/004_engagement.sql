-- 004_engagement.sql — Phase-2 engagement wave (P2b): services marketplace
-- (M8), women & youth programmes (M11), student/NYSC pathways (M12),
-- knowledge base (M14) and search depth (M16).
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-apply. API-owned tables use app-generated text PKs and map 1:1 to the
-- TypeScript contracts in packages/shared/src/engagement.ts.

BEGIN;

-- ---------------------------------------------------------------------------
-- services: supplier directory, offerings, bookings, reviews (M8)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS services;

CREATE TABLE IF NOT EXISTS services.suppliers (
    id              text PRIMARY KEY,
    owner_user_id   text NOT NULL REFERENCES identity.users(id),
    business_name   text NOT NULL,
    categories      text[] NOT NULL DEFAULT '{}',
    states_covered  text[] NOT NULL DEFAULT '{}',
    lgas_covered    text[] NOT NULL DEFAULT '{}',
    verification_status text NOT NULL DEFAULT 'unverified'
                    CHECK (verification_status IN ('unverified','pending','verified','rejected')),
    average_rating  numeric(4,2) NOT NULL DEFAULT 0,
    rating_count    integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS services_suppliers_owner_idx ON services.suppliers (owner_user_id);
CREATE INDEX IF NOT EXISTS services_suppliers_verification_idx ON services.suppliers (verification_status);

CREATE TABLE IF NOT EXISTS services.offerings (
    id              text PRIMARY KEY,
    supplier_id     text NOT NULL REFERENCES services.suppliers(id) ON DELETE CASCADE,
    category        text NOT NULL
                    CHECK (category IN ('seed','fertiliser','equipment','machinery_hire','cold_storage','labour','insurance')),
    title           text NOT NULL,
    description     text NOT NULL DEFAULT '',
    price_naira     numeric(14,2) NOT NULL,
    pricing_unit    text NOT NULL
                    CHECK (pricing_unit IN ('per_bag','per_day','per_hectare','per_unit','per_trip','flat')),
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS services_offerings_supplier_idx ON services.offerings (supplier_id);
CREATE INDEX IF NOT EXISTS services_offerings_category_idx ON services.offerings (category) WHERE is_active;

CREATE TABLE IF NOT EXISTS services.bookings (
    id              text PRIMARY KEY,
    offering_id     text NOT NULL REFERENCES services.offerings(id),
    supplier_id     text NOT NULL REFERENCES services.suppliers(id),
    customer_id     text NOT NULL REFERENCES identity.users(id),
    quantity        numeric(14,2) NOT NULL DEFAULT 1,
    total_naira     numeric(14,2),               -- set when the supplier quotes
    scheduled_start timestamptz NOT NULL,
    scheduled_end   timestamptz NOT NULL,
    status          text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','quoted','accepted','declined','scheduled','completed','cancelled')),
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (scheduled_end > scheduled_start)
);
CREATE INDEX IF NOT EXISTS services_bookings_offering_idx ON services.bookings (offering_id, status);
CREATE INDEX IF NOT EXISTS services_bookings_customer_idx ON services.bookings (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS services_bookings_supplier_idx ON services.bookings (supplier_id, status);

CREATE TABLE IF NOT EXISTS services.reviews (
    id              text PRIMARY KEY,
    booking_id      text NOT NULL REFERENCES services.bookings(id),
    supplier_id     text NOT NULL REFERENCES services.suppliers(id) ON DELETE CASCADE,
    author_id       text NOT NULL REFERENCES identity.users(id),
    rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (booking_id)                          -- one review per booking
);
CREATE INDEX IF NOT EXISTS services_reviews_supplier_idx ON services.reviews (supplier_id);

-- ---------------------------------------------------------------------------
-- programmes: cohorts, enrolments, milestones, judging, protected spaces (M11)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS programmes;

CREATE TABLE IF NOT EXISTS programmes.cohorts (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    programme_type  text NOT NULL CHECK (programme_type IN ('women','youth')),
    capacity        integer NOT NULL CHECK (capacity > 0),
    enrolment_opens_at timestamptz NOT NULL,
    enrolment_closes_at timestamptz NOT NULL,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','open','closed','active','completed')),
    moderator_ids   text[] NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (enrolment_closes_at > enrolment_opens_at)
);
CREATE INDEX IF NOT EXISTS programmes_cohorts_type_status_idx ON programmes.cohorts (programme_type, status);

CREATE TABLE IF NOT EXISTS programmes.enrolments (
    id              text PRIMARY KEY,
    cohort_id       text NOT NULL REFERENCES programmes.cohorts(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES identity.users(id),
    declared_age    smallint,                    -- self-declared only (privacy)
    declared_gender text CHECK (declared_gender IN ('female','male','other')),
    status          text NOT NULL DEFAULT 'enrolled'
                    CHECK (status IN ('enrolled','withdrawn','completed')),
    enrolled_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS programmes_enrolments_cohort_idx ON programmes.enrolments (cohort_id, status);
CREATE INDEX IF NOT EXISTS programmes_enrolments_user_idx ON programmes.enrolments (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS programmes_enrolments_active_unique
    ON programmes.enrolments (cohort_id, user_id) WHERE status = 'enrolled';

CREATE TABLE IF NOT EXISTS programmes.milestones (
    id              text PRIMARY KEY,
    cohort_id       text NOT NULL REFERENCES programmes.cohorts(id) ON DELETE CASCADE,
    title           text NOT NULL,
    sequence        integer NOT NULL,
    due_at          timestamptz
);
CREATE INDEX IF NOT EXISTS programmes_milestones_cohort_idx ON programmes.milestones (cohort_id, sequence);

CREATE TABLE IF NOT EXISTS programmes.milestone_progress (
    id              text PRIMARY KEY,
    milestone_id    text NOT NULL REFERENCES programmes.milestones(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES identity.users(id),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed')),
    completed_at    timestamptz,
    UNIQUE (milestone_id, user_id)
);
CREATE INDEX IF NOT EXISTS programmes_progress_user_idx ON programmes.milestone_progress (user_id, status);

CREATE TABLE IF NOT EXISTS programmes.rubric_criteria (
    id              text PRIMARY KEY,
    cohort_id       text NOT NULL REFERENCES programmes.cohorts(id) ON DELETE CASCADE,
    name            text NOT NULL,
    max_score       integer NOT NULL CHECK (max_score > 0)
);
CREATE INDEX IF NOT EXISTS programmes_criteria_cohort_idx ON programmes.rubric_criteria (cohort_id);

CREATE TABLE IF NOT EXISTS programmes.judge_assignments (
    id              text PRIMARY KEY,
    cohort_id       text NOT NULL REFERENCES programmes.cohorts(id) ON DELETE CASCADE,
    judge_user_id   text NOT NULL REFERENCES identity.users(id),
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cohort_id, judge_user_id)
);

CREATE TABLE IF NOT EXISTS programmes.judge_scores (
    id              text PRIMARY KEY,
    cohort_id       text NOT NULL REFERENCES programmes.cohorts(id) ON DELETE CASCADE,
    judge_user_id   text NOT NULL REFERENCES identity.users(id),
    entry_user_id   text NOT NULL REFERENCES identity.users(id),
    criterion_id    text NOT NULL REFERENCES programmes.rubric_criteria(id) ON DELETE CASCADE,
    score           integer NOT NULL CHECK (score >= 0),
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (judge_user_id, entry_user_id, criterion_id)  -- one score per judge+entry+criterion
);
CREATE INDEX IF NOT EXISTS programmes_scores_cohort_idx ON programmes.judge_scores (cohort_id, entry_user_id);

CREATE TABLE IF NOT EXISTS programmes.cohort_threads (
    id              text PRIMARY KEY,
    cohort_id       text NOT NULL REFERENCES programmes.cohorts(id) ON DELETE CASCADE,
    title           text NOT NULL,
    author_id       text NOT NULL REFERENCES identity.users(id),
    reply_count     integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS programmes_threads_cohort_idx ON programmes.cohort_threads (cohort_id);

CREATE TABLE IF NOT EXISTS programmes.cohort_thread_posts (
    id              text PRIMARY KEY,
    thread_id       text NOT NULL REFERENCES programmes.cohort_threads(id) ON DELETE CASCADE,
    author_id       text NOT NULL REFERENCES identity.users(id),
    body            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS programmes_posts_thread_idx ON programmes.cohort_thread_posts (thread_id, created_at);

-- ---------------------------------------------------------------------------
-- pathways: student/NYSC templates, enrolments, campus clubs (M12)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS pathways;

CREATE TABLE IF NOT EXISTS pathways.templates (
    id              text PRIMARY KEY,
    track           text NOT NULL CHECK (track IN ('student','nysc')),
    name            text NOT NULL,
    description     text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pathways_templates_track_idx ON pathways.templates (track);

CREATE TABLE IF NOT EXISTS pathways.stages (
    id              text PRIMARY KEY,
    template_id     text NOT NULL REFERENCES pathways.templates(id) ON DELETE CASCADE,
    title           text NOT NULL,
    sequence        integer NOT NULL,
    required_actions text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS pathways_stages_template_idx ON pathways.stages (template_id, sequence);

CREATE TABLE IF NOT EXISTS pathways.enrolments (
    id              text PRIMARY KEY,
    template_id     text NOT NULL REFERENCES pathways.templates(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES identity.users(id),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','dropped')),
    current_stage_id text,
    enrolled_at     timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS pathways_enrolments_user_idx ON pathways.enrolments (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS pathways_enrolments_active_unique
    ON pathways.enrolments (template_id, user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS pathways.stage_progress (
    id              text PRIMARY KEY,
    enrolment_id    text NOT NULL REFERENCES pathways.enrolments(id) ON DELETE CASCADE,
    stage_id        text NOT NULL REFERENCES pathways.stages(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed')),
    evidence        text,                        -- required by the API to complete
    completed_at    timestamptz,
    UNIQUE (enrolment_id, stage_id)
);

CREATE TABLE IF NOT EXISTS pathways.campus_clubs (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    institution     text NOT NULL,
    state           text NOT NULL,
    coordinator_user_id text NOT NULL REFERENCES identity.users(id),
    is_nysc_cds_group boolean NOT NULL DEFAULT false,
    member_count    integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pathways_clubs_state_idx ON pathways.campus_clubs (state, is_nysc_cds_group);

CREATE TABLE IF NOT EXISTS pathways.campus_club_memberships (
    id              text PRIMARY KEY,
    club_id         text NOT NULL REFERENCES pathways.campus_clubs(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES identity.users(id),
    role            text NOT NULL DEFAULT 'member' CHECK (role IN ('member','coordinator')),
    joined_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (club_id, user_id)
);

-- ---------------------------------------------------------------------------
-- knowledge: resource library, podcast episodes, webinars (M14)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS knowledge;

CREATE TABLE IF NOT EXISTS knowledge.resources (
    id              text PRIMARY KEY,
    title           text NOT NULL,
    body            text NOT NULL DEFAULT '',
    tags            text[] NOT NULL DEFAULT '{}',  -- crop/topic tags
    language        text NOT NULL DEFAULT 'en'
                    CHECK (language IN ('en','ha','yo','ig')),
    format          text NOT NULL CHECK (format IN ('article','video','audio','pdf')),
    offline_available boolean NOT NULL DEFAULT false,
    view_count      integer NOT NULL DEFAULT 0,
    published_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_resources_filter_idx ON knowledge.resources (language, format);

CREATE TABLE IF NOT EXISTS knowledge.podcast_episodes (
    id              text PRIMARY KEY,
    title           text NOT NULL,
    show_notes      text NOT NULL DEFAULT '',
    audio_url       text NOT NULL,
    duration_seconds integer NOT NULL CHECK (duration_seconds > 0),
    transcript      text,                        -- accessibility requirement
    published_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge.webinars (
    id              text PRIMARY KEY,
    title           text NOT NULL,
    host_user_id    text NOT NULL REFERENCES identity.users(id),
    starts_at       timestamptz NOT NULL,        -- interpreted in `timezone`
    timezone        text NOT NULL DEFAULT 'Africa/Lagos',
    recording_url   text,                        -- attached post-event by the API
    status          text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','live','completed','cancelled')),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_webinars_status_idx ON knowledge.webinars (status, starts_at);

CREATE TABLE IF NOT EXISTS knowledge.webinar_registrations (
    id              text PRIMARY KEY,
    webinar_id      text NOT NULL REFERENCES knowledge.webinars(id) ON DELETE CASCADE,
    user_id         text NOT NULL REFERENCES identity.users(id),
    registered_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (webinar_id, user_id)
);

-- ---------------------------------------------------------------------------
-- search: query events backing the decayed trending endpoint (M16)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS search;

CREATE TABLE IF NOT EXISTS search.query_events (
    id              text PRIMARY KEY,
    query           text NOT NULL,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_query_events_time_idx ON search.query_events (occurred_at DESC);

COMMIT;
