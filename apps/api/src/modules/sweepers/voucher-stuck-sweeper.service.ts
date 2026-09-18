import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger
} from '@nestjs/common';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { INPUT_VOUCHER_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  InputVoucherRecord,
  InputVoucherRepository
} from '../../database/repositories/input-vouchers.repository.js';
import { InputVouchersService } from '../input-vouchers/input-vouchers.service.js';

/**
 * Exactly-once sweep marker consumer (events.processed_events, targetless
 * ON CONFLICT DO NOTHING underneath): one row per voucher this sweeper drove
 * to a TERMINAL state (EXPIRED/VOIDED/REDEEMED). A rollback to ISSUED is
 * deliberately NOT marked — the voucher is live again and a later pass must
 * be able to sweep it if it gets stuck once more.
 */
export const VOUCHER_STUCK_SWEEPER_CONSUMER = 'sweeper:voucher-stuck';

/** Default batch cap per sweep pass. */
export const VOUCHER_STUCK_SWEEP_BATCH = 100;

/** Default stuck TTL for pending claims (VOIDING/REDEEMING): one hour. */
export const VOUCHER_STUCK_TTL_MS = 60 * 60 * 1000;

export interface VoucherStuckSweepResult {
  /** Candidate rows selected this pass. */
  scanned: number;
  /** ISSUED past expiry (or stuck EXPIRING) driven to EXPIRED. */
  expired: number;
  /** Stuck VOIDING claims resumed to VOIDED. */
  voided: number;
  /** Stuck REDEEMING claims resumed to REDEEMED (posting had committed). */
  redeemed: number;
  /** Stuck REDEEMING claims rolled back to ISSUED (posting proven absent). */
  rolledBack: number;
  /** W2-C2 (V-02): stuck REFUNDING claims resumed to REFUNDED. */
  refunded: number;
  /** Rows already swept to a terminal state (exactly-once marker). */
  skippedMarked: number;
  /** Rows lost to a concurrent transition (CAS loser backs off). */
  conflicts: number;
  /** Rows whose recovery failed — retried next pass. */
  failed: number;
}

/**
 * Stuck-voucher sweeper (WP-G12). One pass over:
 *   - ISSUED vouchers past expiresAt → EXPIRED through the service's
 *     EXPIRING pending state (encumbrance release + float release, both
 *     idempotency/marker-keyed balanced postings inside the voucher service
 *     — nothing is posted raw here);
 *   - EXPIRING past expiry → resume the same path (a crash between the CAS
 *     and the release left the claim pending);
 *   - VOIDING untouched since the stuck TTL → resume to VOIDED;
 *   - REDEEMING untouched since the stuck TTL → recover: finalize REDEEMED
 *     when the redemption posting committed, roll back to ISSUED only with
 *     ledger proof of absence (stage 24 A4-1/A1-3 doctrine, inside
 *     InputVouchersService.recoverStuckRedemption).
 *
 * Batch selection is FOR UPDATE SKIP LOCKED on pg; every state write is the
 * repository CAS, so concurrent sweepers/party actions lose cleanly (counted
 * as conflicts) and a double-run of the sweep is a no-op.
 */
@Injectable()
export class VoucherStuckSweeperService {
  private readonly logger = new Logger(VoucherStuckSweeperService.name);

  constructor(
    private readonly vouchers: InputVouchersService,
    private readonly dedup: EventDedupService,
    @Inject(INPUT_VOUCHER_REPOSITORY) private readonly voucherRepo: InputVoucherRepository
  ) {}

