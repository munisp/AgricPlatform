import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
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
import { InMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from '../users/users.service.js';
import type { NdviProvider } from './ndvi.provider.js';
import {
  groupCashAccountCode,
  memberSavingsAccountCode,
  VslaCarbonService
} from './vsla-carbon.service.js';

/**
 * WP-G11 (Stage 27, V2 idempotency-consistency audit): VSLA contribute
 * idempotency-record semantics — the canonical payload hash is stored with
 * the client key, so the same key with a DIFFERENT payload fails closed
 * with 409 IDEMPOTENCY_PAYLOAD_MISMATCH instead of silently replaying the
 * original contribution (the pre-fix behavior: findByIdempotencyKey hit
 * returned the stored record unconditionally).
 */

const lead = { id: 'user-lead', roles: ['chapter_lead'] } as unknown as User;
const farmer = { id: 'user-farmer', roles: ['farmer'] } as unknown as User;
const admin = { id: 'user-admin', roles: ['admin'] } as unknown as User;

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

const chaptersStub = {
  getById: (id: string) =>
    id === 'chapter-1'
      ? Promise.resolve({ id, name: 'Kano Chapter' })
      : Promise.reject(new Error(`Chapter '${id}' not found`))
};

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const contributions = createInMemoryVslaContributionRepository();
  const service = new VslaCarbonService(
    createInMemoryVslaGroupRepository(),
    createInMemoryVslaMemberRepository(),
    createInMemoryVslaCycleRepository(),
    contributions,
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
    chaptersStub as never,
    undefined,
    undefined,
    // OB-14: leadership grants consult the user directory; fixture actors are
    // OTP-verified accounts here.
    new UsersService(
      new InMemoryUserRepository(
        [lead, farmer, admin].map((actor, index) => ({
          ...actor,
          phone: `+2348000000${String(index + 10)}`,
          fullName: actor.id,
          preferredLanguage: 'en',
          kycTier: 'tier_0',
          isVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z'
        }))
      )
    )
  );
  return { service, ledger, contributions };
}

async function makeGroupWithCycle(service: VslaCarbonService) {
  const group = await service.createGroup(lead, { name: 'Kano Women Savings' });
  const member2 = await service.addMember(lead, group.id, { userId: farmer.id });
  const leadMember = (await service.listMembers(admin, group.id)).find((m) => m.userId === lead.id);
  const cycle = await service.openCycle(lead, group.id, '2026 Cycle 1');
  return { group, cycle, leadMember: leadMember!, member2 };
}

