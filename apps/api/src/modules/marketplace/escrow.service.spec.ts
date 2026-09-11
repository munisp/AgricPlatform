import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EscrowRecord,
  PaymentChargeCommand,
  PaymentChargeResult,
  PaymentProviderPort,
  PaymentRefundResult,
  PaymentReleaseResult,
  PaymentVerificationResult,
  User
} from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository, InMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryEscrowPayoutRepository, InMemoryEscrowPayoutRepository } from '../../database/repositories/payout.repository.js';
import { EscrowService, ESCROW_HOLD_TTL_MS } from './escrow.service.js';
import {
  LiveEscrowPayoutDriver,
  StubEscrowPayoutDriver,
  type EscrowPayoutDriverPort,
  type EscrowPayoutResult
} from './payout.driver.js';

const buyer = { id: 'user-buyer', roles: ['buyer'] } as User;
const seller = { id: 'user-seller', roles: ['seller'] } as User;
const admin = { id: 'user-admin', roles: ['admin'] } as User;
const outsider = { id: 'user-outsider', roles: ['buyer'] } as User;

/**
 * Controllable fake provider: `verify` behaviour is scripted per reference
 * ('paystack:*' verifies success with the requested amount; anything else
 * returns a mismatch).
 */
function fakeProvider() {
  const provider: PaymentProviderPort = {
    name: 'fake',
    charge: async (command: PaymentChargeCommand): Promise<PaymentChargeResult> => ({
      providerReference: `fake:${command.reference}`,
      authorizationUrl: `https://fake.example/pay/${command.reference}`
    }),
    verify: async (reference: string): Promise<PaymentVerificationResult> => {
      if (reference.startsWith('paystack:')) {
        return {
          reference,
          status: 'success',
          amountKobo: 37_000_000,
          currency: 'NGN',
          basis: 'live'
        };
      }
      return {
        reference,
        status: 'failed',
        amountKobo: 1,
        currency: 'NGN',
        basis: 'live'
      };
    },
    hold: async () => ({ providerReference: 'fake-hold-ref' }),
    release: async (providerReference: string): Promise<PaymentReleaseResult> => ({
      providerReference
    }),
    refund: async (providerReference: string): Promise<PaymentRefundResult> => ({
      providerReference
    })
  };
  return { provider };
}

function makeService(
  provider?: PaymentProviderPort,
  payoutDriver?: EscrowPayoutDriverPort,
  payouts?: ReturnType<typeof createInMemoryEscrowPayoutRepository>
) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const payoutRepo = payoutDriver !== undefined ? (payouts ?? createInMemoryEscrowPayoutRepository()) : payouts;
  const service = new EscrowService(
    events,
    createInMemoryOrderRepository(),
    createInMemoryEscrowRepository(),
    provider,
    payoutDriver,
    payoutRepo
  );
  return { service, events, payouts: payoutRepo };
}

