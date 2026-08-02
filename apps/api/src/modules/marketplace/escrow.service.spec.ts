import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { PaymentProviderPort, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { EscrowService } from './escrow.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

// Seed order 'order-buyer-cassava': ₦370,000 total, escrowRequired, confirmed.
function makeService(provider?: PaymentProviderPort) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new EscrowService(
    events,
    createInMemoryOrderRepository(),
    createInMemoryEscrowRepository(),
    provider
  );
  return { service, events };
}

describe('EscrowService', () => {
  it('holds the order total in integer kobo without a provider', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(record.status).toBe('held');
    expect(record.amountKobo).toBe(37_000_000);
    expect(Number.isInteger(record.amountKobo)).toBe(true);
    expect(record.providerReference).toBeUndefined();
  });

  it('is idempotent per order (retries never double-hold)', async () => {
    const { service } = makeService();
    const first = await service.holdForOrder('order-buyer-cassava', buyer.id);
    const second = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(second.id).toBe(first.id);
  });

  it('records the provider reference through the payment provider port', async () => {
    const calls: string[] = [];
    const provider: PaymentProviderPort = {
      name: 'stub-pay',
      hold: async (command) => {
        calls.push(`hold:${command.amountKobo}`);
        return { providerReference: 'ps_hold_123' };
      },
      release: async (reference) => {
        calls.push(`release:${reference}`);
      },
      refund: async (reference) => {
        calls.push(`refund:${reference}`);
      }
    };
    const { service } = makeService(provider);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(record.providerReference).toBe('ps_hold_123');
    expect(calls).toEqual(['hold:37000000']);

    await service.transition(record.id, 'released', buyer);
    expect(calls).toEqual(['hold:37000000', 'release:ps_hold_123']);
  });

  it('walks the buyer-release path with actor scoping', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect((await service.transition(record.id, 'released', buyer)).status).toBe('released');
    expect((await service.escrowForOrder('order-buyer-cassava'))?.resolvedAt).toBeDefined();
  });

  it('rejects illegal transitions and terminal-state moves', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(service.transition(record.id, 'held', admin)).resolves.toBeDefined(); // replay no-op
    await service.transition(record.id, 'refunded', seller);
    await expect(service.transition(record.id, 'released', admin)).rejects.toThrowError(
      /Invalid escrow transition/
    );
    await expect(service.transition(record.id, 'disputed', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('enforces the entitled party per transition', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    // Only the buyer releases; only the seller refunds.
    await expect(service.transition(record.id, 'released', seller)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(service.transition(record.id, 'refunded', buyer)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(service.transition(record.id, 'disputed', outsider)).rejects.toThrowError(
      ForbiddenException
    );
  });

  it('supports the dispute path with admin-only resolution', async () => {
    const { service, events } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect((await service.transition(record.id, 'disputed', seller)).status).toBe('disputed');
    // Parties cannot resolve their own dispute.
    await expect(service.transition(record.id, 'refunded', buyer)).rejects.toThrowError(
      ForbiddenException
    );
    // Held money cannot be re-disputed from a terminal resolution.
    expect((await service.transition(record.id, 'refunded', admin)).status).toBe('refunded');
    await expect(service.transition(record.id, 'disputed', admin)).rejects.toThrowError(
      /Invalid escrow transition/
    );
    expect(
      (await events.listOutbox()).filter((e) => e.name === 'marketplace.escrow.status_changed')
    ).toHaveLength(2);
  });

  it('system release/refund paths act only on held escrows', async () => {
    const { service } = makeService();
    expect(await service.releaseForOrder('order-buyer-cassava', admin.id)).toBeUndefined();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await service.transition(record.id, 'disputed', buyer);
    // Disputed escrows wait for admin resolution, not system release.
    expect((await service.releaseForOrder('order-buyer-cassava', admin.id))?.status).toBe('disputed');
    expect((await service.refundForOrder('order-buyer-cassava', admin.id))?.status).toBe('disputed');
  });

  it('refuses to hold escrow for cancelled orders', async () => {
    const { service } = makeService();
    const orders = createInMemoryOrderRepository();
    await orders.update('order-buyer-cassava', { status: 'cancelled' });
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const cancelled = new EscrowService(events, orders, createInMemoryEscrowRepository());
    await expect(cancelled.holdForOrder('order-buyer-cassava', buyer.id)).rejects.toThrowError(
      BadRequestException
    );
  });
});
