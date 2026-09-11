import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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
      verify: async (reference) => ({
        reference,
        status: 'success',
        amountKobo: 37_000_000,
        providerReference: reference
      }),
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
    makeService();
    const orders = createInMemoryOrderRepository();
    await orders.update('order-buyer-cassava', { status: 'cancelled' });
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const cancelled = new EscrowService(events, orders, createInMemoryEscrowRepository());
    await expect(cancelled.holdForOrder('order-buyer-cassava', buyer.id)).rejects.toThrowError(
      BadRequestException
    );
  });
});

/** Records provider calls; can be told to fail the next release/refund. */
function fakeProvider(failures: { release?: number; refund?: number } = {}) {
  const calls: string[] = [];
  let releaseFailures = failures.release ?? 0;
  let refundFailures = failures.refund ?? 0;
  const provider: PaymentProviderPort = {
    name: 'fake-pay',
    verify: async (reference) => ({
      reference,
      status: 'success',
      amountKobo: 37_000_000,
      providerReference: reference
    }),
    hold: async () => ({ providerReference: 'fake_hold_1' }),
    release: async (reference) => {
      calls.push(`release:${reference}`);
      if (releaseFailures-- > 0) throw new Error('provider unreachable');
    },
    refund: async (reference) => {
      calls.push(`refund:${reference}`);
      if (refundFailures-- > 0) throw new Error('provider unreachable');
    }
  };
  return { provider, calls };
}

describe('EscrowService funds-integrity hardening', () => {
  it('rejects client-driven pending states', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(service.transition(record.id, 'releasing', buyer)).rejects.toThrowError(
      /system-driven/
    );
    await expect(service.transition(record.id, 'refunding', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('persists the release intent BEFORE calling the provider and converges on retry', async () => {
    const { provider, calls } = fakeProvider({ release: 1 }); // first release call crashes
    const { service } = makeService(provider);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    // Provider crash: the record is left in the resumable 'releasing' state.
    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      BadGatewayException
    );
    const stuck = await service.escrowForOrder('order-buyer-cassava');
    expect(stuck?.status).toBe('releasing'); // intent survived the crash
    expect(stuck?.resolvedAt).toBeUndefined();

    // Retry converges: same provider reference, no double-hold/double-write.
    const released = await service.transition(record.id, 'released', buyer);
    expect(released.status).toBe('released');
    expect(released.resolvedAt).toBeDefined();
    expect(calls).toEqual(['release:fake_hold_1', 'release:fake_hold_1']); // idempotent reference

    // A further retry is a pure replay: no additional provider call.
    await service.transition(record.id, 'released', buyer);
    expect(calls).toHaveLength(2);
  });

  it('never double-releases: a concurrent release + refund race has exactly one winner', async () => {
    const { provider, calls } = fakeProvider();
    const { service } = makeService(provider);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    const [release, refund] = await Promise.allSettled([
      service.transition(record.id, 'released', buyer),
      service.transition(record.id, 'refunded', seller)
    ]);
    const outcomes = [release, refund];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    // The loser either never passed the guard (400) or lost the guarded
    // write race (409) — it must never silently overwrite.
    expect([BadRequestException, ConflictException]).toContainEqual(loser.reason.constructor);

    const final = await service.escrowForOrder('order-buyer-cassava');
    expect(['released', 'refunded']).toContain(final?.status); // exactly one terminal state
    // Exactly one provider-side money movement happened — never both.
    expect(calls).toHaveLength(1);
    expect(['release:fake_hold_1', 'refund:fake_hold_1']).toContain(calls[0]);
  });

  it('system release path resumes a stuck releasing record', async () => {
    const { provider } = fakeProvider({ release: 1 });
    const { service } = makeService(provider);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      BadGatewayException
    );
    const resumed = await service.releaseForOrder('order-buyer-cassava', admin.id);
    expect(resumed?.status).toBe('released');
  });

  it('expires held escrows deterministically through the guarded refund path', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(record.heldUntil).toBeDefined();

    // Not yet due: nothing expires.
    expect(await service.expireHeldEscrows(record.heldAt)).toHaveLength(0);
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');

    // At/past the deadline: exactly one auto-refund, then idempotent.
    const afterDeadline = new Date(Date.parse(record.heldUntil!) + 1000).toISOString();
    const expired = await service.expireHeldEscrows(afterDeadline);
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe('refunded');
    expect(expired[0].resolvedAt).toBeDefined();
    expect(await service.expireHeldEscrows(afterDeadline)).toHaveLength(0);
  });

  it('sets a heldUntil deadline on every new hold', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(Date.parse(record.heldUntil!)).toBeGreaterThan(Date.parse(record.heldAt));
  });
});

// Stage 22 (audit C2): verify-before-credit evidence on the escrow record.
describe('EscrowService deposit verification evidence (audit C2)', () => {
  it('persists the verified deposit reference on the hold', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-001',
      verified: true
    });
    expect(record.depositReference).toBe('paystack:dep-001');
    expect(record.depositVerifiedAt).toBeDefined();
    const stored = await service.escrowForOrder('order-buyer-cassava');
    expect(stored?.depositReference).toBe('paystack:dep-001');
    expect(stored?.depositVerifiedAt).toBe(record.depositVerifiedAt);
  });

  it('records declarative deposits as unverified', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'declared-ref',
      verified: false
    });
    expect(record.depositReference).toBe('declared-ref');
    expect(record.depositVerifiedAt).toBeUndefined();
  });

  it('auto-release proceeds for provider-verified holds when a provider is wired', async () => {
    const { provider } = fakeProvider();
    const { service } = makeService(provider);
    await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-002',
      verified: true
    });
    const released = await service.releaseForOrder('order-buyer-cassava', 'system');
    expect(released?.status).toBe('released');
  });

  it('blocks auto-release of unverified holds when a provider is wired', async () => {
    const { provider } = fakeProvider();
    const { service } = makeService(provider);
    // Declarative hold (no provider verification) while a provider is wired.
    await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'declared-ref',
      verified: false
    });
    await expect(service.releaseForOrder('order-buyer-cassava', 'system')).rejects.toThrowError(
      ConflictException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
    // The admin-mediated path stays available for unverified holds.
    const record = await service.escrowForOrder('order-buyer-cassava');
    expect((await service.transition(record!.id, 'released', admin)).status).toBe('released');
  });

  it('still auto-releases unverified holds when no provider is wired outside production', async () => {
    const { service } = makeService();
    await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'declared-ref',
      verified: false
    });
    const released = await service.releaseForOrder('order-buyer-cassava', 'system');
    expect(released?.status).toBe('released');
  });
});