describe('WP-G11: VSLA contribute idempotency payload consistency', () => {
  it('same key + same payload replays the original contribution exactly once', async () => {
    const { service, ledger, contributions } = makeService();
    const { group, cycle, leadMember } = await makeGroupWithCycle(service);
    const input = { memberId: leadMember.id, amountKobo: 100_000, idempotencyKey: 'c-replay' };
    const first = await service.contribute(lead, cycle.id, input);
    const replay = await service.contribute(lead, cycle.id, { ...input });
    expect(replay.id).toBe(first.id);
    expect(replay.ledgerEntryId).toBe(first.ledgerEntryId);
    expect(replay.payloadHash).toBe(first.payloadHash);
    expect(await contributions.find({ cycleId: cycle.id })).toHaveLength(1);
    expect(await ledger.listEntries({ referenceType: 'vsla_contribution' })).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(100_000);
  });

  it('same key + different amount is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH and posts nothing new', async () => {
    const { service, ledger, contributions } = makeService();
    const { group, cycle, leadMember } = await makeGroupWithCycle(service);
    await service.contribute(lead, cycle.id, {
      memberId: leadMember.id,
      amountKobo: 100_000,
      idempotencyKey: 'c-mismatch'
    });
    await expect(
      service.contribute(lead, cycle.id, {
        memberId: leadMember.id,
        amountKobo: 150_000, // same key, different payload
        idempotencyKey: 'c-mismatch'
      })
    ).rejects.toThrowError(ConflictException);
    await expect(
      service.contribute(lead, cycle.id, {
        memberId: leadMember.id,
        amountKobo: 150_000,
        idempotencyKey: 'c-mismatch'
      })
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    // The conflicting retry moved no money and created no record.
    expect(await contributions.find({ cycleId: cycle.id })).toHaveLength(1);
    expect(await ledger.listEntries({ referenceType: 'vsla_contribution' })).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(100_000);
  });

  it('same key + different member is a 409', async () => {
    const { service } = makeService();
    const { cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await service.contribute(lead, cycle.id, {
      memberId: leadMember.id,
      amountKobo: 10_000,
      idempotencyKey: 'c-member-mismatch'
    });
    await expect(
      service.contribute(lead, cycle.id, {
        memberId: member2.id,
        amountKobo: 10_000,
        idempotencyKey: 'c-member-mismatch'
      })
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  });

  it('concurrent twins with the same key and payload converge on exactly ONE contribution', async () => {
    const { service, ledger, contributions } = makeService();
    const { group, cycle, leadMember } = await makeGroupWithCycle(service);
    const input = { memberId: leadMember.id, amountKobo: 50_000, idempotencyKey: 'c-twin' };
    const [a, b] = await Promise.allSettled([
      service.contribute(lead, cycle.id, input),
      service.contribute(lead, cycle.id, { ...input })
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const first = (a as PromiseFulfilledResult<Awaited<ReturnType<typeof service.contribute>>>).value;
    const second = (b as PromiseFulfilledResult<Awaited<ReturnType<typeof service.contribute>>>).value;
    expect(second.id).toBe(first.id);
    expect(await contributions.find({ cycleId: cycle.id })).toHaveLength(1);
    expect(await ledger.listEntries({ referenceType: 'vsla_contribution' })).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(50_000);
  });

  it('a concurrent twin with a DIFFERENT payload loses the race and 409s', async () => {
    const { service, contributions } = makeService();
    const { cycle, leadMember } = await makeGroupWithCycle(service);
    const [a, b] = await Promise.allSettled([
      service.contribute(lead, cycle.id, {
        memberId: leadMember.id,
        amountKobo: 50_000,
        idempotencyKey: 'c-twin-mismatch'
      }),
      service.contribute(lead, cycle.id, {
        memberId: leadMember.id,
        amountKobo: 75_000,
        idempotencyKey: 'c-twin-mismatch'
      })
    ]);
    const fulfilled = [a, b].filter((result) => result.status === 'fulfilled');
    const rejected = [a, b].filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    // Exactly one contribution persisted.
    expect(await contributions.find({ cycleId: cycle.id })).toHaveLength(1);
  });

  it('a legacy record without a stored hash still replays (pre-061 rows)', async () => {
    const { service, ledger, contributions } = makeService();
    const { group, cycle, leadMember } = await makeGroupWithCycle(service);
    const entry = await ledger.postEntry(
      {
        idempotencyKey: 'vsla-contribution:c-legacy',
        referenceType: 'vsla_contribution',
        referenceId: cycle.id,
        description: 'legacy row',
        postings: [
          { accountCode: groupCashAccountCode(group.id), direction: 'debit', amountKobo: 40_000 },
          {
            accountCode: memberSavingsAccountCode(group.id, lead.id),
            direction: 'credit',
            amountKobo: 40_000
          }
        ]
      },
      lead.id
    );
    await contributions.create({
      id: 'legacy-contrib',
      cycleId: cycle.id,
      groupId: group.id,
      memberId: leadMember.id,
      amountKobo: 40_000,
      idempotencyKey: 'c-legacy',
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
      // no payloadHash — predates WP-G11
    });
    const replay = await service.contribute(lead, cycle.id, {
      memberId: leadMember.id,
      amountKobo: 40_000,
      idempotencyKey: 'c-legacy'
    });
    expect(replay.id).toBe('legacy-contrib');
  });
});
