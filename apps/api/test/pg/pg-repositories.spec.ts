import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
import { createPgEscrowRepository } from '../../src/database/repositories/commerce.pg-repository.js';
import { createPgWebhookDedupeStore } from '../../src/database/repositories/phase3.pg-repository.js';
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
  'opportunities.opportunities',
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

/**
 * Funds-integrity wave: pg-level guarantees that in-memory repos can only
 * simulate. Requires DATABASE_URL (skipped otherwise, like the contracts).
 */
describePg('pg funds-integrity guarantees', () => {
  const escrows = () => createPgEscrowRepository(pool!);
  const orders = () => createPgOrderRepository(pool!);

  beforeAll(async () => {
    if (!pool) return;
    await pool.query(
      `INSERT INTO marketplace.listings (id, seller_id, kind, title, quantity, unit, price_ngn)
       VALUES ('contract-oversell-listing', 'contract-parent-seller', 'produce', 'Oversell guard', 10, 'tonnes', 1000)
       ON CONFLICT (id) DO NOTHING`
    );
  });

  afterEach(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM marketplace.escrow_records WHERE id LIKE 'contract-%'`);
    await pool.query(`DELETE FROM integrations.inbound_events WHERE system LIKE 'contract-%'`);
    await pool.query(`DELETE FROM marketplace.orders WHERE id LIKE 'contract-%'`);
    await pool.query(`UPDATE marketplace.listings SET quantity = 10 WHERE id = 'contract-oversell-listing'`);
  });

  it('conditional UPDATE defeats the concurrent release+refund race', async () => {
    if (!pool) return;
    await orders().placeOrder({
      id: 'contract-order-race',
      listingId: 'contract-oversell-listing',
      buyerId: 'contract-buyer',
      sellerId: 'contract-parent-seller',
      quantity: 1,
      totalNaira: 1000,
      status: 'requested',
      escrowRequired: true,
      createdAt: new Date().toISOString()
    });
    const record = await escrows().create({
      id: 'contract-escrow-race',
      orderId: 'contract-order-race',
      amountKobo: 100_000,
      status: 'held',
      heldAt: new Date().toISOString()
    });
    // Two guarded transitions from the same snapshot: exactly one may win.
    const [first, second] = await Promise.allSettled([
      escrows().updateExpected(record.id, { status: 'released' }, { status: 'held' }),
      escrows().updateExpected(record.id, { status: 'refunded' }, { status: 'held' })
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConflictException);
    const final = await escrows().getById(record.id);
    expect(['released', 'refunded']).toContain(final.status);
  });

  it('decrements listing quantity atomically and rejects oversell', async () => {
    if (!pool) return;
    const place = (id: string, quantity: number) =>
      orders().placeOrder({
        id,
        listingId: 'contract-oversell-listing',
        buyerId: 'contract-buyer',
        sellerId: 'contract-parent-seller',
        quantity,
        totalNaira: quantity * 1000,
        status: 'requested',
        escrowRequired: false,
        createdAt: new Date().toISOString()
      });
    // 10 in stock: concurrent 7 + 7 cannot both succeed.
    const [first, second] = await Promise.allSettled([
      place('contract-order-oversell-a', 7),
      place('contract-order-oversell-b', 7)
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(BadRequestException);
    const stock = await pool.query(`SELECT quantity FROM marketplace.listings WHERE id = 'contract-oversell-listing'`);
    expect(Number(stock.rows[0].quantity)).toBe(3);
  });

  it('persists webhook dedupe receipts across instances (UNIQUE system,dedupe_key)', async () => {
    if (!pool) return;
    const first = createPgWebhookDedupeStore(pool);
    const second = createPgWebhookDedupeStore(pool); // "second API instance"
    const digest = 'a'.repeat(64);
    expect(await first.recordIfNew('contract-paystack', digest, { ref: 1 })).toBe(true);
    expect(await second.recordIfNew('contract-paystack', digest, { ref: 1 })).toBe(false);
    expect(await second.recordIfNew('contract-paystack', 'b'.repeat(64), { ref: 2 })).toBe(true);
  });
});