describe('EscrowService', () => {
  it('holds the order total idempotently (retry replays the same record)', async () => {
    const { service } = makeService();
    const first = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(first.amountKobo).toBe(37_000_000);
    expect(first.status).toBe('held');
    const second = await service.holdForOrder('order-buyer-cassava', buyer.id);
    expect(second.id).toBe(first.id);
  });

  it('rejects escrow for a cancelled order', async () => {
    const { service } = makeService();
    await expect(service.holdForOrder('order-cancelled', buyer.id)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('walks held -> disputed -> refunded (admin-mediated resolution)', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    const disputed = await service.transition(record.id, 'disputed', seller);
    expect(disputed.status).toBe('disputed');
    const refunded = await service.transition(record.id, 'refunded', admin);
    expect(refunded.status).toBe('refunded');
    expect(refunded.resolvedAt).toBeDefined();
  });

  it('the buyer releases; the seller refunds; both may dispute', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(service.transition(record.id, 'released', seller)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(service.transition(record.id, 'refunded', buyer)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(service.transition(record.id, 'disputed', outsider)).rejects.toThrowError(
      ForbiddenException
    );
    expect((await service.transition(record.id, 'released', buyer)).status).toBe('released');
  });

  it('re-sending the current status is an idempotent replay, not a 409', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await service.transition(record.id, 'disputed', buyer);
    const replay = await service.transition(record.id, 'disputed', buyer);
    expect(replay.status).toBe('disputed');
  });

  it('rejects invalid transitions and party-only resolution for disputes', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(service.transition(record.id, 'refunded', seller)).resolves.toMatchObject({
      status: 'refunded'
    });
    await expect(service.transition(record.id, 'disputed', admin)).rejects.toThrowError(
      BadRequestException
    );

    const disputedOrder = await service.holdForOrder('order-buyer-cassava-2', buyer.id);
    await service.transition(disputedOrder.id, 'disputed', buyer);
    await expect(
      service.transition(disputedOrder.id, 'refunded', seller)
    ).rejects.toThrowError(ForbiddenException);
  });

  it('system release path releases the held escrow for the order', async () => {
    const { service } = makeService();
    await service.holdForOrder('order-buyer-cassava', buyer.id);
    const released = await service.releaseForOrder('order-buyer-cassava', 'system');
    expect(released?.status).toBe('released');
  });

  it('expires held escrows past their heldUntil deadline into refunded', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    const afterDeadline = new Date(Date.parse(record.heldUntil!) + 1000).toISOString();
    const expired = await service.expireHeldEscrows(afterDeadline);
    expect(expired.map((row) => row.id)).toEqual([record.id]);
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('refunded');
  });

  it('uses the provider rail when a payment provider is wired', async () => {
    const { provider } = fakeProvider();
    const { service } = makeService(provider);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-1',
      verified: true
    });
    expect(record.providerReference).toBe('fake-hold-ref');
    const released = await service.releaseForOrder('order-buyer-cassava', 'system');
    expect(released?.status).toBe('released');
  });

  it('provider-backed release persists the pending state first (crash-resumable)', async () => {
    const { provider } = fakeProvider();
    let failOnce = true;
    const flaky: PaymentProviderPort = {
      ...provider,
      release: async (providerReference: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('provider timeout');
        }
        return { providerReference };
      }
    };
    const { service } = makeService(flaky);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-2',
      verified: true
    });
    // First release attempt: provider call fails AFTER the pending state
    // was persisted — the escrow is 'releasing', never silently 'released'.
    await expect(service.releaseForOrder('order-buyer-cassava', 'system')).rejects.toThrowError(
      BadGatewayException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('releasing');
    // Retry: converges through the pending resume path to the terminal state.
    const released = await service.releaseForOrder('order-buyer-cassava', 'system');
    expect(released?.status).toBe('released');
    expect(record.status).toBe('held');
  });

  it('a provider refund failure parks the escrow in refunding until the retry', async () => {
    const { provider } = fakeProvider();
    let failOnce = true;
    const flaky: PaymentProviderPort = {
      ...provider,
      refund: async (providerReference: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('provider 502');
        }
        return { providerReference };
      }
    };
    const { service } = makeService(flaky);
    await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-3',
      verified: true
    });
    await expect(service.refundForOrder('order-buyer-cassava', 'system')).rejects.toThrowError(
      BadGatewayException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('refunding');
    const refunded = await service.refundForOrder('order-buyer-cassava', 'system');
    expect(refunded?.status).toBe('refunded');
  });

  it('blocks the escrow refund when the cancelling order is refunded', async () => {
    const { service } = makeService();
    await service.holdForOrder('order-buyer-cassava', buyer.id);
    const refunded = await service.refundForOrder('order-buyer-cassava', 'system');
    expect(refunded?.status).toBe('refunded');
  });

  it('emits marketplace.escrow.status_changed for each transition', async () => {
    const { service, events } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await service.transition(record.id, 'released', buyer);
    const outbox = await events.listOutbox();
    expect(outbox.map((event) => event.name)).toEqual([
      'marketplace.escrow.held',
      'marketplace.escrow.status_changed'
    ]);
    expect(outbox[1].payload).toMatchObject({
      escrowId: record.id,
      from: 'held',
      to: 'released'
    });
  });

  it('concurrent transitions on the same escrow cannot both win', async () => {
    const { service } = makeService();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    const outcomes = await Promise.allSettled([
      service.transition(record.id, 'released', buyer),
      service.transition(record.id, 'disputed', buyer)
    ]);
    const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    const final = await service.escrowForOrder('order-buyer-cassava');
    expect(['released', 'disputed']).toContain(final?.status);
  });
});

