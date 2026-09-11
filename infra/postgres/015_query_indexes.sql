-- 015_query_indexes.sql — schema-audit index remediation (Stage 12a).
-- Adds indexes for query patterns proven by repository criteria objects,
-- plus the one missing intra-schema FK. All statements are idempotent.
-- Source: schema audit @ f0c3024 (docs/schema-audit-2026-08.md findings).

-- High priority: unindexed FK / frequent filter columns -------------------
CREATE INDEX IF NOT EXISTS events_chapter_idx
  ON chapters.events (chapter_id, starts_at);
CREATE INDEX IF NOT EXISTS announcements_chapter_idx
  ON chapters.announcements (chapter_id);
CREATE INDEX IF NOT EXISTS event_participation_user_idx
  ON chapters.event_participation (user_id);
CREATE INDEX IF NOT EXISTS certificates_user_idx
  ON learning.certificates (user_id);
CREATE INDEX IF NOT EXISTS enrolments_course_idx
  ON learning.enrolments (course_id);
CREATE INDEX IF NOT EXISTS documents_user_idx
  ON finance.documents (user_id, status);
CREATE INDEX IF NOT EXISTS data_requests_user_idx
  ON privacy.data_requests (user_id);
CREATE INDEX IF NOT EXISTS mentor_requests_user_idx
  ON community.mentor_requests (user_id, status);
CREATE INDEX IF NOT EXISTS topic_flags_status_idx
  ON community.topic_flags (status);
CREATE INDEX IF NOT EXISTS topic_flags_topic_idx
  ON community.topic_flags (topic_id);
CREATE INDEX IF NOT EXISTS delivery_logs_notification_idx
  ON notifications.delivery_logs (notification_id);
CREATE INDEX IF NOT EXISTS ledger_entries_transfer_idx
  ON finance.ledger_entries (transfer_id);
CREATE INDEX IF NOT EXISTS loan_applications_lender_idx
  ON finance.loan_applications (lender_id);
CREATE INDEX IF NOT EXISTS ownership_transfers_from_idx
  ON livestock.ownership_transfers (from_user_id);
CREATE INDEX IF NOT EXISTS ownership_transfers_to_idx
  ON livestock.ownership_transfers (to_user_id);
CREATE INDEX IF NOT EXISTS import_records_nin_idx
  ON integrations.import_records (nin_hash);
CREATE INDEX IF NOT EXISTS import_records_phone_idx
  ON integrations.import_records (phone_hash);

-- Medium priority: composite directory filters ----------------------------
CREATE INDEX IF NOT EXISTS courses_filter_idx
  ON learning.courses (category, level, language);
CREATE INDEX IF NOT EXISTS opportunities_type_active_idx
  ON opportunities.opportunities (type, is_active);
CREATE INDEX IF NOT EXISTS listings_kind_state_idx
  ON marketplace.listings (kind, location_state) WHERE is_active;
CREATE INDEX IF NOT EXISTS webinars_host_idx
  ON knowledge.webinars (host_user_id);
CREATE INDEX IF NOT EXISTS webinar_registrations_user_idx
  ON knowledge.webinar_registrations (user_id);
CREATE INDEX IF NOT EXISTS club_memberships_user_idx
  ON pathways.campus_club_memberships (user_id);
CREATE INDEX IF NOT EXISTS judge_assignments_judge_idx
  ON programmes.judge_assignments (judge_user_id);
CREATE INDEX IF NOT EXISTS chapters_parent_idx
  ON chapters.chapters (parent_id);
CREATE INDEX IF NOT EXISTS chapters_state_idx
  ON chapters.chapters (state);
CREATE INDEX IF NOT EXISTS member_profiles_state_idx
  ON profiles.member_profiles (state);

-- GIN: array containment queries (tags @>, states @>, value_chains &&) ----
CREATE INDEX IF NOT EXISTS knowledge_resources_tags_gin
  ON knowledge.resources USING gin (tags);
CREATE INDEX IF NOT EXISTS opportunities_states_gin
  ON opportunities.opportunities USING gin (states);
CREATE INDEX IF NOT EXISTS opportunities_value_chains_gin
  ON opportunities.opportunities USING gin (value_chains);

-- Missing intra-schema FK (pathways enrolment -> current stage) -----------
-- Guarded via pg_constraint (019a pattern): PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS, so a re-apply (e.g. migrate after a
-- Compose-bootstrapped database) would die with 'constraint already exists'.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'enrolments_current_stage_fk'
    ) THEN
        ALTER TABLE pathways.enrolments
            ADD CONSTRAINT enrolments_current_stage_fk
            FOREIGN KEY (current_stage_id) REFERENCES pathways.stages(id);
    END IF;
END $$;
