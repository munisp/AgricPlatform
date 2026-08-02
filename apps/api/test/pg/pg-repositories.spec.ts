import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPgCertificateRepository } from '../../src/database/repositories/learning.pg-repository.js';
import {
  createPgCourseRepository,
  createPgEnrolmentRepository
} from '../../src/database/repositories/learning.pg-repository.js';
import { createPgConsentRepository } from '../../src/database/repositories/privacy.pg-repository.js';
import {
  createPgForumTopicRepository,
  createPgTopicFlagRepository
} from '../../src/database/repositories/community.pg-repository.js';
import { createPgOpportunityRepository } from '../../src/database/repositories/opportunities.pg-repository.js';
import {
  createPgListingRepository,
  createPgOrderRepository
} from '../../src/database/repositories/marketplace.pg-repository.js';
import { createPgUserRepository } from '../../src/database/repositories/user.pg-repository.js';
import { contractCases } from '../contract/cases.js';
import { runRepositoryContract } from '../contract/repository.contract.js';

/**
 * PostgreSQL repository contract suite (plan §9.3). Skipped unless
 * DATABASE_URL points at a database with the 001_init.sql schema applied:
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const CONTRACT_TABLES = [
  'opportunities.applications',
  'marketplace.reviews',
  'marketplace.orders',
  'marketplace.listings',
  'community.topic_flags',
  'community.forum_topics',
  'learning.certificates',
  'learning.enrolments',
  'learning.courses',
  'privacy.consent_records',
  'identity.user_roles',
  'identity.users'
];

async function cleanContractRows(): Promise<void> {
  if (!pool) return;
  for (const table of CONTRACT_TABLES) {
    const idColumn = table === 'identity.user_roles' ? 'user_id' : 'id';
    await pool.query(
      `DELETE FROM ${table} WHERE ${idColumn} LIKE 'contract-%' AND ${idColumn} NOT LIKE 'contract-parent-%'`
    );
  }
}

describePg('pg repository contracts', () => {
  beforeAll(async () => {
    await cleanContractRows();
    // FK parents referenced by the contract fixtures (never cleaned).
    await pool!.query(
      `INSERT INTO learning.courses (id, title) VALUES ('contract-parent-course', 'Contract parent')
       ON CONFLICT (id) DO NOTHING`
    );
    await pool!.query(
      `INSERT INTO community.forum_topics (id, title, category, author_id)
       VALUES ('contract-parent-topic', 'Contract parent', 'crops', 'contract-parent-author')
       ON CONFLICT (id) DO NOTHING`
    );
    await pool!.query(
      `INSERT INTO marketplace.listings (id, seller_id, kind, title, quantity, unit, price_ngn)
       VALUES ('contract-parent-listing', 'contract-parent-seller', 'produce', 'Contract parent', 100, 'tonnes', 1000)
       ON CONFLICT (id) DO NOTHING`
    );
  });

  afterEach(async () => {
    await cleanContractRows();
  });

  const bind = (name: string): unknown => {
    if (!pool) throw new Error('DATABASE_URL required');
    switch (name) {
      case 'user':
        return createPgUserRepository(pool);
      case 'course':
        return createPgCourseRepository(pool);
      case 'enrolment':
        return createPgEnrolmentRepository(pool);
      case 'certificate':
        return createPgCertificateRepository(pool);
      case 'forumTopic':
        return createPgForumTopicRepository(pool);
      case 'topicFlag':
        return createPgTopicFlagRepository(pool);
      case 'opportunity':
        return createPgOpportunityRepository(pool);
      case 'listing':
        return createPgListingRepository(pool);
      case 'order':
        return createPgOrderRepository(pool);
      case 'consent':
        return createPgConsentRepository(pool);
      default:
        throw new Error(`unknown contract repo ${name}`);
    }
  };

  for (const testCase of contractCases(bind)) {
    runRepositoryContract(testCase);
  }

  it('allocates certificate codes from the DB counter without collisions', async () => {
    if (!pool) return;
    const certificates = createPgCertificateRepository(pool);
    const [a, b] = await Promise.all([
      certificates.allocateVerificationCode(),
      certificates.allocateVerificationCode()
    ]);
    expect(a).toMatch(/^NYFN-CERT-\d{4}-\d{4}$/);
    expect(b).toMatch(/^NYFN-CERT-\d{4}-\d{4}$/);
    expect(a).not.toBe(b);
  });
});
