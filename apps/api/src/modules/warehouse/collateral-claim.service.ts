import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { effectiveReceiptWeightKg } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  COLLATERAL_POSITION_REPOSITORY,
  WAREHOUSE_PLEDGE_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  WarehousePledgeRepository,
  WarehouseReceiptRepository
} from '../../database/repositories/warehouse.repository.js';
import type { CollateralPositionRepository } from '../../database/repositories/warehouse-ltv.repository.js';
import { LIVE_POSITION_STATUSES } from '../../database/repositories/warehouse-ltv.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { WarehouseService } from './warehouse.service.js';

/**
 * V-31 (WAREHOUSE HALF ONLY): subscription side of the
 * `credit.collateral.claimed` contract.
 *
 * Event contract (emitted by the credit pack's claimCollateral; the credit
 * files are owned by the credit pack and are NOT touched here):
 *   payload: {
 *     collateralId: string;          // credit-side collateral row id
 *     loanId: string;                // the defaulted loan
 *     to: string;                    // claim instruction (credit-side)
 *     receiptId?: string;            // receipt backing the collateral
 *     pledgeId?: string;             // warehouse pledge row id
 *   }
 * The pledge/receipt refs are preferred; when absent the handler falls back
 * to the warehouse collateral POSITION keyed by loanId.
 *
 * On a claim of a receipt-backed collateral the warehouse drives the
 * liquidation path:
 *   1. the lien is released through the collateral-registry driver (fail
 *      closed, same rail as borrower releases),
 *   2. the live collateral position closes as 'liquidated',
 *   3. a BALANCED settlement journal posts — the lender books the seized
 *      collateral claim, the borrower books the collateral write-off —
 *      idempotency-keyed per collateralId so retries converge,
 *   4. V-07 haircut: a receipt with recorded spoilage/condition loss
 *      settles at principal × effective/original weight — destroyed grain
 *      is never claimed at full value.
 */
