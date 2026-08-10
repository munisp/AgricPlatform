import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, InsurancePolicy, LivestockLot, User } from '@agric-platform/shared';
import { LIVESTOCK_RECALL_INITIATED_EVENT } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import {
  createInMemoryInsuranceClaimRepository,
  createInMemoryInsurancePolicyRepository
} from '../../database/repositories/livestock-trade.repository.js';
import { FailClosedInsuranceProvider, ProviderNotConfiguredError } from './provider-stubs.js';
import { InsuranceService } from './insurance.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const farmer = asUser('farmer-1', ['farmer']);
const other = asUser('farmer-2', ['farmer']);
const insurer = asUser('insurer-1', ['insurer']);
const admin = asUser('admin-1', ['admin']);

const animal: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: farmer.id,
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const lot: LivestockLot = {
  id: 'LOT-AVI-KD-000001',
  species: 'chicken',
  quantity: 500,
  ownerUserId: farmer.id,
  state: 'Kaduna',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const quoteInput = {
  subjectType: 'animal' as const,
  subjectId: animal.id,
  premiumKobo: 12_000_00,
  coverageKobo: 300_000_00
};

describe('InsuranceService', () => {
  let lots: ReturnType<typeof createInMemoryLotRepository>;
  let policies: ReturnType<typeof createInMemoryInsurancePolicyRepository>;
  let claims: ReturnType<typeof createInMemoryInsuranceClaimRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let events: DomainEventsService;
  let provider: { provider: string; bindPolicy: ReturnType<typeof vi.fn> };
  let service: InsuranceService;

  beforeEach(() => {
    lots = createInMemoryLotRepository([lot]);
    policies = createInMemoryInsurancePolicyRepository();
    claims = createInMemoryInsuranceClaimRepository();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    events = new DomainEventsService(outbox);
    provider = {
      provider: 'fake-underwriter',
      bindPolicy: vi.fn().mockResolvedValue({ providerRef: 'uw-123' })
    };
    service = new InsuranceService(
      audit as never,
      events,
      createInMemoryAnimalRepository(createInMemoryOwnershipTransferRepository(), [animal]),
      lots,
      policies,
      claims,
      provider
    );
    service.onModuleInit();
  });

  async function boundPolicy(): Promise<InsurancePolicy> {
    const policy = await service.quote(farmer, quoteInput);
    return service.bind(insurer, policy.id);
  }

  it('creates a quote for owned livestock with integer kobo validation', async () => {
    const policy = await service.quote(farmer, quoteInput);
    expect(policy.status).toBe('quote');
    expect(policy.holderUserId).toBe(farmer.id);
    expect(policy.species).toBe('cattle');
    await expect(
      service.quote(farmer, { ...quoteInput, premiumKobo: 9.99 })
    ).rejects.toThrow('kobo');
  });

  it('blocks quoting livestock the caller does not own', async () => {
    await expect(service.quote(other, quoteInput)).rejects.toThrow('your own livestock');
  });

  it('binds a quote via the provider (insurer role only)', async () => {
    const policy = await service.quote(farmer, quoteInput);
    await expect(service.bind(farmer, policy.id)).rejects.toThrow('insurer');
    const bound = await service.bind(insurer, policy.id);
    expect(bound.status).toBe('bound');
    expect(bound.insurerUserId).toBe(insurer.id);
    expect(provider.bindPolicy).toHaveBeenCalledOnce();
  });

  it('fails closed when no underwriter is configured', async () => {
    const closed = new InsuranceService(
      audit as never,
      events,
      createInMemoryAnimalRepository(createInMemoryOwnershipTransferRepository(), [animal]),
      lots,
      policies,
      claims,
      new FailClosedInsuranceProvider()
    );
    const policy = await closed.quote(farmer, quoteInput);
    await expect(closed.bind(insurer, policy.id)).rejects.toThrow(ProviderNotConfiguredError);
    // The policy stays a quote when the provider fails closed.
    expect((await policies.getById(policy.id)).status).toBe('quote');
  });

  it('lapses and cancels only from valid states', async () => {
    const bound = await boundPolicy();
    await expect(service.lapse(farmer, bound.id)).rejects.toThrow('insurer of record');
    const lapsed = await service.lapse(insurer, bound.id);
    expect(lapsed.status).toBe('lapsed');
    await expect(service.cancel(admin, bound.id)).rejects.toThrow('Invalid policy transition');

    const second = await boundPolicy();
    const cancelled = await service.cancel(farmer, second.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('walks a manual claim submitted → assessed → paid', async () => {
    const policy = await boundPolicy();
    const claim = await service.submitClaim(farmer, {
      policyId: policy.id,
      animalIds: [animal.id],
      amountKobo: 100_000_00,
      notes: 'mortality'
    });
    expect(claim.status).toBe('submitted');
    expect(claim.trigger).toBe('manual');

    const assessed = await service.assessClaim(insurer, claim.id, { amountKobo: 90_000_00 });
    expect(assessed.status).toBe('assessed');
    expect(assessed.amountKobo).toBe(90_000_00);

    const paid = await service.settleClaim(insurer, claim.id, 'paid');
    expect(paid.status).toBe('paid');
  });

  it('rejects claims above coverage and claims on unbound policies', async () => {
    const quoted = await service.quote(farmer, quoteInput);
    await expect(
      service.submitClaim(farmer, { policyId: quoted.id, animalIds: [animal.id] })
    ).rejects.toThrow('bound policy');
    const bound = await service.bind(insurer, quoted.id);
    await expect(
      service.submitClaim(farmer, {
        policyId: bound.id,
        animalIds: [animal.id],
        amountKobo: 999_999_00
      })
    ).rejects.toThrow('exceeds the policy coverage');
  });

  it('restricts claim submission to the holder and settlement to insurer/admin', async () => {
    const policy = await boundPolicy();
    await expect(
      service.submitClaim(other, { policyId: policy.id, animalIds: [animal.id] })
    ).rejects.toThrow('policy holder');
    const claim = await service.submitClaim(farmer, {
      policyId: policy.id,
      animalIds: [animal.id]
    });
    await expect(service.assessClaim(farmer, claim.id, {})).rejects.toThrow('insurer of record');
    const rejected = await service
      .assessClaim(admin, claim.id, {})
      .then(() => service.settleClaim(admin, claim.id, 'rejected'));
    expect(rejected.status).toBe('rejected');
  });

  describe('recall-triggered auto-claims (livestock.recall.initiated)', () => {
    it('drafts a recall claim for a bound animal policy', async () => {
      const policy = await boundPolicy();
      const drafted = await service.handleRecallInitiated({
        recallId: 'recall-1',
        animalIds: [animal.id]
      });
      expect(drafted).toHaveLength(1);
      expect(drafted[0]).toMatchObject({
        policyId: policy.id,
        trigger: 'recall',
        recallId: 'recall-1',
        status: 'draft',
        claimantUserId: farmer.id
      });
    });

    it('is idempotent per (policy, recall)', async () => {
      await boundPolicy();
      const first = await service.handleRecallInitiated({
        recallId: 'recall-1',
        animalIds: [animal.id]
      });
      const second = await service.handleRecallInitiated({
        recallId: 'recall-1',
        animalIds: [animal.id]
      });
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('matches lot policies through lot membership (guarded)', async () => {
      await lots.addAnimal(lot.id, 'NG-AVI-KD-000777');
      const lotQuote = await service.quote(farmer, {
        subjectType: 'lot',
        subjectId: lot.id,
        premiumKobo: 50_000_00,
        coverageKobo: 1_000_000_00
      });
      await service.bind(insurer, lotQuote.id);
      const drafted = await service.handleRecallInitiated({
        recallId: 'recall-2',
        animalIds: ['NG-AVI-KD-000777', 'NG-AVI-KD-000999']
      });
      expect(drafted).toHaveLength(1);
      expect(drafted[0].animalIds).toEqual(['NG-AVI-KD-000777']);
    });

    it('ignores unbound policies, unknown animals and malformed payloads', async () => {
      await service.quote(farmer, quoteInput); // still a quote
      const drafted = await service.handleRecallInitiated({
        recallId: 'recall-3',
        animalIds: [animal.id]
      });
      expect(drafted).toHaveLength(0);
      await expect(
        service.handleRecallInitiated({ recallId: 'x' } as never)
      ).resolves.toEqual([]);
    });

    it('handles the published domain event end-to-end', async () => {
      const policy = await boundPolicy();
      await events.publish(LIVESTOCK_RECALL_INITIATED_EVENT, {
        recallId: 'recall-9',
        animalIds: [animal.id]
      });
      // The subscriber is synchronous up to the async handler; flush microtasks.
      await new Promise((resolve) => setImmediate(resolve));
      const recallClaims = await claims.find({ policyId: policy.id, recallId: 'recall-9' });
      expect(recallClaims).toHaveLength(1);
      expect(recallClaims[0].status).toBe('draft');
    });

    it('surfaces store failures from the lot overlap lookup (no silent "no overlap")', async () => {
      const lotQuote = await service.quote(farmer, {
        subjectType: 'lot',
        subjectId: lot.id,
        premiumKobo: 50_000_00,
        coverageKobo: 1_000_000_00
      });
      await service.bind(insurer, lotQuote.id);
      lots.listAnimalIds = vi.fn().mockRejectedValue(new Error('store connection lost'));
      await expect(
        service.handleRecallInitiated({ recallId: 'recall-err', animalIds: ['NG-AVI-KD-000777'] })
      ).rejects.toThrow('store connection lost');
    });

    it('still treats the documented not-found case as no overlap', async () => {
      const lotQuote = await service.quote(farmer, {
        subjectType: 'lot',
        subjectId: lot.id,
        premiumKobo: 50_000_00,
        coverageKobo: 1_000_000_00
      });
      await service.bind(insurer, lotQuote.id);
      lots.listAnimalIds = vi.fn().mockRejectedValue(new NotFoundException('lot gone'));
      await expect(
        service.handleRecallInitiated({ recallId: 'recall-nf', animalIds: ['NG-AVI-KD-000777'] })
      ).resolves.toEqual([]);
    });
  });
});
