import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { EscrowRecord, EscrowStatus, LedgerJournalEntry } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import {
  ESCROW_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { LedgerEntryRepository } from '../../database/repositories/ledger.repository.js';
import {
  ESCROW_HOLDS_LIABILITY_ACCOUNT,
  ESCROW_LEDGER_REFERENCE_TYPES,
  ESCROW_OPEN_STATUSES,
  ESCROW_PROVIDER_FLOAT_ACCOUNT,
  escrowHoldLedgerKey,
  escrowLegPostingInput,
  escrowMoneyOutLedgerKey,
  type EscrowLedgerLeg
} from '../marketplace/escrow-ledger.js';
import { LedgerService } from './ledger.service.js';

/** One detected escrow↔ledger divergence. */
export interface EscrowReconciliationDrift {
  escrowId: string;
  orderId?: string;
  status?: EscrowStatus;
  amountKobo?: number;
  issue:
    | 'missing_hold_leg'
    | 'missing_settlement_leg'
    | 'leg_amount_mismatch'
    | 'orphan_ledger_entry';
  detail: string;
  /** True when this run repaired the drift (missing-leg postings only). */
  repaired: boolean;
}

export interface EscrowReconciliationReport {
  checkedAt: string;
  checkedEscrows: number;
  /** Σ amount_kobo of escrows in open states (held/releasing/refunding/disputed). */
  openHoldsKobo: number;
  /** Outstanding holds liability (credits − debits of the liability account). */
  holdsLiabilityKobo: number;
  /** Provider float balance (debits − credits of the float account). */
  providerFloatKobo: number;
  drift: EscrowReconciliationDrift[];
  /** Drift items this run repaired by posting the missing leg. */
  repairedCount: number;
  /** True when no unrepaired drift remains AND the aggregates match. */
  balanced: boolean;
}

/**
 * Ledger reconciliation (Stage 27, WP-G13 ledger hardening).
 *
 * Two drift detectors, both fail-visible (telemetry metric + audit row) and
 * safe to run at any time:
 *
 *  1. findUnbalancedEntries — the pg-level proof that the WP-G13
 *     in-transaction assertion works: it lists committed transfers failing
 *     finance.transfer_is_balanced() (or with <2 postings). Empty when every
 *     writer posts through the guarded path; non-empty means an unguarded
 *     writer bypassed it.
 *
 *  2. reconcileEscrow — escrow Σ vs the ledger liability account. Every
 *     escrow must have its hold leg (`escrow-ledger:hold:<id>`); terminal
 *     escrows their settlement leg (`escrow-ledger:released|refunded:<id>`).
 *     With repair=true, missing legs are posted (idempotency-keyed — never
 *     double-posts) so legacy pre-WP-G13 escrows backfill on the first sweep.
 *     Amount mismatches and orphan ledger entries are ALERT-ONLY (moving
 *     money back needs a human decision). The aggregate invariant: Σ open
 *     escrow kobo === outstanding holds liability === provider float.
 *
 * Scheduler wiring is out of scope (WP-G12 owns schedulers); the admin
 * endpoints under /finance/ledger/reconciliation/* drive this on demand.
 */
@Injectable()
export class LedgerReconciliationService {
  private readonly logger = new Logger(LedgerReconciliationService.name);
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly ledger: LedgerService,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly entries: LedgerEntryRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Optional() private readonly audit?: AuditService,
    @Optional() telemetry?: TelemetryService
  ) {
    // No-op-safe fallback for direct construction (unit tests), same pattern
    // as DomainEventsService / the TigerBeetle driver.
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /** Committed transfers violating the balance invariant (must be empty). */
  async findUnbalancedEntries(): Promise<LedgerJournalEntry[]> {
    const unbalanced = await this.entries.findUnbalancedEntries();
    if (unbalanced.length > 0) {
      this.telemetry.increment('finance.ledger.unbalanced_transfers', unbalanced.length);
      await this.audit?.record({
        actorId: 'system',
        action: 'finance.ledger.unbalanced_detected',
        entityType: 'ledger_journal_entry',
        entityId: unbalanced[0].id,
        metadata: {
          count: unbalanced.length,
          entryIds: unbalanced.map((entry) => entry.id).slice(0, 50)
        }
      });
    }
    return unbalanced;
  }

  /**
   * Escrow Σ vs ledger liability reconciliation. With repair=true, posts
   * missing legs (idempotent); mismatch/orphan drift is alert-only.
   */
  async reconcileEscrow(options?: { repair?: boolean }): Promise<EscrowReconciliationReport> {
    const repair = options?.repair === true;
    const escrows = await this.escrows.find({});
    const drift: EscrowReconciliationDrift[] = [];
    let repairedCount = 0;
    for (const record of escrows) {
      const holdRepaired = await this.checkLeg(record, 'hold', repair, drift);
      if (holdRepaired) repairedCount += 1;
      if (record.status === 'released' || record.status === 'refunded') {
        const settlementRepaired = await this.checkLeg(record, record.status, repair, drift);
        if (settlementRepaired) repairedCount += 1;
      }
    }
    // Orphan alert: an escrow ledger entry whose escrow no longer exists.
    const escrowIds = new Set(escrows.map((record) => record.id));
    for (const referenceType of Object.values(ESCROW_LEDGER_REFERENCE_TYPES)) {
      for (const entry of await this.ledger.listEntries({ referenceType })) {
        if (entry.referenceId && !escrowIds.has(entry.referenceId)) {
          drift.push({
            escrowId: entry.referenceId,
            issue: 'orphan_ledger_entry',
            detail:
              `Ledger entry '${entry.id}' (${referenceType}) references escrow ` +
              `'${entry.referenceId}' which has no escrow record — alert only, never auto-repaired`,
            repaired: false
          });
        }
      }
    }
    // Aggregate invariant after any repairs: open holds == liability == float.
    const openHoldsKobo = escrows
      .filter((record) =>
        (ESCROW_OPEN_STATUSES as readonly string[]).includes(record.status)
      )
      .reduce((sum, record) => sum + record.amountKobo, 0);
    const holdsLiabilityKobo = 0 - (await this.balanceOrZero(ESCROW_HOLDS_LIABILITY_ACCOUNT));
    const providerFloatKobo = await this.balanceOrZero(ESCROW_PROVIDER_FLOAT_ACCOUNT);
    if (holdsLiabilityKobo !== openHoldsKobo || providerFloatKobo !== openHoldsKobo) {
      drift.push({
        escrowId: '(aggregate)',
        issue: 'leg_amount_mismatch',
        detail:
          `Aggregate divergence: open escrow Σ ${openHoldsKobo} kobo vs holds liability ` +
          `${holdsLiabilityKobo} kobo vs provider float ${providerFloatKobo} kobo`,
        repaired: false
      });
    }
    const unrepaired = drift.filter((item) => !item.repaired);
    const balanced = unrepaired.length === 0;
    if (!balanced) {
      this.logger.warn(
        `escrow reconciliation drift: ${unrepaired.length} unresolved item(s) over ${escrows.length} escrows`
      );
      this.telemetry.increment('finance.ledger.escrow_reconciliation.drift', unrepaired.length);
      await this.audit?.record({
        actorId: 'system',
        action: 'finance.ledger.escrow_reconciliation.drift',
        entityType: 'escrow_record',
        entityId: unrepaired[0].escrowId,
        metadata: {
          driftCount: unrepaired.length,
          issues: unrepaired.map((item) => item.issue).slice(0, 50),
          openHoldsKobo,
          holdsLiabilityKobo,
          providerFloatKobo
        }
      });
    }
    return {
      checkedAt: new Date().toISOString(),
      checkedEscrows: escrows.length,
      openHoldsKobo,
      holdsLiabilityKobo,
      providerFloatKobo,
      drift,
      repairedCount,
      balanced
    };
  }

  /**
   * Verifies one escrow leg exists with the escrow's amount; optionally
   * posts it when missing (repair). Returns true when this call repaired.
   */
  private async checkLeg(
    record: EscrowRecord,
    leg: EscrowLedgerLeg,
    repair: boolean,
    drift: EscrowReconciliationDrift[]
  ): Promise<boolean> {
    const key =
      leg === 'hold'
        ? escrowHoldLedgerKey(record.orderId) // hold legs are order-keyed (V-49)
        : escrowMoneyOutLedgerKey(leg, record.id);
    const entry = await this.ledger.findEntryByIdempotencyKey(key);
    if (!entry) {
      if (!repair) {
        drift.push({
          escrowId: record.id,
          orderId: record.orderId,
          status: record.status,
          amountKobo: record.amountKobo,
          issue: leg === 'hold' ? 'missing_hold_leg' : 'missing_settlement_leg',
          detail: `Escrow '${record.id}' (${record.status}) has no '${leg}' ledger leg (${key})`,
          repaired: false
        });
        return false;
      }
      await this.postMissingLeg(record, leg);
      drift.push({
        escrowId: record.id,
        orderId: record.orderId,
        status: record.status,
        amountKobo: record.amountKobo,
        issue: leg === 'hold' ? 'missing_hold_leg' : 'missing_settlement_leg',
        detail: `Escrow '${record.id}' (${record.status}) was missing its '${leg}' leg — posted (${key})`,
        repaired: true
      });
      return true;
    }
    const postedTotal = entry.postings.reduce((sum, posting) => sum + posting.amountKobo, 0) / 2;
    if (postedTotal !== record.amountKobo) {
      drift.push({
        escrowId: record.id,
        orderId: record.orderId,
        status: record.status,
        amountKobo: record.amountKobo,
        issue: 'leg_amount_mismatch',
        detail:
          `Escrow '${record.id}' ${leg} leg posted ${postedTotal} kobo but the record holds ` +
          `${record.amountKobo} kobo — alert only, never auto-repaired`,
        repaired: false
      });
    }
    return false;
  }

  /** Repair leg posting: the accounts exist by now or are ensured here. */
  private async postMissingLeg(record: EscrowRecord, leg: EscrowLedgerLeg): Promise<void> {
    await this.ledger.ensureAccount({ code: ESCROW_PROVIDER_FLOAT_ACCOUNT, type: 'asset' });
    await this.ledger.ensureAccount({ code: ESCROW_HOLDS_LIABILITY_ACCOUNT, type: 'liability' });
    await this.ledger.postEntry(escrowLegPostingInput(record, leg), 'system');
  }

  /** Balance of an account that may not exist yet (no legs posted → zero). */
  private async balanceOrZero(accountCode: string): Promise<number> {
    try {
      return (await this.ledger.balance(accountCode)).balanceKobo;
    } catch (error) {
      if (error instanceof NotFoundException) {
        return 0;
      }
      throw error;
    }
  }
}
