import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentProviderPort, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryEscrowPayoutRepository } from '../../database/repositories/payout.repository.js';
import { EscrowService } from './escrow.service.js';
import {
  LiveEscrowPayoutDriver,
  StubEscrowPayoutDriver,
  type EscrowPayoutDriverPort
} from './payout.driver.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

// Seed order 'order-buyer-cassava': ₦370,000 total, escrowRequired, confirmed.
function makeService(
  provider?: PaymentProviderPort,
  payoutDriver?: EscrowPayoutDriverPort,
  payouts = payoutDriver ? createInMemoryEscrowPayoutRepository() : undefined
) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new EscrowService(
    events,
    createInMemoryOrderRepository(),
    createInMemoryEscrowRepository(),
    provider,
    payoutDriver,
    payouts
  );
  return { service, events, payouts };
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

// Stage 23: escrow payout rails — release/refund go through the recorded,
// idempotent ESCROW_PAYOUT_DRIVER port and fail closed in production.

/** Records payout calls; can be told to fail the first N payout attempts. */
function fakePayoutDriver(failures = 0) {
  const calls: string[] = [];
  let remaining = failures;
  const driver: EscrowPayoutDriverPort = {
    name: 'stub',
    payout: async (command) => {
      calls.push(`${command.kind}:${command.idempotencyKey}`);
      if (remaining-- > 0) {
        throw new Error('rail unreachable');
      }
      return { providerReference: `stub-payout:${command.idempotencyKey}`, basis: 'stub' };
    }
  };
  return { driver, calls };
}

// Low-entropy, obviously-fake dummy credentials (never real secrets).
const DUMMY_URL = 'https://payout-provider.example.invalid';
const DUMMY_KEY = 'dummy-payout-api-key-0000';
const DUMMY_SECRET = 'dummy-payout-signing-secret-0000';

describe('EscrowService payout rails (Stage 23)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('records and succeeds release payouts through the stub driver outside production', async () => {
    const { driver, calls } = fakePayoutDriver();
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    const released = await service.transition(record.id, 'released', buyer);
    expect(released.status).toBe('released');
    expect(calls).toEqual([`release:escrow-payout:release:${record.id}`]);

    const attempts = await payouts!.all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      escrowId: record.id,
      orderId: 'order-buyer-cassava',
      kind: 'release',
      amountKobo: 37_000_000,
      idempotencyKey: `escrow-payout:release:${record.id}`,
      provider: 'stub',
      status: 'succeeded'
    });
    expect(Number.isInteger(attempts[0].amountKobo)).toBe(true);
    expect(attempts[0].providerReference).toContain(attempts[0].idempotencyKey);
  });

  it('records refund payouts the same way', async () => {
    const { driver, calls } = fakePayoutDriver();
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    const refunded = await service.transition(record.id, 'refunded', seller);
    expect(refunded.status).toBe('refunded');
    expect(calls).toEqual([`refund:escrow-payout:refund:${record.id}`]);
    expect((await payouts!.all())[0]).toMatchObject({ kind: 'refund', status: 'succeeded' });
  });

  it('fails closed 503 in production with a stub driver — nothing recorded, escrow untouched', async () => {
    process.env.NODE_ENV = 'production';
    const { service, events, payouts } = makeService(undefined, new StubEscrowPayoutDriver());
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      ServiceUnavailableException
    );
    await expect(service.transition(record.id, 'refunded', seller)).rejects.toThrowError(
      ServiceUnavailableException
    );
    // Fail-closed means NOTHING moved: escrow still held, no payout attempt,
    // no state transition posted anywhere.
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
    expect(await payouts!.all()).toHaveLength(0);
    expect(
      (await events.listOutbox()).filter((e) => e.name === 'marketplace.escrow.status_changed')
    ).toHaveLength(0);
  });

  it('fails closed 503 in production with no payout driver at all', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      ServiceUnavailableException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
  });

  it('blocks order-completion auto-release in production while the rail is stubbed', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = makeService(undefined, new StubEscrowPayoutDriver());
    // Provider-verified deposit evidence (Stage 22 gate passes) — the payout
    // rail is the blocker now.
    await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-payout-1',
      verified: true
    });
    await expect(service.releaseForOrder('order-buyer-cassava', 'system')).rejects.toThrowError(
      ServiceUnavailableException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
  });

  it('live driver (configured) answers 503 not-integrated; the escrow stays resumable', async () => {
    process.env.NODE_ENV = 'production';
    const live = new LiveEscrowPayoutDriver(DUMMY_URL, DUMMY_KEY, DUMMY_SECRET);
    const { service, payouts } = makeService(undefined, live);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-payout-2',
      verified: true
    });

    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      ServiceUnavailableException
    );
    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      /not yet integrated/
    );
    // The intent persisted (resumable), the attempt is recorded as failed,
    // and the escrow never reached a terminal state.
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('releasing');
    const attempts = await payouts!.all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ kind: 'release', provider: 'live', status: 'failed' });
    expect(attempts[0].failureReason).toMatch(/not yet integrated/);
  });

  it('retry with the same idempotency key converges without a second payout record', async () => {
    const { driver, calls } = fakePayoutDriver(1); // first payout attempt crashes
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      BadGatewayException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('releasing');
    expect((await payouts!.all())[0].status).toBe('failed');

    const released = await service.transition(record.id, 'released', buyer);
    expect(released.status).toBe('released');
    // One recorded attempt, updated in place; the driver saw the same key twice.
    const attempts = await payouts!.all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect(calls).toEqual([
      `release:escrow-payout:release:${record.id}`,
      `release:escrow-payout:release:${record.id}`
    ]);

    // Terminal replay: no further driver call, still one record.
    await service.transition(record.id, 'released', buyer);
    expect(calls).toHaveLength(2);
    expect(await payouts!.all()).toHaveLength(1);
  });

  it('never double-pays: a concurrent release + refund race records exactly one payout', async () => {
    const { driver, calls } = fakePayoutDriver();
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    const outcomes = await Promise.allSettled([
      service.transition(record.id, 'released', buyer),
      service.transition(record.id, 'refunded', seller)
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    const final = await service.escrowForOrder('order-buyer-cassava');
    expect(['released', 'refunded']).toContain(final?.status);
    // Exactly one payout attempt reached the driver — never both.
    expect(calls).toHaveLength(1);
    const attempts = await payouts!.all();
    expect(attempts.filter((a) => a.status === 'succeeded')).toHaveLength(1);
  });
});
