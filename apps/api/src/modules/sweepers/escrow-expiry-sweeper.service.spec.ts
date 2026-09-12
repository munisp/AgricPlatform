import { describe, expect, it } from 'vitest';
import type { EscrowPayout, EscrowRecord } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { InMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryEscrowPayoutRepository,
  hashPayoutPayload
} from '../../database/repositories/payout.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { EscrowService } from '../marketplace/escrow.service.js';
import { StubEscrowPayoutDriver, type EscrowPayoutDriverPort } from '../marketplace/payout.driver.js';
import {
  ESCROW_EXPIRY_SWEEPER_CONSUMER,
  ESCROW_PENDING_STUCK_MS,
  EscrowExpirySweeperService
} from './escrow-expiry-sweeper.service.js';

const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = new Date('2026-06-01T00:00:00.000Z');

let escrowSeq = 0;

function heldEscrow(overrides: Partial<EscrowRecord> = {}): EscrowRecord {
  escrowSeq += 1;
  const id = overrides.id ?? `escrow-sweep-${escrowSeq}`;
  return {
    id,
    orderId: `order-${id}`,
    amountKobo: 125_000,
    status: 'held',
    heldAt: '2025-12-01T00:00:00.000Z',
    heldUntil: PAST,
    ...overrides
  };
}

function stuckRefundAttempt(escrow: EscrowRecord, updatedAt: string): EscrowPayout {
  const payload = {
    escrowId: escrow.id,
    orderId: escrow.orderId,
    kind: 'refund' as const,
    amountKobo: escrow.amountKobo
  };
  return {
    id: `payout-${escrow.id}`,
    ...payload,
    idempotencyKey: `escrow-payout:refund:${escrow.id}`,
    payloadHash: hashPayoutPayload(payload),
    provider: 'stub',
    status: 'failed',
    createdAt: updatedAt,
    updatedAt
  };
}

async function makeSweep(options: {
  escrows?: EscrowRecord[];
  payouts?: EscrowPayout[];
  driver?: EscrowPayoutDriverPort;
}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const escrowRepo = new InMemoryEscrowRepository(options.escrows ?? []);
  const payoutRepo = createInMemoryEscrowPayoutRepository();
  for (const attempt of options.payouts ?? []) {
    await payoutRepo.create(attempt);
  }
  const driver = options.driver ?? new StubEscrowPayoutDriver();
  const escrowService = new EscrowService(
    events,
    createInMemoryOrderRepository(),
    escrowRepo,
    undefined,
    driver,
    payoutRepo
  );
  const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
  const sweeper = new EscrowExpirySweeperService(escrowService, dedup, escrowRepo, payoutRepo);
  return { sweeper, escrowRepo, payoutRepo, dedup, driver };
}

