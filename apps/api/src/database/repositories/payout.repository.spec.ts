import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { EscrowPayout } from '@agric-platform/shared';
import {
  createInMemoryEscrowPayoutRepository,
  hashPayoutPayload,
  recordPayoutAttempt
} from './payout.repository.js';

function attempt(overrides: Partial<EscrowPayout> = {}): EscrowPayout {
  const base = {
    escrowId: 'escrow-1',
    orderId: 'order-1',
    kind: 'release' as const,
    amountKobo: 37_000_000
  };
  const now = new Date().toISOString();
  return {
    id: 'payout-1',
    ...base,
    idempotencyKey: 'escrow-payout:release:escrow-1',
    payloadHash: hashPayoutPayload(base),
    provider: 'stub',
    status: 'recorded',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('recordPayoutAttempt idempotency contract (Stage 23)', () => {
  it('records a new attempt under its idempotency key', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const recorded = await recordPayoutAttempt(repo, attempt());
    expect(recorded.status).toBe('recorded');
    expect(await repo.all()).toHaveLength(1);
  });

  it('replays the stored attempt for the same key + same payload', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const first = await recordPayoutAttempt(repo, attempt());
    // A retry builds a fresh row (new id, later timestamp) under the same key.
    const retry = await recordPayoutAttempt(repo, attempt({ id: 'payout-2' }));
    expect(retry.id).toBe(first.id); // replay, not a second record
    expect(await repo.all()).toHaveLength(1);
  });

  it('rejects the same key with a different payload (409)', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    await recordPayoutAttempt(repo, attempt());
    // Same key, different amount — a client bug or a confused retry.
    const tampered = attempt({ id: 'payout-3', amountKobo: 100 });
    tampered.payloadHash = hashPayoutPayload({
      escrowId: tampered.escrowId,
      orderId: tampered.orderId,
      kind: tampered.kind,
      amountKobo: tampered.amountKobo
    });
    await expect(recordPayoutAttempt(repo, tampered)).rejects.toThrowError(ConflictException);
    expect(await repo.all()).toHaveLength(1);
  });

  it('different keys for release vs refund of the same escrow coexist', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    await recordPayoutAttempt(repo, attempt());
    const refund = attempt({
      id: 'payout-4',
      kind: 'refund',
      idempotencyKey: 'escrow-payout:refund:escrow-1'
    });
    refund.payloadHash = hashPayoutPayload({
      escrowId: refund.escrowId,
      orderId: refund.orderId,
      kind: refund.kind,
      amountKobo: refund.amountKobo
    });
    await recordPayoutAttempt(repo, refund);
    expect(await repo.all()).toHaveLength(2);
  });
});