// Stage 22 (audit C2): verify-before-credit — a wired provider gates the
// money-out paths so declarative (never verified) deposits cannot be
// released or refunded as if real money sat behind them.
describe('EscrowService verify-before-credit (Stage 22, audit C2)', () => {
  it('blocks auto-release of unverified holds when a provider is wired', async () => {
    const { provider } = fakeProvider();
    // Legacy pre-Stage-22 row: held with a declarative (never verified)
    // deposit. New unverified holds can no longer be created while a
    // provider is wired (Stage 24 hold gate), so seed the legacy row
    // directly.
    const legacy: EscrowRecord = {
      id: 'escrow-legacy-unverified',
      orderId: 'order-buyer-cassava',
      amountKobo: 37_000_000,
      status: 'held',
      depositReference: 'declared-ref',
      heldAt: new Date().toISOString(),
      heldUntil: new Date(Date.now() + ESCROW_HOLD_TTL_MS).toISOString()
    };
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const service = new EscrowService(
      events,
      createInMemoryOrderRepository(),
      new InMemoryEscrowRepository([legacy]),
      provider
    );
    await expect(service.releaseForOrder('order-buyer-cassava', 'system')).rejects.toThrowError(
      ConflictException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
    // The admin-mediated path stays available for unverified holds — via
    // DISPUTE resolution only (Stage 24, audit A1-1).
    expect((await service.transition(legacy.id, 'disputed', seller)).status).toBe('disputed');
    expect((await service.transition(legacy.id, 'released', admin)).status).toBe('released');
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
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-prod-1',
      verified: true
    });

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
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-prod-2',
      verified: true
    });
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
    expect(calls).toHaveBeenCalledTimes(2);
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

// Stage 24 (audit A1-1): verify-before-credit on EVERY money-out path —
// the party-driven transition and the expiry sweep were ungated siblings of
// the system release path. Adopted from the Stage-24 auditor red spec.
describe('EscrowService verify gates on all money-out paths (Stage 24, audit A1-1)', () => {
  it('refuses to create a hold without verified deposit evidence when a provider is wired', async () => {
    const { provider } = fakeProvider();
    const { service } = makeService(provider);
    // What POST /orders/:id/escrow used to do: hold with NO deposit evidence.
    await expect(service.holdForOrder('order-buyer-cassava', buyer.id)).rejects.toThrowError(
      ConflictException
    );
    await expect(
      service.holdForOrder('order-buyer-cassava', buyer.id, {
        reference: 'declared-ref',
        verified: false
      })
    ).rejects.toThrowError(ConflictException);
    expect(await service.escrowForOrder('order-buyer-cassava')).toBeUndefined();
  });

  it('the buyer-driven transition cannot release an unverified hold through the payout rail', async () => {
    const { provider } = fakeProvider();
    const { driver, calls } = fakePayoutDriver();
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const payouts = createInMemoryEscrowPayoutRepository();
    const legacy: EscrowRecord = {
      id: 'escrow-unverified-rail',
      orderId: 'order-buyer-cassava',
      amountKobo: 37_000_000,
      status: 'held',
      depositReference: 'declared-ref',
      heldAt: new Date().toISOString(),
      heldUntil: new Date(Date.now() + ESCROW_HOLD_TTL_MS).toISOString()
    };
    const service = new EscrowService(
      events,
      createInMemoryOrderRepository(),
      new InMemoryEscrowRepository([legacy]),
      provider,
      driver,
      payouts
    );
    // System path refuses (Stage 22 gate, still holding):
    await expect(service.releaseForOrder('order-buyer-cassava', 'system')).rejects.toThrowError(
      ConflictException
    );
    // Stage 24: the direct transition endpoint refuses identically — no
    // payout attempt is recorded and the driver is never invoked.
    await expect(service.transition(legacy.id, 'released', buyer)).rejects.toThrowError(
      ConflictException
    );
    expect(calls).toHaveLength(0);
    expect(await payouts.all()).toHaveLength(0);
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
  });

  it('the expiry sweep skips (never refunds) an unverified hold when a provider is wired', async () => {
    const { provider } = fakeProvider();
    const { driver, calls } = fakePayoutDriver();
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const payouts = createInMemoryEscrowPayoutRepository();
    const legacy: EscrowRecord = {
      id: 'escrow-unverified-expiry',
      orderId: 'order-buyer-cassava',
      amountKobo: 37_000_000,
      status: 'held',
      depositReference: 'declared-ref',
      heldAt: new Date().toISOString(),
      heldUntil: new Date(Date.now() - 1000).toISOString() // already past deadline
    };
    const service = new EscrowService(
      events,
      createInMemoryOrderRepository(),
      new InMemoryEscrowRepository([legacy]),
      provider,
      driver,
      payouts
    );
    const expired = await service.expireHeldEscrows(new Date().toISOString());
    expect(expired).toHaveLength(0); // skipped, not refunded
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
    expect(calls).toHaveLength(0); // no refund of money never deposited
    expect(await payouts.all()).toHaveLength(0);
  });

  it('the expiry sweep still refunds verified holds through the rail', async () => {
    const { provider } = fakeProvider();
    const { driver } = fakePayoutDriver();
    const { service } = makeService(provider, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id, {
      reference: 'paystack:dep-expiry-ok',
      verified: true
    });
    const afterDeadline = new Date(Date.parse(record.heldUntil!) + 1000).toISOString();
    const expired = await service.expireHeldEscrows(afterDeadline);
    expect(expired.map((row) => row.id)).toEqual([record.id]);
    expect(expired[0].status).toBe('refunded');
  });
});

// Stage 24 (audit A4-3): the payout attempt is CLAIMED (CAS to in_progress)
// before the driver is invoked — concurrent retries never drive twice, and
// a succeeded attempt can never regress to failed.
describe('EscrowService payout attempt claims (Stage 24, audit A4-3)', () => {
  it('two concurrent retries of a failed attempt invoke the driver exactly once', async () => {
    const { driver, calls } = fakePayoutDriver(1); // first payout attempt crashes
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      BadGatewayException
    );
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('releasing');
    expect((await payouts!.all())[0].status).toBe('failed');
    expect(calls).toHaveLength(1);

    // Two concurrent retries (double-click across channels): exactly one
    // claims the attempt and drives; the loser sees 409 in-progress.
    const outcomes = await Promise.allSettled([
      service.transition(record.id, 'released', buyer),
      service.transition(record.id, 'released', buyer)
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConflictException);
    expect(String(loser.reason.message)).toMatch(/in progress/);

    // One driver invocation across both retries; one attempt row, succeeded.
    expect(calls).toEqual([
      `release:escrow-payout:release:${record.id}`,
      `release:escrow-payout:release:${record.id}`
    ]);
    const attempts = await payouts!.all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('released');
  });

  it('a fresh in_progress claim rejects the concurrent retry before any driver call', async () => {
    // A driver that stays in flight until released, so the second caller
    // observes a live claim.
    let releaseDriver: (value: EscrowPayoutResult) => void = () => {};
    const driver: EscrowPayoutDriverPort = {
      name: 'stub',
      payout: () =>
        new Promise((res) => {
          releaseDriver = res;
        })
    };
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    const first = service.transition(record.id, 'released', buyer);
    // Let the first claimant reach the driver.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrowError(
      ConflictException
    );
    expect((await payouts!.all())[0].status).toBe('in_progress');

    releaseDriver({ providerReference: 'stub-payout:ok', basis: 'stub' });
    expect((await first).status).toBe('released');
    expect((await payouts!.all())[0].status).toBe('succeeded');
  });

  it('succeeded never regresses: a stale failure finalize is adopted, not written', async () => {
    const { driver } = fakePayoutDriver();
    const { service, payouts } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await service.transition(record.id, 'released', buyer);
    const attempt = (await payouts!.all())[0];
    expect(attempt.status).toBe('succeeded');

    // A stale writer (e.g. a crashed-and-resumed twin) tries to finalize the
    // same attempt as failed. The guarded write refuses the regression.
    await expect(
      payouts!.updateExpected(
        attempt.id,
        { status: 'failed', failureReason: 'late failure', updatedAt: new Date().toISOString() },
        { status: 'in_progress' }
      )
    ).rejects.toThrowError(ConflictException);
    expect((await payouts!.all())[0].status).toBe('succeeded');
  });
});

