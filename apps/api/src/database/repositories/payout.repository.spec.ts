import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { EscrowPayout } from '@agric-platform/shared';
import {
  claimPayoutAttempt,
  createInMemoryEscrowPayoutRepository,
  finalizePayoutAttempt,
  hashPayoutPayload,
  PAYOUT_CLAIM_LEASE_MS
} from './payout.repository.js';

function attempt(overrides: Partial<EscrowPayout> = {}): Omit<EscrowPayout, 'status' | 'claimedAt'> {
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
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('claimPayoutAttempt idempotency + claim contract (Stage 23/24)', () => {
  it('claims a new attempt in_progress under its idempotency key', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const claim = await claimPayoutAttempt(repo, attempt());
    expect(claim.claimed).toBe(true);
    expect(claim.attempt.status).toBe('in_progress');
    expect(claim.attempt.claimedAt).toBeDefined();
    expect(await repo.all()).toHaveLength(1);
  });

  it('a concurrent retry seeing a fresh in_progress claim is rejected 409 — never a second claim', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const first = await claimPayoutAttempt(repo, attempt());
    expect(first.claimed).toBe(true);
    // Same key, same payload, fresh claim held by someone else → 409.
    await expect(claimPayoutAttempt(repo, attempt({ id: 'payout-2' }))).rejects.toThrowError(
      ConflictException
    );
    expect(await repo.all()).toHaveLength(1);
  });

  it('two racing first-touches converge on exactly one claimant (adopt-on-23505)', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    // Both callers miss the findOne and race the create; the in-memory repo
    // mirrors the pg UNIQUE(idempotency_key) violation.
    const outcomes = await Promise.allSettled([
      claimPayoutAttempt(repo, attempt()),
      claimPayoutAttempt(repo, attempt({ id: 'payout-twin' }))
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConflictException);
    expect(String(loser.reason.message)).toMatch(/in progress/);
    expect(await repo.all()).toHaveLength(1);
  });

  it('an expired in_progress lease is re-claimable (crash recovery)', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const crashedAt = new Date(Date.now() - PAYOUT_CLAIM_LEASE_MS - 1000);
    const crashed = await claimPayoutAttempt(repo, attempt(), crashedAt);
    expect(crashed.claimed).toBe(true);
    // The claimant died; after the lease a retry re-claims and drives.
    const reclaimed = await claimPayoutAttempt(repo, attempt({ id: 'payout-9' }));
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.attempt.id).toBe(crashed.attempt.id);
    expect(await repo.all()).toHaveLength(1);
  });

  it('a failed attempt is re-claimable by the retry', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const first = await claimPayoutAttempt(repo, attempt());
    await finalizePayoutAttempt(repo, first.attempt, {
      status: 'failed',
      failureReason: 'rail unreachable'
    });
    const retry = await claimPayoutAttempt(repo, attempt({ id: 'payout-3' }));
    expect(retry.claimed).toBe(true);
    expect(retry.attempt.id).toBe(first.attempt.id);
    expect(await repo.all()).toHaveLength(1);
  });

  it('a succeeded attempt replays without a claim (never pay twice)', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const first = await claimPayoutAttempt(repo, attempt());
    await finalizePayoutAttempt(repo, first.attempt, {
      status: 'succeeded',
      providerReference: 'psp-ref-1'
    });
    const replay = await claimPayoutAttempt(repo, attempt({ id: 'payout-4' }));
    expect(replay.claimed).toBe(false);
    expect(replay.attempt.status).toBe('succeeded');
    expect(await repo.all()).toHaveLength(1);
  });

  it('rejects the same key with a different payload (409)', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    await claimPayoutAttempt(repo, attempt());
    // Same key, different amount — a client bug or a confused retry.
    const tampered = attempt({ id: 'payout-5', amountKobo: 100 });
    tampered.payloadHash = hashPayoutPayload({
      escrowId: tampered.escrowId,
      orderId: tampered.orderId,
      kind: tampered.kind,
      amountKobo: tampered.amountKobo
    });
    await expect(claimPayoutAttempt(repo, tampered)).rejects.toThrowError(ConflictException);
    expect(await repo.all()).toHaveLength(1);
  });

  it('different keys for release vs refund of the same escrow coexist', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    await claimPayoutAttempt(repo, attempt());
    const refund = attempt({
      id: 'payout-6',
      kind: 'refund',
      idempotencyKey: 'escrow-payout:refund:escrow-1'
    });
    refund.payloadHash = hashPayoutPayload({
      escrowId: refund.escrowId,
      orderId: refund.orderId,
      kind: refund.kind,
      amountKobo: refund.amountKobo
    });
    await claimPayoutAttempt(repo, refund);
    expect(await repo.all()).toHaveLength(2);
  });
});

describe('finalizePayoutAttempt guarded writes (Stage 24, audit A4-3)', () => {
  it('only the claim holder can finalize (claimedAt pinned in the CAS)', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const claim = await claimPayoutAttempt(repo, attempt());
    const staleClaim = { ...claim.attempt, claimedAt: '2020-01-01T00:00:00.000Z' };
    await expect(
      finalizePayoutAttempt(repo, staleClaim, { status: 'failed', failureReason: 'bogus' })
    ).rejects.toThrowError(ConflictException);
    expect((await repo.all())[0].status).toBe('in_progress');
  });

  it('succeeded never regresses: a late failure finalize adopts the succeeded row', async () => {
    const repo = createInMemoryEscrowPayoutRepository();
    const claim = await claimPayoutAttempt(repo, attempt());
    await finalizePayoutAttempt(repo, claim.attempt, {
      status: 'succeeded',
      providerReference: 'psp-ref-2'
    });
    // A stale writer's failure finalize must NOT overwrite the success.
    const adopted = await finalizePayoutAttempt(repo, claim.attempt, {
      status: 'failed',
      failureReason: 'late ambiguous timeout'
    });
    expect(adopted.status).toBe('succeeded');
    const stored = (await repo.all())[0];
    expect(stored.status).toBe('succeeded');
    expect(stored.providerReference).toBe('psp-ref-2');
  });
});