@Injectable()
export class WarehouseCollateralClaimService implements OnModuleInit {
  private readonly logger = new Logger(WarehouseCollateralClaimService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly ledger: LedgerService,
    private readonly warehouse: WarehouseService,
    @Inject(WAREHOUSE_RECEIPT_REPOSITORY)
    private readonly receipts: WarehouseReceiptRepository,
    @Inject(WAREHOUSE_PLEDGE_REPOSITORY)
    private readonly pledges: WarehousePledgeRepository,
    @Inject(COLLATERAL_POSITION_REPOSITORY)
    private readonly positions: CollateralPositionRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  onModuleInit(): void {
    this.events.on('credit.collateral.claimed', (event) => {
      void this.handleCollateralClaimed(
        event.payload as CollateralClaimedPayload,
        event.actorId
      ).catch((error: unknown) => {
        // Best-effort listener, same doctrine as the offtake escrow hook:
        // the failure is logged for reconciliation, never thrown back into
        // the fan-out. The settlement is re-drivable (idempotency-keyed).
        this.logger.error(
          `warehouse collateral claim handling failed (event ${event.id}): ` +
            `${(error as Error)?.message ?? error}`
        );
      });
    });
  }

  /**
   * Drives the warehouse half of a collateral claim. Idempotent: a replay
   * (duplicate event delivery) finds the pledge already released and the
   * journal already posted, and converges without double-settling.
   */
  async handleCollateralClaimed(
    payload: CollateralClaimedPayload,
    actorId?: string
  ): Promise<{ handled: boolean; receiptId?: string; settlementKobo?: number }> {
    if (!payload || typeof payload !== 'object') {
      return { handled: false };
    }
    const receiptId = await this.resolveReceiptId(payload);
    if (!receiptId) {
      return { handled: false }; // not receipt-backed collateral — not ours
    }
    const receipt = await this.receipts.getById(receiptId);
    const active = (await this.pledges.find({ receiptId, status: 'active' }))[0];
    const settlementKobo = this.haircutSettlementKobo(receipt, active?.principalKobo);

    if (active) {
      // Release the lien through the fail-closed registry rail (system
      // actor; a lender seizure is registry-driven, not owner-driven).
      await this.warehouse.releasePledge(receiptId, {
        id: actorId ?? 'system',
        roles: ['admin']
      });
    }
    // Close the live position as liquidated (CAS; replay-safe).
    for (const status of LIVE_POSITION_STATUSES) {
      const position = (
        await this.positions.find({ receiptId, status })
      )[0];
      if (position) {
        try {
          await this.positions.updateExpected(
            position.id,
            { status: 'liquidated', updatedAt: new Date().toISOString() },
            { status: position.status }
          );
        } catch {
          /* concurrent close — converge */
        }
      }
    }
    // Balanced settlement legs (idempotency-keyed per collateral).
    if (active && settlementKobo > 0) {
      const key = `whr-collateral-claim:${payload.collateralId ?? active.id}`;
      const existing = await this.ledger.findEntryByIdempotencyKey(key);
      if (!existing) {
        const lenderAccount = `member:${active.lenderId}:whr_claims_receivable`;
        const borrowerAccount = `member:${receipt.ownerId}:whr_collateral_settlement`;
        await this.ledger.ensureAccount({ code: lenderAccount, type: 'asset' });
        await this.ledger.ensureAccount({ code: borrowerAccount, type: 'liability' });
        await this.ledger.postEntry(
          {
            idempotencyKey: key,
            referenceType: 'warehouse_collateral_claim_settlement',
            referenceId: receiptId,
            description:
              `Collateral claim settlement on receipt ${receiptId} ` +
              `(loan ${payload.loanId ?? 'n/a'}): lender books the seized claim, ` +
              `borrower writes off the collateral — ${settlementKobo} kobo after loss haircut`,
            postings: [
              { accountCode: lenderAccount, direction: 'debit', amountKobo: settlementKobo },
              { accountCode: borrowerAccount, direction: 'credit', amountKobo: settlementKobo }
            ]
          },
          actorId ?? 'system'
        );
      }
    }
    await this.audit?.record({
      actorId: actorId ?? 'system',
      action: 'warehouse.collateral.claim_settled',
      entityType: 'warehouse_receipt',
      entityId: receiptId,
      metadata: {
        collateralId: payload.collateralId,
        loanId: payload.loanId,
        pledgeId: active?.id,
        settlementKobo
      }
    });
    return { handled: true, receiptId, settlementKobo };
  }

  private async resolveReceiptId(payload: CollateralClaimedPayload): Promise<string | undefined> {
    // The credit pack emits warehouseReceiptId/warehousePledgeId; accept both
    // namings (and the shorthand) so the contract is tolerant at the seam.
    const receiptRef = payload.receiptId ?? payload.warehouseReceiptId;
    if (receiptRef) {
      return receiptRef;
    }
    const pledgeRef = payload.pledgeId ?? payload.warehousePledgeId;
    if (pledgeRef) {
      const pledge = await this.pledges.getById(pledgeRef);
      return pledge.receiptId;
    }
    if (payload.loanId) {
      for (const status of LIVE_POSITION_STATUSES) {
        const position = (
          await this.positions.find({ loanId: payload.loanId, status })
        )[0];
        if (position) {
          return position.receiptId;
        }
      }
    }
    return undefined;
  }

  /**
   * V-07 haircut on claim: a spoiled/written-down receipt settles at
   * principal × (effective / signed weight), floor-truncated to integer
   * kobo — destroyed grain is never claimed at full value.
   */
  private haircutSettlementKobo(
    receipt: { weightKg: number; lostWeightKg?: number },
    principalKobo: number | undefined
  ): number {
    if (principalKobo === undefined || receipt.weightKg <= 0) {
      return 0;
    }
    const effective = Math.max(0, effectiveReceiptWeightKg(receipt));
    return Math.floor((principalKobo * effective) / receipt.weightKg);
  }
}

/** The credit pack's `credit.collateral.claimed` payload contract. */
export interface CollateralClaimedPayload {
  collateralId?: string;
  loanId?: string;
  to?: string;
  receiptId?: string;
  pledgeId?: string;
  /** Credit pack's emitted field names (credit.service.ts claimCollateral). */
  warehouseReceiptId?: string;
  warehousePledgeId?: string;
}
