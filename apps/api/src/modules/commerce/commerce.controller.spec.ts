import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Order, User } from '@agric-platform/shared';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { PromotionsService } from './promotions.service.js';
import { CommerceController } from './commerce.controller.js';

/**
 * G11: GET /orders/:id/promotions was readable by any authenticated user.
 * The controller must resolve the order and enforce buyer/seller/admin.
 * Only the collaborators on that path are real stubs; the rest are unused.
 */
const order = {
  id: 'order-1',
  buyerId: 'user-buyer',
  sellerId: 'user-seller'
} as Order;

function makeController() {
  const marketplace = {
    getOrder: async (id: string) => (id === order.id ? order : Promise.reject(new Error('nf')))
  } as unknown as MarketplaceService;
  const promotions = {
    redemptionsForOrder: async () => [{ id: 'redemption-1', orderId: order.id }]
  } as unknown as PromotionsService;
  const stub = {} as never;
  const controller = new CommerceController(
    stub,
    stub,
    stub,
    stub,
    promotions,
    stub,
    stub,
    stub,
    stub,
    stub,
    marketplace
  );
  return { controller };
}

const buyer = { id: 'user-buyer', roles: ['buyer'] } as User;
const seller = { id: 'user-seller', roles: ['farmer'] } as User;
const admin = { id: 'user-admin', roles: ['admin'] } as User;
const outsider = { id: 'user-outsider', roles: ['buyer'] } as User;

describe('CommerceController.orderPromotions party check (G11)', () => {
  it('allows the order buyer, seller and an admin', async () => {
    const { controller } = makeController();
    for (const actor of [buyer, seller, admin]) {
      const result = await controller.orderPromotions(order.id, actor);
      expect(result.data).toHaveLength(1);
    }
  });

  it('rejects an authenticated user who is not a party to the order', async () => {
    const { controller } = makeController();
    await expect(controller.orderPromotions(order.id, outsider)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('rejects anonymous callers', async () => {
    const { controller } = makeController();
    await expect(controller.orderPromotions(order.id, null)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});
