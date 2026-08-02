import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animal, LivestockLot, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAnimalRepository,
  createInMemoryLotRepository,
  createInMemoryOwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import { createInMemoryCertifiedListingRepository } from '../../database/repositories/livestock-trade.repository.js';
import { CertifiedListingsService } from './certified-listings.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const owner = asUser('farmer-1', ['farmer']);
const other = asUser('farmer-2', ['farmer']);
const admin = asUser('admin-1', ['admin']);

const animal: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: owner.id,
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const lot: LivestockLot = {
  id: 'LOT-AVI-KD-000001',
  species: 'chicken',
  quantity: 500,
  ownerUserId: owner.id,
  state: 'Kaduna',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

describe('CertifiedListingsService', () => {
  let animals: ReturnType<typeof createInMemoryAnimalRepository>;
  let lots: ReturnType<typeof createInMemoryLotRepository>;
  let transfers: ReturnType<typeof createInMemoryOwnershipTransferRepository>;
  let listings: ReturnType<typeof createInMemoryCertifiedListingRepository>;
  let privacy: { consentsFor: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let service: CertifiedListingsService;

  beforeEach(() => {
    transfers = createInMemoryOwnershipTransferRepository();
    animals = createInMemoryAnimalRepository(transfers, [animal]);
    lots = createInMemoryLotRepository([lot]);
    listings = createInMemoryCertifiedListingRepository();
    privacy = {
      consentsFor: vi.fn().mockResolvedValue([
        { id: 'consent-1', purpose: 'livestock_records', granted: true }
      ])
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    outbox = createInMemoryOutboxRepository();
    service = new CertifiedListingsService(
      privacy as never,
      audit as never,
      new DomainEventsService(outbox),
      animals,
      lots,
      transfers,
      listings
    );
  });

  it('creates a draft listing with a provenance snapshot', async () => {
    const listing = await service.create(owner, {
      subjectType: 'animal',
      subjectId: animal.id,
      askingPriceKobo: 250_000_00
    });
    expect(listing.status).toBe('draft');
    expect(listing.sellerUserId).toBe(owner.id);
    expect(listing.provenance).toMatchObject({
      subjectId: animal.id,
      species: 'cattle',
      breed: 'White Fulani',
      ownershipDepth: 0,
      consentGranted: true
    });
  });

  it('records ownership-transfer depth in the provenance payload', async () => {
    await transfers.create({
      id: 'transfer-1',
      animalId: animal.id,
      fromUserId: 'farmer-0',
      toUserId: owner.id,
      transferType: 'sale',
      effectiveAt: '2026-01-02T00:00:00.000Z',
      recordedBy: 'farmer-0',
      createdAt: '2026-01-02T00:00:00.000Z'
    });
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    expect(listing.provenance.ownershipDepth).toBe(1);
  });

  it('supports lots as listing subjects', async () => {
    const listing = await service.create(owner, { subjectType: 'lot', subjectId: lot.id });
    expect(listing.quantity).toBe(500);
    expect(listing.provenance.ownershipDepth).toBe(0);
  });

  it('rejects certification by a non-owner', async () => {
    await expect(
      service.create(other, { subjectType: 'animal', subjectId: animal.id })
    ).rejects.toThrow('Only the owner can certify');
  });

  it('rejects certification without an active livestock_records consent', async () => {
    privacy.consentsFor.mockResolvedValue([
      { id: 'c', purpose: 'livestock_records', granted: true, revokedAt: '2026-01-01T00:00:00.000Z' }
    ]);
    await expect(
      service.create(owner, { subjectType: 'animal', subjectId: animal.id })
    ).rejects.toThrow('consent');
  });

  it('rejects a second open listing for the same subject', async () => {
    await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    await expect(
      service.create(owner, { subjectType: 'animal', subjectId: animal.id })
    ).rejects.toThrow('already has a draft certified listing');
  });

  it('rejects non-integer kobo asking prices', async () => {
    await expect(
      service.create(owner, { subjectType: 'animal', subjectId: animal.id, askingPriceKobo: 10.5 })
    ).rejects.toThrow('kobo');
  });

  it('walks the lifecycle draft → active → sold and audits every transition', async () => {
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    const active = await service.activate(owner, listing.id);
    expect(active.status).toBe('active');
    const sold = await service.markSold(owner, listing.id);
    expect(sold.status).toBe('sold');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'livestock_trade.listing_activated' })
    );
    const events = await outbox.list();
    expect(events.map((event) => event.name)).toContain('livestock_trade.listing.transitioned');
  });

  it('allows withdrawing a draft and blocks further transitions', async () => {
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    const withdrawn = await service.withdraw(owner, listing.id);
    expect(withdrawn.status).toBe('withdrawn');
    await expect(service.activate(owner, listing.id)).rejects.toThrow('Invalid listing transition');
  });

  it('blocks lifecycle transitions by non-owners', async () => {
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    await expect(service.activate(other, listing.id)).rejects.toThrow(
      'You may only access your own records'
    );
  });

  it('lets an admin revoke a certification with a reason', async () => {
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    const revoked = await service.revoke(admin, listing.id, 'provenance fraud');
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedByUserId).toBe(admin.id);
    expect(revoked.revocationReason).toBe('provenance fraud');
  });

  it('denies revocation by non-admins and requires a reason', async () => {
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    await expect(service.revoke(owner, listing.id, 'x')).rejects.toThrow('administrator');
    await expect(service.revoke(admin, listing.id, ' ')).rejects.toThrow('reason');
  });

  it('keeps non-active listings private to owner/admin', async () => {
    const listing = await service.create(owner, { subjectType: 'animal', subjectId: animal.id });
    await expect(service.getById(other, listing.id)).rejects.toThrow(
      'You may only access your own records'
    );
    await service.activate(owner, listing.id);
    const visible = await service.getById(other, listing.id);
    expect(visible.status).toBe('active');
  });
});