// WP-G12: payout lease-expiry double-drive fix — a claimant that stalls past
// PAYOUT_CLAIM_LEASE_MS between winning the claim and invoking the driver
// must CAS-revalidate the lease BEFORE driving; a stale claimant backs off.
describe('EscrowService payout lease revalidation (WP-G12)', () => {
  /**
   * Wraps the in-memory payout repo so that the service's pre-drive lease
   * revalidation (updateExpected with a claimedAt-only patch) loses to a
   * twin that re-claimed the expired lease and completed the payout while
   * the original claimant was stalled. Pre-fix there is NO revalidation
   * write, so the race hook never fires and the stalled claimant drives —
   * this spec then fails on the zero-driver-call assertion.
   */
  function raceOnRevalidation(inner: InMemoryEscrowPayoutRepository) {
    const original = inner.updateExpected.bind(inner);
    let raced = false;
    const wrapper = Object.create(inner) as InMemoryEscrowPayoutRepository;
    wrapper.updateExpected = async (id, patch, expected, ...rest) => {
      const isLeaseRevalidation =
        !raced &&
        patch !== undefined &&
        'claimedAt' in patch &&
        !('status' in patch) &&
        expected !== undefined &&
        'claimedAt' in expected;
      if (isLeaseRevalidation) {
        raced = true;
        // The twin's drive already landed: the attempt succeeded while the
        // stalled claimant was still waking up.
        await inner.update(id, {
          status: 'succeeded',
          providerReference: 'psp-twin',
          updatedAt: new Date().toISOString()
        });
      }
      return original(id, patch, expected, ...rest);
    };
    return wrapper;
  }

  it('a stalled claimant whose lease was taken over backs off BEFORE the driver call (no double drive)', async () => {
    const { driver, calls } = fakePayoutDriver();
    const inner = createInMemoryEscrowPayoutRepository();
    const raced = raceOnRevalidation(inner);
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const service = new EscrowService(
      events,
      createInMemoryOrderRepository(),
      createInMemoryEscrowRepository(),
      undefined,
      driver,
      raced
    );
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);

    const released = await service.transition(record.id, 'released', buyer);
    // The twin's win is adopted: the escrow still reaches the terminal state
    // through the guarded write, but THIS claimant never invoked the driver.
    expect(released.status).toBe('released');
    expect(calls).toHaveLength(0);
    const attempts = await inner.all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect(attempts[0].providerReference).toBe('psp-twin');
  });

  it('the adopted attempt replays idempotently: a retry never drives a second time', async () => {
    const { driver, calls } = fakePayoutDriver();
    const { service } = makeService(undefined, driver);
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id);
    await service.transition(record.id, 'released', buyer);
    expect(calls).toHaveLength(1);
    // Replay of the terminal transition: no new claim, no new driver call.
    const replayed = await service.transition(record.id, 'released', buyer);
    expect(replayed.status).toBe('released');
    expect(calls).toHaveLength(1);
  });
});
