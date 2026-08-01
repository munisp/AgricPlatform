/**
 * Seed CLI (persistence wave plan §5). Loads the API demo seed data into
 * PostgreSQL idempotently (ON CONFLICT DO NOTHING), replacing the demo rows
 * that used to live in 001_init.sql. Requires migrations to be applied
 * first (npm run migrate).
 *
 * Usage: DATABASE_URL=postgres://… npm run seed -w @agric-platform/api
 */
import pg from 'pg';
import {
  seedAdvisory,
  seedChapters,
  seedCourses,
  seedListings,
  seedOpportunities
} from '@agric-platform/shared';
import {
  seedAnnouncements,
  seedApplications,
  seedCertificates,
  seedChapterEvents,
  seedConsents,
  seedCreditProfiles,
  seedEnrolments,
  seedEventRsvps,
  seedForumTopics,
  seedMentorRequests,
  seedNotificationMessages,
  seedNotificationPreferences,
  seedOrders,
  seedProfiles,
  seedUsers,
  seedVaultDocuments
} from './seed-data.js';
import {
  advisoryMapper,
  announcementMapper,
  applicationMapper,
  certificateMapper,
  chapterEventMapper,
  chapterMapper,
  consentMapper,
  courseMapper,
  creditProfileMapper,
  documentMapper,
  enrolmentMapper,
  eventRsvpMapper,
  forumTopicMapper,
  listingMapper,
  mentorRequestMapper,
  notificationMapper,
  notificationPreferenceMapper,
  opportunityMapper,
  orderMapper,
  profileMapper,
  userMapper
} from './pg/row-mappers.js';
import type { RowMapper } from './pg/pg-repository.base.js';

async function upsertAll<T>(
  pool: pg.Pool,
  table: string,
  mapper: RowMapper<T>,
  items: readonly T[],
  conflict: string
): Promise<void> {
  for (const item of items) {
    const row = mapper.toRow(item);
    const columns = Object.keys(row);
    await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (${conflict}) DO NOTHING`,
      columns.map((column) => row[column])
    );
  }
  console.log(`seed: ${table} — ${items.length} row(s) ensured`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    for (const user of seedUsers) {
      const row = userMapper.toRow(user);
      const columns = Object.keys(row);
      await pool.query(
        `INSERT INTO identity.users (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (id) DO NOTHING`,
        columns.map((column) => row[column])
      );
      for (const role of user.roles) {
        await pool.query(
          'INSERT INTO identity.user_roles (user_id, role_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [user.id, role]
        );
      }
    }
    console.log(`seed: identity.users — ${seedUsers.length} row(s) ensured`);

    await upsertAll(pool, 'profiles.member_profiles', profileMapper, seedProfiles, 'user_id');
    await upsertAll(pool, 'privacy.consent_records', consentMapper, seedConsents, 'id');
    await upsertAll(pool, 'learning.courses', courseMapper, seedCourses, 'id');
    await upsertAll(pool, 'learning.enrolments', enrolmentMapper, seedEnrolments, 'id');
    await upsertAll(pool, 'learning.certificates', certificateMapper, seedCertificates, 'id');
    // Counter baseline matches the seeded NYFN-CERT-2026-0001 certificate.
    await pool.query(
      'INSERT INTO learning.certificate_counters (year, next) VALUES (2026, 2) ON CONFLICT (year) DO NOTHING'
    );
    await upsertAll(pool, 'community.forum_topics', forumTopicMapper, seedForumTopics, 'id');
    await upsertAll(pool, 'community.mentor_requests', mentorRequestMapper, seedMentorRequests, 'id');
    await upsertAll(pool, 'opportunities.opportunities', opportunityMapper, seedOpportunities, 'id');
    await upsertAll(pool, 'opportunities.applications', applicationMapper, seedApplications, 'id');
    await upsertAll(pool, 'chapters.chapters', chapterMapper, seedChapters, 'id');
    await upsertAll(pool, 'chapters.events', chapterEventMapper, seedChapterEvents, 'id');
    await upsertAll(pool, 'chapters.event_participation', eventRsvpMapper, seedEventRsvps, 'id');
    await upsertAll(pool, 'chapters.announcements', announcementMapper, seedAnnouncements, 'id');
    await upsertAll(pool, 'advisory.items', advisoryMapper, seedAdvisory, 'id');
    await upsertAll(pool, 'marketplace.listings', listingMapper, seedListings, 'id');
    await upsertAll(pool, 'marketplace.orders', orderMapper, seedOrders, 'id');
    await upsertAll(pool, 'finance.credit_profiles', creditProfileMapper, seedCreditProfiles, 'user_id');
    await upsertAll(pool, 'finance.documents', documentMapper, seedVaultDocuments, 'id');
    await upsertAll(pool, 'notifications.notifications', notificationMapper, seedNotificationMessages, 'id');
    await upsertAll(
      pool,
      'notifications.user_preferences',
      notificationPreferenceMapper,
      seedNotificationPreferences,
      'user_id, channel'
    );
    console.log('seed: complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`seed: FAILED — ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
