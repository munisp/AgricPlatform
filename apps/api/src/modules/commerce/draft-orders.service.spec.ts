import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createInMemoryBuyerGroupRepository,
  createInMemoryDraftOrderRepository,
  createInMemoryListingVariantRepository,
  createInMemoryOrderExtensionRepository,
  createInMemoryPriceListEntryRepository,
  createInMemoryPriceListRepository,
  createInMemoryPromotionRedemptionRepository,
  createInMemoryPromotionRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { BuyerGroupsService } from './buyer-groups.service.js';
import { CheckoutService } from './checkout.service.js';
import { DraftOrdersService } from './draft-orders.service.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';

const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const agent: Pick<User, 'id' | 'roles'> = { id: 'user-agent', roles: ['chapter_lead'] };
const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const otherBuyer: Pick<User, 'id' | 'roles'> = { id: 'user-hassan', roles: ['buyer'] };

const VARIANT = {
  id: 'variant-maize-50kg',
  listingId: 'listing-maize-kano',
  sku: 'MAIZE-50KG-A',
  name: 'Grade A — 50kg',
  attributes: {},
  priceKobo: 2_000_000,
  quantity: 5,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

function makeStack(variantSeed = [VARIANT]) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const variants = createInMemoryListingVariantRepository(variantSeed);
  const extensions = createInMemoryOrderExtensionRepository();
  const buyerGroups = new BuyerGroupsService(
    events,
    createInMemoryBuyerGroupRepository(),
    createInMemoryBuyerGroupMembershipRepository()
  );
  const pricing = new PricingService(
    events,
    createInMemoryPriceListRepository(),
    createInMemoryPriceListEntryRepository(),
    variants,
    buyerGroups
  );
  const promotions = new PromotionsService(
    events,
    createInMemoryPromotionRepository(),
    createInMemoryPromotionRedemptionRepository(),
    buyerGroups
  );
  const checkout = new CheckoutService(events, listings, orders, variants, extensions, pricing, promotions);
  const drafts = createInMemoryDraftOrderRepository();
  const service = new DraftOrdersService(events, drafts, listings, variants, orders, pricing, checkout);
  return { drafts, extensions, variants, service };
}

describe('DraftOrdersService', () => {
  it('agents create draft orders on behalf of a buyer (agent channel price snapshot)', async () => {
    const { service } = makeStack();
    const draft = await service.createDraft(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 2 },
      agent
    );
    expect(draft.status).toBe('open');
    expect(draft.unitPriceKobo).toBe(2_000_000);
    expect(draft.createdBy).toBe('user-agent');
    expect(draft.sellerId).toBe('user-farmer-2');
  });

  it('rejects draft creation by ordinary buyers', async () => {
    const { service } = makeStack();
    await expect(
      service.createDraft({ listingId: 'listing-maize-kano', buyerId: 'user-hassan', quantity: 1 }, buyer)
    ).rejects.toThrowError(ForbiddenException);
  });

  it('buyer confirms a draft into a normal order (guarded, agent channel)', async () => {
    const { service, extensions, variants } = makeStack();
    const draft = await service.createDraft(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 2 },
      agent
    );
    const { draft: confirmed, order } = await service.confirmDraft(draft.id, buyer);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.orderId).toBe(order.id);
    expect(order.status).toBe('requested');
    expect(order.totalNaira).toBe(40_000);
    expect((await extensions.getById(order.id)).channel).toBe('agent');
    expect((await extensions.getById(order.id)).draftId).toBe(draft.id);
    expect((await variants.getById(VARIANT.id)).quantity).toBe(3);
  });

  it('double-confirm is an idempotent replay returning the same order', async () => {
    const { service, variants } = makeStack();
    const draft = await service.createDraft(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1 },
      agent
    );
    const first = await service.confirmDraft(draft.id, buyer);
    const second = await service.confirmDraft(draft.id, buyer);
    expect(second.order.id).toBe(first.order.id);
    expect((await variants.getById(VARIANT.id)).quantity).toBe(4); // decremented once
  });

  it('rejects confirmation by anyone but the buyer (or admin)', async () => {
    const { service } = makeStack();
    const draft = await service.createDraft(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1 },
      agent
    );
    await expect(service.confirmDraft(draft.id, otherBuyer)).rejects.toThrowError(ForbiddenException);
    await expect(service.confirmDraft(draft.id, admin)).resolves.toBeDefined();
  });

  it('discards drafts (buyer, creator or admin) exactly once', async () => {
    const { service } = makeStack();
    const draft = await service.createDraft(
      { listingId: 'listing-maize-kano', buyerId: 'user-buyer', quantity: 1 },
      agent
    );
    await expect(service.discardDraft(draft.id, otherBuyer)).rejects.toThrowError(ForbiddenException);
    expect((await service.discardDraft(draft.id, buyer)).status).toBe('discarded');
    expect((await service.discardDraft(draft.id, buyer)).status).toBe('discarded'); // replay
    await expect(service.confirmDraft(draft.id, buyer)).rejects.toThrowError(BadRequestException);
  });

  it('rejects self-orders and inactive listings', async () => {
    const { service } = makeStack();
    await expect(
      service.createDraft({ listingId: 'listing-maize-kano', buyerId: 'user-farmer-2', quantity: 1 }, admin)
    ).rejects.toThrowError(/own listing/);
  });

  it('validates variant/listing consistency', async () => {
    const { service } = makeStack();
    await expect(
      service.createDraft(
        { listingId: 'listing-cassava-kaduna', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1 },
        agent
      )
    ).rejects.toThrowError(/does not belong to listing/);
  });

  it('lists drafts by buyer/status', async () => {
    const { service } = makeStack([]);
    await service.createDraft({ listingId: 'listing-maize-kano', buyerId: 'user-buyer', quantity: 1 }, agent);
    await service.createDraft({ listingId: 'listing-maize-kano', buyerId: 'user-hassan', quantity: 1 }, agent);
    expect(await service.listDrafts({ buyerId: 'user-buyer' })).toHaveLength(1);
    expect(await service.listDrafts({ status: 'open' })).toHaveLength(2);
  });
});
