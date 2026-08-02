import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository,
  createInMemoryPastoralistProfileRepository
} from '../../database/repositories/livestock.repository.js';
import {
  createInMemoryLienRepository,
  createLienTransferGuard
} from '../../database/repositories/livestock-trade.repository.js';
import { LivestockService } from '../livestock/livestock.service.js';
import { LiensService } from './liens.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const lender = asUser('lender-1', ['lender']);
const otherLender = asUser('lender-2', ['lender']);
const farmer = asUser('farmer-1', ['farmer']);
const buyer = asUser('buyer-1', ['buyer']);
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

describe('LiensService', () => {
  let animals: ReturnType<typeof createInMemoryAnimalRepository>;
  let transfers: ReturnType<typeof createInMemoryOwnershipTransferRepository>;
  let liens: ReturnType<typeof createInMemoryLienRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let service: LiensService;

  beforeEach(() => {
    transfers = createInMemoryOwnershipTransferRepository();
    animals = createInMemoryAnimalRepository(transfers, [animal]);
    liens = createInMemoryLienRepository();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    service = new LiensService(
      audit as never,
      new DomainEventsService(outbox),
      animals,
      createInMemoryLotRepository(),
      liens
    );
  });

  const registerInput = {
    subjectType: 'animal' as const,
    subjectId: animal.id,
    principalKobo: 500_000_00,
    terms: '12 months, 20% flat, collateral: animal'
  };

  it('lets a lender register an active lien with the owner as borrower', async () => {
    const lien = await service.register(lender, registerInput);
    expect(lien.status).toBe('active');
    expect(lien.borrowerUserId).toBe(farmer.id);
    expect(lien.lenderUserId).toBe(lender.id);
    expect(lien.registeredAt).toBeTruthy();
  });

  it('rejects registration by non-lenders', async () => {
    await expect(service.register(farmer, registerInput)).rejects.toThrow('Requires one of roles');
    await expect(service.register(admin, registerInput)).resolves.toMatchObject({
      status: 'active'
    });
  });

  it('validates principal kobo and terms', async () => {
    await expect(
      service.register(lender, { ...registerInput, principalKobo: 100.5 })
    ).rejects.toThrow('kobo');
    await expect(service.register(lender, { ...registerInput, terms: ' ' })).rejects.toThrow(
      'terms'
    );
  });

  it('allows at most one active lien per subject', async () => {
    await service.register(lender, registerInput);
    await expect(service.register(otherLender, registerInput)).rejects.toThrow('active lien');
  });

  it('discharges a lien (lender of record only), unblocking the subject', async () => {
    const lien = await service.register(lender, registerInput);
    await expect(service.discharge(otherLender, lien.id)).rejects.toThrow('registering lender');
    const discharged = await service.discharge(lender, lien.id);
    expect(discharged.status).toBe('discharged');
    expect(discharged.dischargedAt).toBeTruthy();
    // A new lien can be registered once the previous one is discharged.
    await expect(service.register(otherLender, registerInput)).resolves.toMatchObject({
      status: 'active'
    });
  });

  it('marks a lien defaulted and blocks discharge afterwards', async () => {
    const lien = await service.register(lender, registerInput);
    const defaulted = await service.markDefaulted(lender, lien.id);
    expect(defaulted.status).toBe('defaulted');
    await expect(service.discharge(lender, lien.id)).rejects.toThrow('only active liens');
  });

  it('scopes subject lien history to owner, lender or admin', async () => {
    await service.register(lender, registerInput);
    expect(await service.listForSubject(farmer, 'animal', animal.id)).toHaveLength(1);
    expect(await service.listForSubject(otherLender, 'animal', animal.id)).toHaveLength(1);
    await expect(
      service.listForSubject(buyer, 'animal', animal.id)
    ).rejects.toThrow('your own livestock');
  });

  describe('LivestockService.transferAnimal integration (via guard port)', () => {
    function buildLivestock(withGuard: boolean): LivestockService {
      const users = {
        getById: vi.fn().mockImplementation(async (id: string) => ({ id, roles: ['farmer'] })),
        setRoles: vi.fn()
      };
      const privacy = { grantConsent: vi.fn(), consentsFor: vi.fn().mockResolvedValue([]) };
      return new LivestockService(
        users as never,
        privacy as never,
        audit as never,
        new DomainEventsService(outbox),
        animals,
        createInMemoryLotRepository(),
        transfers,
        createInMemoryPastoralistProfileRepository(),
        withGuard ? createLienTransferGuard(liens) : undefined
      );
    }

    it('blocks ownership transfer while an active lien exists', async () => {
      await service.register(lender, registerInput);
      const livestock = buildLivestock(true);
      await expect(
        livestock.transferAnimal(farmer, animal.id, {
          toUserId: buyer.id,
          transferType: 'sale'
        })
      ).rejects.toThrow('active lien');
      const unchanged = await animals.getById(animal.id);
      expect(unchanged.ownerUserId).toBe(farmer.id);
    });

    it('allows transfer after discharge and when no guard is bound', async () => {
      const lien = await service.register(lender, registerInput);
      const guarded = buildLivestock(true);
      await service.discharge(lender, lien.id);
      const transfer = await guarded.transferAnimal(farmer, animal.id, {
        toUserId: buyer.id,
        transferType: 'sale'
      });
      expect(transfer.toUserId).toBe(buyer.id);

      const lien2 = await service.register(lender, {
        ...registerInput,
        subjectId: 'NG-BOV-KD-000002'
      }).catch(() => null);
      expect(lien2).toBeNull(); // unknown subject: registration 404s on its own
      const unguarded = buildLivestock(false);
      await animals.create({ ...animal, id: 'NG-BOV-KD-000003' });
      await service.register(lender, { ...registerInput, subjectId: 'NG-BOV-KD-000003' });
      const free = await unguarded.transferAnimal(farmer, 'NG-BOV-KD-000003', {
        toUserId: buyer.id,
        transferType: 'gift'
      });
      expect(free.transferType).toBe('gift');
    });
  });
});
