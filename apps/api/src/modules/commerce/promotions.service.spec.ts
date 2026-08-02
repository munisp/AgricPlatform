import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createInMemoryBuyerGroupRepository,
  createInMemoryPromotionRedemptionRepository,
  createInMemoryPromotionRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { BuyerGroupsService } from './buyer-groups.service.js';
import { PromotionsService } from './promotions.service.js';

const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const buyerGroups = new BuyerGroupsService(
    events,
    createInMemoryBuyerGroupRepository(),
    createInMemoryBuyerGroupMembershipRepository()
  );
  const service = new PromotionsService(
    events,
    createInMemoryPromotionRepository(),
    createInMemoryPromotionRedemptionRepository(),
    buyerGroups
  );
  return { service, buyerGroups };
}

const CONTEXT = { subtotalKobo: 1_000_000, listingId: 'listing-maize-kano', buyerId: 'user-buyer' };

describe('PromotionsService CRUD', () => {
  it('creates coupon and automatic promotions as admin/agent only', async () => {
    const { service } = makeService();
    await expect(
      service.createPromotion({ name: 'X', kind: 'percentage', value: 500, code: 'SAVE5' }, buyer)
    ).rejects.toThrowError(ForbiddenException);
    const coupon = await service.createPromotion({ name: 'Save 5%', kind: 'percentage', value: 500, code: 'save5' }, admin);
    expect(coupon.code).toBe('SAVE5'); // normalized
    expect(coupon.automatic).toBe(false);
    const automatic = await service.createPromotion({ name: 'Auto', kind: 'fixed', value: 10_000 }, admin);
    expect(automatic.automatic).toBe(true);
    expect(automatic.code).toBeUndefined();
  });

  it('validates values and windows', async () => {
    const { service } = makeService();
    await expect(
      service.createPromotion({ name: 'X', kind: 'percentage', value: 10_001 }, admin)
    ).rejects.toThrowError(BadRequestException);
    await expect(service.createPromotion({ name: 'X', kind: 'fixed', value: 0 }, admin)).rejects.toThrowError(
      BadRequestException
    );
    await expect(
      service.createPromotion({ name: 'X', kind: 'fixed', value: 1, startsAt: '2026-02-01', endsAt: '2026-01-01' }, admin)
    ).rejects.toThrowError(BadRequestException);
    await expect(service.createPromotion({ name: 'X', kind: 'fixed', value: 1, automatic: false }, admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('enforces coupon code uniqueness (case-insensitive)', async () => {
    const { service } = makeService();
    await service.createPromotion({ name: 'A', kind: 'fixed', value: 100, code: 'SAVE5' }, admin);
    await expect(
      service.createPromotion({ name: 'B', kind: 'fixed', value: 100, code: 'save5' }, admin)
    ).rejects.toThrowError(ConflictException);
  });

  it('updates promotions and toggles active state', async () => {
    const { service } = makeService();
    const promo = await service.createPromotion({ name: 'A', kind: 'fixed', value: 100, code: 'SAVE5' }, admin);
    expect((await service.updatePromotion(promo.id, { isActive: false }, admin)).isActive).toBe(false);
    await expect(service.updatePromotion(promo.id, { value: -1 }, admin)).rejects.toThrowError(BadRequestException);
  });
});

describe('PromotionsService evaluation', () => {
  it('applies automatic percentage promotions (basis points, floored)', async () => {
    const { service } = makeService();
    await service.createPromotion({ name: 'Auto 10%', kind: 'percentage', value: 1000 }, admin);
    const evaluation = await service.evaluate(CONTEXT);
    expect(evaluation.discountKobo).toBe(100_000);
    expect(evaluation.totalKobo).toBe(900_000);
    expect(evaluation.applied).toHaveLength(1);
  });

  it('applies coupon codes and reports rejected codes with reasons', async () => {
    const { service } = makeService();
    await service.createPromotion(
      { name: 'Big orders', kind: 'fixed', value: 50_000, code: 'BIG', minOrderKobo: 2_000_000 },
      admin
    );
    const rejected = await service.evaluate({ ...CONTEXT, code: 'big' });
    expect(rejected.discountKobo).toBe(0);
    expect(rejected.rejectedCode?.code).toBe('BIG');
    expect(rejected.rejectedCode?.reason).toMatch(/minimum value/);
    const ok = await service.evaluate({ ...CONTEXT, subtotalKobo: 2_500_000, code: 'BIG' });
    expect(ok.discountKobo).toBe(50_000);
    expect((await service.evaluate({ ...CONTEXT, code: 'NOPE' })).rejectedCode?.reason).toBe('Unknown promotion code');
  });

  it('honours validity windows and active state', async () => {
    const { service } = makeService();
    const promo = await service.createPromotion(
      { name: 'Feb', kind: 'fixed', value: 10_000, code: 'FEB', startsAt: '2026-02-01', endsAt: '2026-02-28' },
      admin
    );
    expect((await service.evaluate({ ...CONTEXT, code: 'FEB', at: '2026-01-15' })).rejectedCode?.reason).toBe(
      'Promotion has not started'
    );
    expect((await service.evaluate({ ...CONTEXT, code: 'FEB', at: '2026-03-15' })).rejectedCode?.reason).toBe(
      'Promotion has expired'
    );
    expect((await service.evaluate({ ...CONTEXT, code: 'FEB', at: '2026-02-15' })).discountKobo).toBe(10_000);
    await service.updatePromotion(promo.id, { isActive: false }, admin);
    expect((await service.evaluate({ ...CONTEXT, code: 'FEB', at: '2026-02-15' })).rejectedCode?.reason).toBe(
      'Promotion is not active'
    );
  });

  it('scopes promotions to listings and buyer groups', async () => {
    const { service, buyerGroups } = makeService();
    await service.createPromotion(
      { name: 'Maize only', kind: 'fixed', value: 5_000, code: 'MAIZE', listingId: 'listing-cassava-kaduna' },
      admin
    );
    expect((await service.evaluate({ ...CONTEXT, code: 'MAIZE' })).rejectedCode?.reason).toMatch(/this listing/);
    const group = await buyerGroups.createGroup({ name: 'Coops' }, admin);
    await service.createPromotion(
      { name: 'Coop deal', kind: 'percentage', value: 2000, code: 'COOP', buyerGroupId: group.id },
      admin
    );
    expect((await service.evaluate({ ...CONTEXT, code: 'COOP' })).rejectedCode?.reason).toMatch(/buyer group/);
    await buyerGroups.addMember(group.id, 'user-buyer', admin);
    expect((await service.evaluate({ ...CONTEXT, code: 'COOP' })).discountKobo).toBe(200_000);
  });

  it('enforces usage limits in evaluation and guarded increment', async () => {
    const { service } = makeService();
    const promo = await service.createPromotion(
      { name: 'First 2', kind: 'fixed', value: 1_000, code: 'FIRST2', usageLimit: 2 },
      admin
    );
    await service.recordRedemptions('order-1', [
      { promotionId: promo.id, code: 'FIRST2', name: 'First 2', discountKobo: 1_000 }
    ]);
    await service.recordRedemptions('order-2', [
      { promotionId: promo.id, code: 'FIRST2', name: 'First 2', discountKobo: 1_000 }
    ]);
    expect((await service.getPromotion(promo.id)).usedCount).toBe(2);
    // Evaluation now rejects; guarded increment conflicts.
    expect((await service.evaluate({ ...CONTEXT, code: 'FIRST2' })).rejectedCode?.reason).toMatch(/usage limit/);
    await expect(
      service.recordRedemptions('order-3', [
        { promotionId: promo.id, code: 'FIRST2', name: 'First 2', discountKobo: 1_000 }
      ])
    ).rejects.toThrowError(ConflictException);
  });

  it('caps stacked discounts at the subtotal', async () => {
    const { service } = makeService();
    await service.createPromotion({ name: '90%', kind: 'percentage', value: 9000 }, admin);
    await service.createPromotion({ name: 'Fixed big', kind: 'fixed', value: 500_000 }, admin);
    const evaluation = await service.evaluate(CONTEXT);
    expect(evaluation.discountKobo).toBe(1_000_000);
    expect(evaluation.totalKobo).toBe(0);
    expect(evaluation.applied[1].discountKobo).toBe(100_000); // capped remainder
  });

  it('rejects duplicate redemption records for the same order (idempotency)', async () => {
    const { service } = makeService();
    const promo = await service.createPromotion({ name: 'A', kind: 'fixed', value: 100 }, admin);
    const applied = [{ promotionId: promo.id, name: 'A', discountKobo: 100 }];
    await service.recordRedemptions('order-1', applied);
    await expect(service.recordRedemptions('order-1', applied)).rejects.toThrowError(ConflictException);
  });
});
