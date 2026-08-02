import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createInMemoryBuyerGroupRepository,
  createInMemoryListingVariantRepository,
  createInMemoryPriceListEntryRepository,
  createInMemoryPriceListRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { BuyerGroupsService } from './buyer-groups.service.js';
import { PricingService } from './pricing.service.js';

const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };

const VARIANT = {
  id: 'variant-1',
  listingId: 'listing-maize-kano',
  sku: 'MAIZE-50KG-A',
  name: 'Grade A — 50kg',
  attributes: { grade: 'A' },
  priceKobo: 2_000_000,
  quantity: 10,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

async function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const buyerGroups = new BuyerGroupsService(
    events,
    createInMemoryBuyerGroupRepository(),
    createInMemoryBuyerGroupMembershipRepository()
  );
  const service = new PricingService(
    events,
    createInMemoryPriceListRepository(),
    createInMemoryPriceListEntryRepository(),
    createInMemoryListingVariantRepository([VARIANT]),
    buyerGroups
  );
  return { service, buyerGroups };
}

describe('PricingService price lists', () => {
  it('creates price lists as admin/agent only', async () => {
    const { service } = await makeService();
    await expect(service.createPriceList({ name: 'Wholesale' }, buyer)).rejects.toThrowError(ForbiddenException);
    const list = await service.createPriceList({ name: 'Wholesale', priority: 5 }, admin);
    expect(list.priority).toBe(5);
    expect(await service.listPriceLists()).toHaveLength(1);
  });

  it('validates the validity window', async () => {
    const { service } = await makeService();
    await expect(
      service.createPriceList({ name: 'Bad', startsAt: '2026-02-01', endsAt: '2026-01-01' }, admin)
    ).rejects.toThrowError(BadRequestException);
  });

  it('upserts variant entries (one price per list+variant)', async () => {
    const { service } = await makeService();
    const list = await service.createPriceList({ name: 'Wholesale' }, admin);
    await service.setEntry(list.id, 'variant-1', 1_800_000, admin);
    const updated = await service.setEntry(list.id, 'variant-1', 1_700_000, admin);
    expect(updated.priceKobo).toBe(1_700_000);
    expect(await service.listEntries(list.id)).toHaveLength(1);
    await expect(service.setEntry(list.id, 'variant-1', -1, admin)).rejects.toThrowError(BadRequestException);
    await expect(service.setEntry(list.id, 'variant-missing', 100, admin)).rejects.toThrowError(NotFoundException);
  });
});

describe('PricingService price resolution', () => {
  it('falls back to the variant list price without applicable lists', async () => {
    const { service } = await makeService();
    const resolved = await service.resolvePrice('variant-1', 'user-buyer');
    expect(resolved.priceKobo).toBe(2_000_000);
    expect(resolved.priceListId).toBeUndefined();
  });

  it('applies a group-less price list to any buyer', async () => {
    const { service } = await makeService();
    const list = await service.createPriceList({ name: 'Promo week' }, admin);
    await service.setEntry(list.id, 'variant-1', 1_500_000, admin);
    expect((await service.resolvePrice('variant-1', 'user-buyer')).priceKobo).toBe(1_500_000);
  });

  it('scopes buyer-group lists to members only', async () => {
    const { service, buyerGroups } = await makeService();
    const group = await buyerGroups.createGroup({ name: 'Coops' }, admin);
    const list = await service.createPriceList({ name: 'Coop price', buyerGroupId: group.id }, admin);
    await service.setEntry(list.id, 'variant-1', 1_600_000, admin);
    expect((await service.resolvePrice('variant-1', 'user-buyer')).priceKobo).toBe(2_000_000);
    await buyerGroups.addMember(group.id, 'user-buyer', admin);
    expect((await service.resolvePrice('variant-1', 'user-buyer')).priceKobo).toBe(1_600_000);
  });

  it('honours the validity window', async () => {
    const { service } = await makeService();
    const list = await service.createPriceList(
      { name: 'Feb only', startsAt: '2026-02-01T00:00:00.000Z', endsAt: '2026-02-28T00:00:00.000Z' },
      admin
    );
    await service.setEntry(list.id, 'variant-1', 1_500_000, admin);
    expect((await service.resolvePrice('variant-1', 'user-buyer', '2026-02-10T00:00:00.000Z')).priceKobo).toBe(
      1_500_000
    );
    expect((await service.resolvePrice('variant-1', 'user-buyer', '2026-03-10T00:00:00.000Z')).priceKobo).toBe(
      2_000_000
    );
  });

  it('picks the lowest applicable price, breaking ties on priority', async () => {
    const { service } = await makeService();
    const a = await service.createPriceList({ name: 'A', priority: 1 }, admin);
    const b = await service.createPriceList({ name: 'B', priority: 9 }, admin);
    const c = await service.createPriceList({ name: 'C', priority: 5 }, admin);
    await service.setEntry(a.id, 'variant-1', 1_800_000, admin);
    await service.setEntry(b.id, 'variant-1', 1_800_000, admin);
    await service.setEntry(c.id, 'variant-1', 1_900_000, admin);
    const resolved = await service.resolvePrice('variant-1', 'user-buyer');
    expect(resolved.priceKobo).toBe(1_800_000);
    expect(resolved.priceListId).toBe(b.id);
    // Inactive lists never apply.
    await service.updatePriceList(b.id, { isActive: false }, admin);
    expect((await service.resolvePrice('variant-1', 'user-buyer')).priceListId).toBe(a.id);
  });

  it('never resolves above the variant list price requirement — list price is the fallback', async () => {
    const { service } = await makeService();
    const list = await service.createPriceList({ name: 'Premium' }, admin);
    await service.setEntry(list.id, 'variant-1', 2_500_000, admin);
    const resolved = await service.resolvePrice('variant-1');
    expect(resolved.priceKobo).toBe(2_500_000);
    expect(resolved.listPriceKobo).toBe(2_000_000);
  });
});
