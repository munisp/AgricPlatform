import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, InsurancePolicy, User } from '@agric-platform/shared';
import { LIVESTOCK_ANIMAL_STATUS_CHANGED_EVENT } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import {
  createInMemoryInsuranceClaimRepository,
  createInMemoryInsurancePolicyRepository,
  createInMemoryLienRepository,
  createLienTransferGuard
} from '../../database/repositories/livestock-trade.repository.js';
import { InsuranceService } from './insurance.service.js';
import { LiensService } from './liens.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const farmer = asUser('farmer-1', ['farmer']);
const lender = asUser('lender-1', ['lender']);
const insurer = asUser('insurer-1', ['insurer']);

const animal: Animal = {
  id: 'NG-BOV-KD-000042',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: farmer.id,
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

/**
 * V-11 integration: one `livestock.animal.status_changed` (→ dead|stolen)
 * event drives BOTH reactions off the same outbox append — the lien service
 * margin-calls the lien holder and the insurance service auto-drafts a
 * mortality claim on the bound policy covering the animal.
 */
describe('animal death/theft reactions (V-11)', () => {
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let events: DomainEventsService;
  let liens: ReturnType<typeof createInMemoryLienRepository>;
  let policies: ReturnType<typeof createInMemoryInsurancePolicyRepository>;
  let claims: ReturnType<typeof createInMemoryInsuranceClaimRepository>;
  let lienService: LiensService;
  let insuranceService: InsuranceService;

  beforeEach(() => {
    outbox = createInMemoryOutboxRepository();
    events = new DomainEventsService(outbox);
    const animals = createInMemoryAnimalRepository(createInMemoryOwnershipTransferRepository(), [
      animal
    ]);
    const lots = createInMemoryLotRepository();
    liens = createInMemoryLienRepository();
    policies = createInMemoryInsurancePolicyRepository();
    claims = createInMemoryInsuranceClaimRepository();
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    lienService = new LiensService(audit as never, events, animals, lots, liens);
    insuranceService = new InsuranceService(
      audit as never,
      events,
      animals,
      lots,
      policies,
      claims,
      { provider: 'fake-underwriter', bindPolicy: vi.fn().mockResolvedValue({ providerRef: 'uw-1' }) }
    );
    lienService.onModuleInit();
    insuranceService.onModuleInit();
  });

  async function loanedAndInsured(): Promise<{ lienId: string; policy: InsurancePolicy }> {
    const lien = await lienService.register(lender, {
      subjectType: 'animal',
      subjectId: animal.id,
      principalKobo: 500_000_00,
      terms: '12 months, collateral: animal'
    });
    const quoted = await insuranceService.quote(farmer, {
      subjectType: 'animal',
      subjectId: animal.id,
      premiumKobo: 20_000,
      coverageKobo: 400_000
    });
    const policy = await insuranceService.bind(insurer, quoted.id);
    return { lienId: lien.id, policy };
  }

  async function publishStatus(to: 'dead' | 'stolen' | 'sold') {
    await events.publish(
      LIVESTOCK_ANIMAL_STATUS_CHANGED_EVENT,
      { animalId: animal.id, from: 'alive', to },
      farmer.id
    );
    // Listeners fan out fire-and-forget — wait until both reactions land.
    await vi.waitFor(async () => {
      const names = (await outbox.list()).map((entry) => entry.name);
      expect(names).toContain('livestock_trade.lien.margin_called');
      expect(names).toContain('livestock_trade.claim.auto_drafted');
    });
  }

  it('animal → dead margin-calls the lien AND drafts the mortality claim off the one event', async () => {
    const { lienId, policy } = await loanedAndInsured();
    await publishStatus('dead');

    const lien = await liens.getById(lienId);
    expect(lien.status).toBe('margin_call');

    const drafted = await claims.find({ policyId: policy.id });
    expect(drafted).toHaveLength(1);
    expect(drafted[0].trigger).toBe('mortality');
    expect(drafted[0].status).toBe('draft');
    expect(drafted[0].animalIds).toEqual([animal.id]);

    // The margin-call event notifies the lien holder (margin call payload).
    const marginEvent = (await outbox.list()).find(
      (entry) => entry.name === 'livestock_trade.lien.margin_called'
    );
    expect(marginEvent?.payload).toMatchObject({
      lienId,
      lenderUserId: lender.id,
      cause: 'dead',
      animalId: animal.id
    });
  });

  it('a margin-called lien still blocks transfer/sale (stays enforced)', async () => {
    await loanedAndInsured();
    await publishStatus('stolen');
    const guard = createLienTransferGuard(liens);
    await expect(guard.assertTransferable(animal.id)).rejects.toThrow('active lien');
  });

  it('is idempotent: duplicate delivery never re-flags or double-drafts', async () => {
    const { lienId, policy } = await loanedAndInsured();
    await publishStatus('dead');
    // Re-drive the same transition (outbox sweeper replay).
    await lienService.handleAnimalStatusChanged({ animalId: animal.id, from: 'alive', to: 'dead' });
    await insuranceService.handleAnimalStatusChanged({
      animalId: animal.id,
      from: 'alive',
      to: 'dead'
    });
    expect((await liens.getById(lienId)).status).toBe('margin_call');
    expect((await claims.find({ policyId: policy.id })).length).toBe(1);
  });

  it('ignores non-loss transitions and animals without cover', async () => {
    const { lienId, policy } = await loanedAndInsured();
    await lienService.handleAnimalStatusChanged({ animalId: animal.id, from: 'alive', to: 'sold' });
    await insuranceService.handleAnimalStatusChanged({
      animalId: animal.id,
      from: 'alive',
      to: 'sold'
    });
    expect((await liens.getById(lienId)).status).toBe('active');
    expect((await claims.find({ policyId: policy.id })).length).toBe(0);
    // Unknown animal: no lien, no claim, no throw.
    await expect(
      lienService.handleAnimalStatusChanged({ animalId: 'NG-BOV-XX-999999', from: 'alive', to: 'dead' })
    ).resolves.toBeUndefined();
    await expect(
      insuranceService.handleAnimalStatusChanged({ animalId: 'NG-BOV-XX-999999', from: 'alive', to: 'dead' })
    ).resolves.toEqual([]);
  });

  it('drafts no mortality claim when the policy is not bound', async () => {
    await lienService.register(lender, {
      subjectType: 'animal',
      subjectId: animal.id,
      principalKobo: 500_000_00,
      terms: '12 months'
    });
    await insuranceService.quote(farmer, {
      subjectType: 'animal',
      subjectId: animal.id,
      premiumKobo: 20_000,
      coverageKobo: 400_000
    }); // quote only — never bound
    await insuranceService.handleAnimalStatusChanged({
      animalId: animal.id,
      from: 'alive',
      to: 'dead'
    });
    expect((await claims.all()).length).toBe(0);
  });
});
