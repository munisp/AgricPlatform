import { ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { EscrowRecord } from '@agric-platform/shared';
import { EventDedupService } from '../../core/event-dedup.service.js';
import {
  ESCROW_PAYOUT_REPOSITORY,
  ESCROW_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import {
  PAYOUT_CLAIM_LEASE_MS,
  type EscrowPayoutRepository
} from '../../database/repositories/payout.repository.js';
import { EscrowService } from '../marketplace/escrow.service.js';

/**
 * Exactly-once sweep marker consumer (events.processed_events, targetless
 * ON CONFLICT DO NOTHING underneath): one row per escrow that this sweeper
 * drove to a terminal state. Marked AFTER the terminal write so a crash
 * mid-pass simply reprocesses — the guarded transitions underneath are
 * replay-safe, so a double-run is always a no-op.
 */
export const ESCROW_EXPIRY_SWEEPER_CONSUMER = 'sweeper:escrow-expiry';

/** Default batch cap per sweep pass. */
export const ESCROW_EXPIRY_SWEEP_BATCH = 100;

/**
 * A pending release/refund ('releasing'/'refunding') whose payout attempt
 * has not moved for TWO claim leases is stuck: a live drive revalidates and
 * finalizes well inside one lease (PAYOUT_CLAIM_LEASE_MS).
 */
export const ESCROW_PENDING_STUCK_MS = 2 * PAYOUT_CLAIM_LEASE_MS;

export interface EscrowExpirySweepResult {
  /** Candidate rows evaluated this pass (expired holds + stuck pendings). */
  scanned: number;
  /** Held escrows auto-refunded through the payout rail. */
  refunded: number;
  /** Stuck pending releases/refunds resumed to a terminal state. */
  resumed: number;
  /** Rows already swept in an earlier pass (exactly-once marker). */
  skippedMarked: number;
  /** Rows lost to a concurrent transition (CAS loser backs off). */
  conflicts: number;
  /** Rows whose drive failed (provider/rail error) — retried next pass. */
  failed: number;
}

/**
 * Escrow expiry sweeper (WP-G12). One pass, two selection legs:
 *   A. expiry — held escrows past their heldUntil deadline, batch-selected
 *      FOR UPDATE SKIP LOCKED on pg (concurrent passes never block on rows
 *      locked by an in-flight transition), oldest first;
 *   B. stuck pendings — 'releasing'/'refunding' escrows whose recorded
 *      payout attempt has not moved within ESCROW_PENDING_STUCK_MS (the
 *      attempt row is the drive clock; a crashed claimant's attempt stops
 *      moving). Pending states can be entered long before the hold deadline
 *      (manual cancel/refund), so leg B is independent of heldUntil.
 *
 * Every row is driven through the EXISTING escrow service semantics: held →
 * refund (reversal of the hold through the recorded payout rail), stuck
 * pending → resume the pending transition. Compensating money movement stays
 * inside EscrowService's balanced, idempotency-keyed machinery — nothing is
 * inserted raw here. Every state write is the repository CAS, so a race
 * loser backs off with a conflict and the winner's outcome stands; the
 * per-escrow marker is recorded only after a terminal state is reached.
 *
 * 'disputed' escrows are NEVER touched — they await the admin-mediated
 * resolution path. Unverified holds under a wired provider keep the Stage 24
 * verify-before-credit gate: the service refuses the refund with a
 * conflict (audited), the sweeper counts it and moves on.
 */
@Injectable()
export class EscrowExpirySweeperService {
  private readonly logger = new Logger(EscrowExpirySweeperService.name);

  constructor(
    private readonly escrow: EscrowService,
    private readonly dedup: EventDedupService,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Optional() @Inject(ESCROW_PAYOUT_REPOSITORY) private readonly payouts?: EscrowPayoutRepository
  ) {}

  /** Leg A: expired holds (pg SKIP LOCKED batch when available). */
  private async selectExpired(nowIso: string, limit: number): Promise<EscrowRecord[]> {
    if (this.escrows.findExpiredForSweep) {
      return this.escrows.findExpiredForSweep(nowIso, limit);
    }
    return (await this.escrows.find({ status: 'held' }))
      .filter((record) => record.heldUntil !== undefined && record.heldUntil <= nowIso)
      .sort((a, b) => (a.heldUntil ?? '').localeCompare(b.heldUntil ?? ''))
      .slice(0, Math.max(0, limit));
  }

  /**
   * Leg B: pending releases/refunds whose drive has provably stopped. The
   * payout attempt's updatedAt is the clock — it moves on every claim,
   * revalidation and finalize, so a live drive never looks stuck.
   */
  private async selectStuckPendings(now: Date): Promise<EscrowRecord[]> {
    const pendings = [
      ...(await this.escrows.find({ status: 'releasing' })),
      ...(await this.escrows.find({ status: 'refunding' }))
    ];
    const stuckBeforeMs = now.getTime() - ESCROW_PENDING_STUCK_MS;
    const stuck: EscrowRecord[] = [];
    for (const record of pendings) {
      const kind = record.status === 'releasing' ? 'release' : 'refund';
      const attempts = this.payouts ? await this.payouts.find({ escrowId: record.id }) : [];
      const attempt = attempts.find((candidate) => candidate.kind === kind);
      if (attempt) {
        if (Date.parse(attempt.updatedAt) <= stuckBeforeMs) {
          stuck.push(record);
        }
        continue;
      }
      // No recorded attempt (legacy/provider-backed path): fall back to the
      // hold deadline as the only available clock.
      if (record.heldUntil && Date.parse(record.heldUntil) <= stuckBeforeMs) {
        stuck.push(record);
      }
    }
    return stuck;
  }

  async sweep(
    now: Date = new Date(),
    batchSize: number = ESCROW_EXPIRY_SWEEP_BATCH
  ): Promise<EscrowExpirySweepResult> {
    const result: EscrowExpirySweepResult = {
      scanned: 0,
      refunded: 0,
      resumed: 0,
      skippedMarked: 0,
      conflicts: 0,
      failed: 0
    };
    const seen = new Set<string>();
    const batch = [
      ...(await this.selectExpired(now.toISOString(), batchSize)),
      ...(await this.selectStuckPendings(now))
    ].filter((record) => {
      if (seen.has(record.id)) {
        return false;
      }
      seen.add(record.id);
      return true;
    });
    result.scanned = batch.length;
    for (const record of batch) {
      if (await this.dedup.has(ESCROW_EXPIRY_SWEEPER_CONSUMER, record.id)) {
        result.skippedMarked += 1;
        continue;
      }
      try {
        const outcome =
          record.status === 'releasing'
            ? await this.escrow.releaseForOrder(record.orderId, 'system')
            : await this.escrow.refundForOrder(record.orderId, 'system');
        if (outcome && (outcome.status === 'released' || outcome.status === 'refunded')) {
          await this.dedup.mark(ESCROW_EXPIRY_SWEEPER_CONSUMER, record.id);
          if (record.status === 'held') {
            result.refunded += 1;
          } else {
            result.resumed += 1;
          }
        }
        // A non-terminal outcome (verify gate, dispute freeze) stays
        // unmarked so a later pass re-evaluates it.
      } catch (error) {
        if (error instanceof ConflictException) {
          // CAS loser: a concurrent transition won — back off; the row is no
          // longer ours to move this pass.
          result.conflicts += 1;
          continue;
        }
        result.failed += 1;
        this.logger.warn(
          `escrow expiry sweep failed for ${record.id} (status ${record.status}): ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return result;
  }
}