describe('EscrowExpirySweeperService (WP-G12)', () => {
  it('refunds expired held escrows through the recorded payout rail (batch selection)', async () => {
    const expiredA = heldEscrow();
    const expiredB = heldEscrow();
    const fresh = heldEscrow({ heldUntil: FUTURE });
    const terminal = heldEscrow({ status: 'released', resolvedAt: PAST });
    const { sweeper, escrowRepo, payoutRepo } = await makeSweep({
      escrows: [expiredA, expiredB, fresh, terminal]
    });

    const result = await sweeper.sweep(NOW);
    expect(result).toMatchObject({ scanned: 2, refunded: 2, resumed: 0, conflicts: 0, failed: 0 });

    expect((await escrowRepo.findById(expiredA.id))?.status).toBe('refunded');
    expect((await escrowRepo.findById(expiredB.id))?.status).toBe('refunded');
    // Untouched: the live hold and the terminal record.
    expect((await escrowRepo.findById(fresh.id))?.status).toBe('held');
    expect((await escrowRepo.findById(terminal.id))?.status).toBe('released');
    // Every refund went through the recorded, balanced payout rail — one
    // succeeded attempt per escrow, never a raw ledger insert.
    const attempts = await payoutRepo.all();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === 'succeeded' && a.kind === 'refund')).toBe(true);
  });

  it('honours the batch cap: a pass processes at most batchSize expired holds', async () => {
    const records = [heldEscrow(), heldEscrow(), heldEscrow()];
    const { sweeper } = await makeSweep({ escrows: records });
    const first = await sweeper.sweep(NOW, 2);
    expect(first.refunded).toBe(2);
    const second = await sweeper.sweep(NOW, 2);
    expect(second.refunded).toBe(1);
    const third = await sweeper.sweep(NOW, 2);
    expect(third.scanned).toBe(0);
  });

  it('is idempotent: a double-run is a no-op (markers + terminal states)', async () => {
    const record = heldEscrow();
    const driverCalls: string[] = [];
    const countingDriver: EscrowPayoutDriverPort = {
      name: 'stub',
      payout: async (command) => {
        driverCalls.push(command.idempotencyKey);
        return { providerReference: `stub-payout:${command.idempotencyKey}`, basis: 'stub' };
      }
    };
    const { sweeper, payoutRepo } = await makeSweep({ escrows: [record], driver: countingDriver });

    const first = await sweeper.sweep(NOW);
    expect(first.refunded).toBe(1);
    const second = await sweeper.sweep(NOW);
    expect(second).toMatchObject({ scanned: 0, refunded: 0, failed: 0 });
    expect(driverCalls).toHaveLength(1);
    expect((await payoutRepo.all()).filter((a) => a.status === 'succeeded')).toHaveLength(1);
  });

  it('skips rows already covered by the exactly-once marker', async () => {
    const record = heldEscrow();
    const { sweeper, dedup, escrowRepo } = await makeSweep({ escrows: [record] });
    await dedup.mark(ESCROW_EXPIRY_SWEEPER_CONSUMER, record.id);
    const result = await sweeper.sweep(NOW);
    expect(result).toMatchObject({ scanned: 1, skippedMarked: 1, refunded: 0 });
    expect((await escrowRepo.findById(record.id))?.status).toBe('held');
  });

  it('a CAS race loser backs off: a concurrent transition wins, nothing is marked', async () => {
    const record = heldEscrow();
    const { sweeper, escrowRepo } = await makeSweep({ escrows: [record] });
    // Wrap the guarded write so a twin transition (dispute freeze) lands
    // between the sweeper's read and its CAS — the sweeper must back off.
    const original = escrowRepo.updateExpected.bind(escrowRepo);
    let raced = false;
    escrowRepo.updateExpected = async (id, patch, expected, ...rest) => {
      if (!raced && id === record.id) {
        raced = true;
        await escrowRepo.update(id, { status: 'disputed' });
      }
      return original(id, patch, expected, ...rest);
    };
    const result = await sweeper.sweep(NOW);
    expect(result.conflicts).toBe(1);
    expect(result.refunded).toBe(0);
    expect((await escrowRepo.findById(record.id))?.status).toBe('disputed');
  });

  it('resumes a stuck refunding drive once its payout attempt has gone quiet', async () => {
    const record = heldEscrow({ status: 'refunding', heldUntil: FUTURE });
    const staleAttempt = stuckRefundAttempt(
      record,
      new Date(NOW.getTime() - ESCROW_PENDING_STUCK_MS - 1000).toISOString()
    );
    const { sweeper, escrowRepo } = await makeSweep({ escrows: [record], payouts: [staleAttempt] });
    const result = await sweeper.sweep(NOW);
    expect(result).toMatchObject({ scanned: 1, resumed: 1, refunded: 0 });
    expect((await escrowRepo.findById(record.id))?.status).toBe('refunded');
  });

  it('leaves a fresh pending drive alone (attempt moved inside the stuck TTL)', async () => {
    const record = heldEscrow({ status: 'refunding', heldUntil: FUTURE });
    const freshAttempt = stuckRefundAttempt(record, NOW.toISOString());
    const { sweeper, escrowRepo } = await makeSweep({ escrows: [record], payouts: [freshAttempt] });
    const result = await sweeper.sweep(NOW);
    expect(result).toMatchObject({ scanned: 0, resumed: 0 });
    expect((await escrowRepo.findById(record.id))?.status).toBe('refunding');
  });

  it('a failing rail is counted, unmarked and recovered by a later pass', async () => {
    const record = heldEscrow();
    let failures = 1;
    const flakyDriver: EscrowPayoutDriverPort = {
      name: 'stub',
      payout: async (command) => {
        if (failures-- > 0) {
          throw new Error('rail unreachable');
        }
        return { providerReference: `stub-payout:${command.idempotencyKey}`, basis: 'stub' };
      }
    };
    const { sweeper, escrowRepo, payoutRepo, dedup } = await makeSweep({ escrows: [record], driver: flakyDriver });

    const first = await sweeper.sweep(NOW);
    expect(first).toMatchObject({ refunded: 0, failed: 1 });
    // The escrow is parked in the resumable pending state, NOT marked.
    expect((await escrowRepo.findById(record.id))?.status).toBe('refunding');
    expect(await dedup.has(ESCROW_EXPIRY_SWEEPER_CONSUMER, record.id)).toBe(false);

    // Age the attempt clock so leg B picks the pending drive up.
    const attempt = (await payoutRepo.all())[0];
    expect(attempt.status).toBe('failed');
    await payoutRepo.update(attempt.id, {
      updatedAt: new Date(NOW.getTime() - ESCROW_PENDING_STUCK_MS - 1000).toISOString()
    });

    const second = await sweeper.sweep(NOW);
    expect(second).toMatchObject({ resumed: 1, failed: 0 });
    expect((await escrowRepo.findById(record.id))?.status).toBe('refunded');
    expect(await dedup.has(ESCROW_EXPIRY_SWEEPER_CONSUMER, record.id)).toBe(true);
  });
});
