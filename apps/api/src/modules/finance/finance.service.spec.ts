import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryCertificateRepository } from '../../database/repositories/certificate.repository.js';
import { createInMemoryCourseRepository } from '../../database/repositories/course.repository.js';
import { createInMemoryCreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import { createInMemoryDocumentRepository } from '../../database/repositories/document.repository.js';
import { createInMemoryEnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { LearningService } from '../learning/learning.service.js';
import { UsersService } from '../users/users.service.js';
import { FinanceService } from './finance.service.js';

/** Seeded user (database/seed-data.ts). */
const USER_ID = 'user-adamu';

const ENV_KEYS = ['NODE_ENV', 'LENDER_CATALOGUE'];
let savedEnv: Record<string, string | undefined> = {};

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const users = new UsersService(createInMemoryUserRepository());
  const learning = new LearningService(
    events,
    createInMemoryCourseRepository(),
    createInMemoryEnrolmentRepository(),
    createInMemoryCertificateRepository()
  );
  const service = new FinanceService(
    events,
    users,
    learning,
    createInMemoryCreditProfileRepository(),
    createInMemoryDocumentRepository()
  );
  return { service };
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

describe('FinanceService.lenderMatches — sample catalogue labelling + production gate (WP-G15)', () => {
  it('non-production: returns the catalogue explicitly labelled as unverified sample data', async () => {
    const { service } = makeService();
    const matches = await service.lenderMatches(USER_ID);
    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(match.source).toBe('sample_catalogue');
      expect(match.verified).toBe(false);
      expect(typeof match.eligible).toBe('boolean');
    }
  });

  it('production: suppresses the sample catalogue with 503 by default (fail closed)', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = makeService();
    await expect(service.lenderMatches(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('production: LENDER_CATALOGUE=sample explicitly opts back into the labelled sample', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LENDER_CATALOGUE = 'sample';
    const { service } = makeService();
    const matches = await service.lenderMatches(USER_ID);
    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(match.source).toBe('sample_catalogue');
      expect(match.verified).toBe(false);
    }
  });

  it('production: unrelated LENDER_CATALOGUE values still fail closed', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LENDER_CATALOGUE = 'live';
    const { service } = makeService();
    await expect(service.lenderMatches(USER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });
});
