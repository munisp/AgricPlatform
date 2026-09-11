import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Lender } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { lenderMapper } from '../../database/pg/row-mappers.js';
import { createInMemoryCertificateRepository } from '../../database/repositories/certificate.repository.js';
import { createInMemoryCourseRepository } from '../../database/repositories/course.repository.js';
import { createInMemoryCreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import { createInMemoryDocumentRepository } from '../../database/repositories/document.repository.js';
import { createInMemoryEnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import {
  createInMemoryLenderRepository,
  InMemoryLenderRepository
} from '../../database/repositories/lender.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { seedLenders } from '../../database/seed-data.js';
import { LearningService } from '../learning/learning.service.js';
import { UsersService } from '../users/users.service.js';
import { FinanceService } from './finance.service.js';

/** Seeded user (database/seed-data.ts). */
const USER_ID = 'user-adamu';

const ENV_KEYS = ['NODE_ENV', 'LENDER_CATALOGUE'];
let savedEnv: Record<string, string | undefined> = {};

function makeService(lenders?: InMemoryLenderRepository) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const users = new UsersService(createInMemoryUserRepository());
  const learning = new LearningService(
    events,
    createInMemoryCourseRepository(),
    createInMemoryEnrolmentRepository(),
    createInMemoryCertificateRepository()
  );
  const lenderRepo = lenders ?? createInMemoryLenderRepository();
  const service = new FinanceService(
    events,
    users,
    learning,
    createInMemoryCreditProfileRepository(),
    createInMemoryDocumentRepository(),
    lenderRepo
  );
  return { service, lenderRepo };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.NODE_ENV;
  delete process.env.LENDER_CATALOGUE;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('lender catalogue repository (WP-G18)', () => {
  it('in-memory repository seeds carry explicit sample provenance labels', async () => {
    const repo = createInMemoryLenderRepository();
    const all = await repo.all();
    expect(all).toHaveLength(3);
    for (const lender of all) {
      expect(lender.source).toBe('sample_catalogue');
      expect(lender.verified).toBe(false);
    }
  });

  it('lenderMapper round-trips source + verified columns (finance.lenders, migration 062)', () => {
    const lender: Lender = {
      id: 'lender-test',
      name: 'Test Lender',
      product: 'Working capital',
      minTicketKobo: 100,
      maxTicketKobo: 200,
      minScore: 50,
      criteria: ['Credit score 50+'],
      isActive: true,
      source: 'admin_registered',
      verified: true
    };
    const row = lenderMapper.toRow(lender);
    expect(row.source).toBe('admin_registered');
    expect(row.verified).toBe(true);
    expect(lenderMapper.columns).toContain('source');
    expect(lenderMapper.columns).toContain('verified');
    const back = lenderMapper.fromRow({
      ...row,
      min_ticket_kobo: '100',
      max_ticket_kobo: '200'
    });
    expect(back).toEqual(lender);
  });
});

describe('FinanceService.lenderMatches — DB-served catalogue with provenance labels (WP-G18)', () => {
  it('serves matches from the lender repository, each labelled source + verified', async () => {
    const { service } = makeService();
    const matches = await service.lenderMatches(USER_ID);
    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.lender)).toEqual([
      'NYFN Cooperative Credit Window',
      'Partner MFI Network',
      'Commercial Agri Desk'
    ]);
    for (const match of matches) {
      expect(match.source).toBe('sample_catalogue');
      expect(match.verified).toBe(false);
      expect(typeof match.eligible).toBe('boolean');
    }
    // Ticket amounts map kobo → naira.
    expect(matches[0].maxAmountNaira).toBe(500000);
  });

  it('labels ops-registered and verified lenders from their catalogue row', async () => {
    const lenderRepo = new InMemoryLenderRepository([
      ...seedLenders,
      {
        id: 'lender-vetted',
        name: 'Vetted Agri Bank',
        product: 'Term loan',
        minTicketKobo: 0,
        maxTicketKobo: 100_000_000,
        minScore: 10,
        criteria: ['Credit score 10+'],
        isActive: true,
        source: 'admin_registered',
        verified: true
      }
    ]);
    const { service } = makeService(lenderRepo);
    const matches = await service.lenderMatches(USER_ID);
    const vetted = matches.find((match) => match.lender === 'Vetted Agri Bank');
    expect(vetted).toBeDefined();
    expect(vetted?.source).toBe('admin_registered');
    expect(vetted?.verified).toBe(true);
    expect(vetted?.eligible).toBe(true);
  });

  it('excludes inactive catalogue rows', async () => {
    const lenderRepo = new InMemoryLenderRepository([
      { ...seedLenders[0], isActive: false },
      seedLenders[1],
      seedLenders[2]
    ]);
    const { service } = makeService(lenderRepo);
    const matches = await service.lenderMatches(USER_ID);
    expect(matches.map((match) => match.lender)).toEqual([
      'Partner MFI Network',
      'Commercial Agri Desk'
    ]);
  });

  it('an all-inactive catalogue counts as empty: production fails closed with 503', async () => {
    process.env.NODE_ENV = 'production';
    const lenderRepo = new InMemoryLenderRepository([{ ...seedLenders[0], isActive: false }]);
    const { service } = makeService(lenderRepo);
    await expect(service.lenderMatches(USER_ID)).rejects.toThrow('LENDER_CATALOGUE_UNAVAILABLE');
  });

  it('production + empty catalogue fails closed with 503 (LENDER_CATALOGUE_UNAVAILABLE)', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = makeService(new InMemoryLenderRepository());
    await expect(service.lenderMatches(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    await expect(service.lenderMatches(USER_ID)).rejects.toThrow('LENDER_CATALOGUE_UNAVAILABLE');
  });

  it('production + empty catalogue + LENDER_CATALOGUE=sample serves the explicitly-labelled sample', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LENDER_CATALOGUE = 'sample';
    const { service } = makeService(new InMemoryLenderRepository());
    const matches = await service.lenderMatches(USER_ID);
    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(match.source).toBe('sample_catalogue');
      expect(match.verified).toBe(false);
    }
  });

  it('production + non-empty catalogue serves DB rows without the sample opt-in', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = makeService();
    const matches = await service.lenderMatches(USER_ID);
    expect(matches).toHaveLength(3);
    expect(matches.every((match) => match.source === 'sample_catalogue')).toBe(true);
  });

  it('non-production + empty catalogue keeps the labelled sample fallback (pre-WP-G18 dev behaviour)', async () => {
    const { service } = makeService(new InMemoryLenderRepository());
    const matches = await service.lenderMatches(USER_ID);
    expect(matches).toHaveLength(3);
    expect(matches.every((match) => match.verified === false)).toBe(true);
  });
});