  /** Batch selection: pg SKIP LOCKED when available, filtered scan otherwise. */
  private async selectBatch(
    nowIso: string,
    stuckBeforeIso: string,
    limit: number
  ): Promise<InputVoucherRecord[]> {
    if (this.voucherRepo.findSweepCandidates) {
      return this.voucherRepo.findSweepCandidates({ nowIso, stuckBeforeIso, limit });
    }
    const due: InputVoucherRecord[] = [];
    for (const status of ['ISSUED', 'EXPIRING', 'PARTIALLY_REDEEMED'] as const) {
      due.push(
        ...(await this.voucherRepo.find({ status })).filter((v) => v.expiresAt <= nowIso)
      );
    }
    for (const status of ['VOIDING', 'REDEEMING', 'REFUNDING'] as const) {
      due.push(
        ...(await this.voucherRepo.find({ status })).filter(
          (v) => (v.updatedAt ?? v.createdAt) <= stuckBeforeIso
        )
      );
    }
    return due
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(0, limit));
  }

  async sweep(
    now: Date = new Date(),
    options: { batchSize?: number; stuckTtlMs?: number } = {}
  ): Promise<VoucherStuckSweepResult> {
    const batchSize = options.batchSize ?? VOUCHER_STUCK_SWEEP_BATCH;
    const stuckTtlMs = options.stuckTtlMs ?? VOUCHER_STUCK_TTL_MS;
    const result: VoucherStuckSweepResult = {
      scanned: 0,
      expired: 0,
      voided: 0,
      redeemed: 0,
      rolledBack: 0,
      refunded: 0,
      skippedMarked: 0,
      conflicts: 0,
      failed: 0
    };
    const batch = await this.selectBatch(
      now.toISOString(),
      new Date(now.getTime() - stuckTtlMs).toISOString(),
      batchSize
    );
    result.scanned = batch.length;
    for (const voucher of batch) {
      if (await this.dedup.has(VOUCHER_STUCK_SWEEPER_CONSUMER, voucher.id)) {
        result.skippedMarked += 1;
        continue;
      }
      try {
        const terminal = await this.sweepOne(voucher);
        if (terminal) {
          await this.dedup.mark(VOUCHER_STUCK_SWEEPER_CONSUMER, voucher.id);
        }
        this.count(result, voucher.status, terminal);
      } catch (error) {
        if (error instanceof ConflictException || error instanceof BadRequestException) {
          // CAS loser (a concurrent redeem/expire/void won) or a voucher that
          // turned out not to be due after all — back off; next pass
          // re-evaluates.
          result.conflicts += 1;
          continue;
        }
        result.failed += 1;
        this.logger.warn(
          `voucher stuck sweep failed for ${voucher.id} (status ${voucher.status}): ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return result;
  }

  /** Drives one candidate; returns true only when a TERMINAL state was reached. */
  private async sweepOne(voucher: InputVoucherRecord): Promise<boolean> {
    switch (voucher.status) {
      case 'ISSUED':
      case 'EXPIRING':
      // W2-C2 (V-32): a partially redeemed voucher past expiry releases its
      // remaining balance through the same EXPIRING path.
      case 'PARTIALLY_REDEEMED':
        await this.vouchers.expireVoucher(voucher.id, 'system');
        return true;
      case 'VOIDING':
        await this.vouchers.voidVoucher(voucher.id, 'system');
        return true;
      case 'REFUNDING':
        // W2-C2 (V-02): resume a stuck refund — reason/complaintCaseId were
        // captured on the row by the claim CAS, and every posting replays.
        await this.vouchers.refundVoucher(voucher.id, 'system');
        return true;
      case 'REDEEMING': {
        const recovered = await this.vouchers.recoverStuckRedemption(voucher.id, 'system');
        // REDEEMED is terminal; a rollback to ISSUED is not (the voucher may
        // legitimately be swept again after a later claim).
        return recovered.status === 'REDEEMED';
      }
      default:
        return false;
    }
  }

  private count(
    result: VoucherStuckSweepResult,
    status: InputVoucherRecord['status'],
    terminal: boolean
  ): void {
    if (status === 'ISSUED' || status === 'EXPIRING' || status === 'PARTIALLY_REDEEMED') {
      result.expired += 1;
      return;
    }
    if (status === 'VOIDING') {
      result.voided += 1;
      return;
    }
    if (status === 'REFUNDING') {
      result.refunded += 1;
      return;
    }
    if (status === 'REDEEMING') {
      if (terminal) {
        result.redeemed += 1;
      } else {
        result.rolledBack += 1;
      }
    }
  }
}
