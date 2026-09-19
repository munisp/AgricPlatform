import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryUserRepository } from '../../database/repositories/user.repository.js';
import {
  createInMemoryCarbonEstimateRepository,
  createInMemoryCarbonEvidenceRepository,
  createInMemoryCarbonPlotRepository,
  createInMemoryVslaContributionRepository,
  createInMemoryVslaCycleRepository,
  createInMemoryVslaGroupRepository,
  createInMemoryVslaLoanRepository,
  createInMemoryVslaLoanRepaymentRepository,
  createInMemoryVslaMemberRepository,
  createInMemoryVslaShareOutPlanRepository,
  createInMemoryVslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { UsersService } from '../users/users.service.js';
import type { NdviProvider } from './ndvi.provider.js';
import { VslaCarbonService } from './vsla-carbon.service.js';

/**
 * OB-14: VSLA group leadership (role 'lead') requires a verified identity
 * (isVerified === true or kycTier !== 'tier_0'); plain membership stays open
 * to unverified tier_0 accounts. Fails closed when the user directory is not
 * wired.
 */

const lead = { id: 'user-lead', roles: ['chapter_lead'] } as unknown as User;

const stubNdvi: NdviProvider = {
  name: 'stub',
  assess: () =>
    Promise.resolve({
      plotId: 'plot',
      season: '2026-wet',
      healthScore: 64,
      classification: 'normal',
      basis: 'stub'
    }),
  status: () => Promise.resolve({ configured: true, healthy: true, detail: 'stub' })
};

function directoryUser(
  id: string,
  roles: User['roles'],
  overrides: Partial<User> = {}
): User {
  return {
    id,
    phone: `+234807${id.length}${id.length}77`,
    fullName: id,
    roles,
    preferredLanguage: 'en',
    kycTier: 'tier_0',
    isVerified: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeService(users?: UsersService) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  return new VslaCarbonService(
    createInMemoryVslaGroupRepository(),
    createInMemoryVslaMemberRepository(),
    createInMemoryVslaCycleRepository(),
    createInMemoryVslaContributionRepository(),
    createInMemoryVslaShareOutRepository(),
    createInMemoryVslaShareOutPlanRepository(),
    createInMemoryVslaLoanRepository(),
    createInMemoryVslaLoanRepaymentRepository(),
    createInMemoryCarbonPlotRepository(),
    createInMemoryCarbonEvidenceRepository(),
    createInMemoryCarbonEstimateRepository(),
    ledger,
    new H3Service(),
    events,
    stubNdvi,
    undefined,
    undefined,
    undefined,
    users
  );
}

function makeDirectory(extra: User[] = []): UsersService {
  return new UsersService(
    new InMemoryUserRepository([
      directoryUser('user-lead', ['chapter_lead'], { isVerified: true }),
      ...extra
    ])
  );
}

describe('VSLA leadership verification (OB-14)', () => {
  it('rejects an unverified tier_0 account as group lead at creation', async () => {
    const unverifiedLead = directoryUser('user-newlead', ['chapter_lead']);
    const service = makeService(makeDirectory([unverifiedLead]));
    await expect(service.createGroup(unverifiedLead, { name: 'Ghost Group' })).rejects.toThrow(
      ForbiddenException
    );
    // No half-created group persists.
    expect(await service.listGroups(makeAdmin())).toEqual([]);
  });

  it('accepts a verified lead at creation', async () => {
    const service = makeService(makeDirectory());
    const group = await service.createGroup(lead, { name: 'Kano Women Savings' });
    const members = await service.listMembers(lead, group.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: lead.id, role: 'lead' });
  });

  it('rejects a leadership grant to an unverified member but allows plain membership', async () => {
    const unverified = directoryUser('user-unverified', ['farmer']);
    const service = makeService(makeDirectory([unverified]));
    const group = await service.createGroup(lead, { name: 'G' });

    await expect(
      service.addMember(lead, group.id, { userId: unverified.id, role: 'lead' })
    ).rejects.toThrow(ForbiddenException);

    // Plain membership stays open.
    const member = await service.addMember(lead, group.id, { userId: unverified.id });
    expect(member.role).toBe('member');
  });

  it('accepts a leadership grant to an OTP-verified or KYC-tiered account', async () => {
    const verified = directoryUser('user-verified', ['farmer'], { isVerified: true });
    const kycTiered = directoryUser('user-kyc', ['farmer'], { kycTier: 'tier_1' });
    const service = makeService(makeDirectory([verified, kycTiered]));
    const group = await service.createGroup(lead, { name: 'G' });

    await expect(
      service.addMember(lead, group.id, { userId: verified.id, role: 'lead' })
    ).resolves.toMatchObject({ role: 'lead' });
    await expect(
      service.addMember(lead, group.id, { userId: kycTiered.id, role: 'lead' })
    ).resolves.toMatchObject({ role: 'lead' });
  });

  it('fails closed when the user directory is not wired', async () => {
    const service = makeService(undefined);
    // createGroup internally onboards the lead as 'lead' — without a user
    // directory the verification gate cannot be evaluated, so it refuses.
    await expect(service.createGroup(lead, { name: 'G' })).rejects.toThrow(
      ServiceUnavailableException
    );
  });
});

function makeAdmin(): User {
  return { id: 'user-admin', roles: ['admin'] } as unknown as User;
}
