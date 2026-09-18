import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import {
  WAREHOUSE_BOND_CASH_ACCOUNT,
  warehouseFraudCompensationAccountCode,
  warehouseOperatorBondAccountCode
} from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { CERTIFIED_WAREHOUSE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { CertifiedWarehouseRepository } from '../../database/repositories/warehouse.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { WarehouseService } from './warehouse.service.js';

type Actor = Pick<User, 'id' | 'roles'>;

/** V-39: one receipt write-down adjudicated under an operator fraud case. */
export interface FraudCaseWriteDown {
  receiptId: string;
  lostWeightKg?: number;
  lostBagCount?: number;
}

/**
 * V-39: warehouse-operator bond ledger (operator fraud remedy).
 *
 * Warehouse-operator certification was status-only: fraud (phantom receipts,
 * short-weighted stock) was detectable via signed receipts + the audit
 * export but unresolvable in-platform — no operator liability account
 * existed. This service models the operator's performance bond as finance
 * ledger accounts:
 *
 *   post bond:   DR platform:cash (asset — bond cash received)
 *                CR warehouse:<id>:operator_bond (liability — owed back)
 *   fraud draw:  DR warehouse:<id>:operator_bond (liability reduced)
 *                CR warehouse:<id>:fraud_compensation_payable (liability —
 *                owed to the defrauded receipt holders)
 *
 * Both legs are balanced and idempotency-keyed (entity-derived), so retries
 * converge instead of double-posting or double-drawing. The draw is capped
 * at the posted-but-undrawn bond balance — fail closed when the bond does
 * not cover the adjudicated compensation.
 *
 * EXTERNAL GATE (E-08): the REAL bond/insurance instrument is a legal
 * contract with the warehouse operator, arranged off-platform. These
 * accounts only model the in-platform recourse once that instrument exists;
 * nothing here creates a legal obligation by itself.
 */
@Injectable()
export class WarehouseBondService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly ledger: LedgerService,
    @Inject(CERTIFIED_WAREHOUSE_REPOSITORY)
    private readonly warehouses: CertifiedWarehouseRepository,
    private readonly warehouse: WarehouseService,
    @Optional() private readonly audit?: AuditService
  ) {}

  /**
   * Posts (or tops up) an operator's performance bond. Idempotent per
   * warehouse: a replay adopts the existing journal instead of
   * double-posting the bond. Admin only.
   */
  async postBond(warehouseId: string, amountKobo: number, actor: Actor) {
    if (!actor.roles.includes('admin')) {
      throw new ForbiddenException('Only an administrator may post an operator bond');
    }
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      throw new BadRequestException('amountKobo must be a positive integer (kobo)');
    }
    await this.warehouses.getById(warehouseId); // 404 on unknown warehouse
    const idempotencyKey = `warehouse-bond:post:${warehouseId}`;
    const existing = await this.ledger.findEntryByIdempotencyKey(idempotencyKey);
    if (existing) {
      return existing; // idempotent replay
    }
    await this.ledger.ensureAccount({ code: WAREHOUSE_BOND_CASH_ACCOUNT, type: 'asset' });
    await this.ledger.ensureAccount({
      code: warehouseOperatorBondAccountCode(warehouseId),
      type: 'liability'
    });
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey,
        referenceType: 'warehouse_operator_bond_post',
        referenceId: warehouseId,
        description: `Operator bond posted for warehouse ${warehouseId} (${amountKobo} kobo)`,
        postings: [
          { accountCode: WAREHOUSE_BOND_CASH_ACCOUNT, direction: 'debit', amountKobo },
          {
            accountCode: warehouseOperatorBondAccountCode(warehouseId),
            direction: 'credit',
            amountKobo
          }
        ]
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.bond.posted',
      entityType: 'certified_warehouse',
      entityId: warehouseId,
      metadata: { amountKobo, ledgerEntryId: entry.id }
    });
    await this.events.publish(
      'warehouse.bond.posted',
      { warehouseId, amountKobo, ledgerEntryId: entry.id },
      actor.id
    );
    return entry;
  }

  /**
   * Resolves an operator fraud case: applies the adjudicated pro-rata
   * write-downs to the affected receipts (kind 'operator_fraud' — the V-07
   * loss machinery, which propagates the haircut to LTV positions and
   * claims) and draws the operator bond for the adjudicated compensation
   * with a balanced journal. Idempotent per (warehouse, caseId): a replay
   * adopts the existing draw journal; loss write-downs that already landed
   * surface as conflicts on replay, so the draw is applied BEFORE the
   * write-downs and write-down failures after a successful draw are left
   * for honest retry/reconciliation (the journal key proves the draw).
   *
   * Fail closed: the draw never exceeds the available (posted minus drawn)
   * bond balance.
   */
  async resolveFraudCase(
    warehouseId: string,
    input: { caseId: string; compensationKobo: number; writeDowns: FraudCaseWriteDown[] },
    actor: Actor
  ) {
    if (!actor.roles.includes('admin')) {
      throw new ForbiddenException('Only an administrator may resolve an operator fraud case');
    }
    if (!input.caseId?.trim()) {
      throw new BadRequestException('caseId is required (the fraud-case reference)');
    }
    if (!Number.isSafeInteger(input.compensationKobo) || input.compensationKobo <= 0) {
      throw new BadRequestException('compensationKobo must be a positive integer (kobo)');
    }
    await this.warehouses.getById(warehouseId);
    const bondAccount = warehouseOperatorBondAccountCode(warehouseId);
    const drawKey = `warehouse-bond:draw:${warehouseId}:${input.caseId}`;
    let draw = await this.ledger.findEntryByIdempotencyKey(drawKey);
    if (!draw) {
      let availableKobo: number;
      try {
        // Liability account: credit-positive; balanceKobo is debit-positive.
        availableKobo = -(await this.ledger.balance(bondAccount)).balanceKobo;
      } catch {
        availableKobo = 0; // no bond account at all — nothing to draw
      }
      if (input.compensationKobo > availableKobo) {
        throw new ConflictException(
          `Operator bond for warehouse ${warehouseId} covers ${availableKobo} kobo but the ` +
            `adjudicated compensation is ${input.compensationKobo} kobo; refusing the draw ` +
            '(fail closed — the shortfall needs the external bond/insurance instrument, E-08)'
        );
      }
      await this.ledger.ensureAccount({
        code: warehouseFraudCompensationAccountCode(warehouseId),
        type: 'liability'
      });
      draw = await this.ledger.postEntry(
        {
          idempotencyKey: drawKey,
          referenceType: 'warehouse_operator_bond_draw',
          referenceId: `${warehouseId}:${input.caseId}`,
          description:
            `Operator bond draw for fraud case ${input.caseId} on warehouse ${warehouseId} ` +
            `(${input.compensationKobo} kobo to receipt-holder compensation)`,
          postings: [
            { accountCode: bondAccount, direction: 'debit', amountKobo: input.compensationKobo },
            {
              accountCode: warehouseFraudCompensationAccountCode(warehouseId),
              direction: 'credit',
              amountKobo: input.compensationKobo
            }
          ]
        },
        actor.id
      );
      await this.events.publish(
        'warehouse.bond.drawn',
        {
          warehouseId,
          caseId: input.caseId,
          compensationKobo: input.compensationKobo,
          ledgerEntryId: draw.id
        },
        actor.id
      );
    }
    // Pro-rata write-downs on the affected receipts (V-07 machinery).
    for (const writeDown of input.writeDowns) {
      try {
        await this.warehouse.reportLoss(
          writeDown.receiptId,
          {
            kind: 'operator_fraud',
            lostWeightKg: writeDown.lostWeightKg,
            lostBagCount: writeDown.lostBagCount,
            reason: `operator fraud case ${input.caseId}`
          },
          actor
        );
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof BadRequestException)) {
          throw error;
        }
        // Already applied (replay) or independently reconciled — the bond
        // draw above is the money-critical step and is already idempotent.
      }
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.bond.fraud_case_resolved',
      entityType: 'certified_warehouse',
      entityId: warehouseId,
      metadata: {
        caseId: input.caseId,
        compensationKobo: input.compensationKobo,
        ledgerEntryId: draw.id,
        writeDowns: input.writeDowns
      }
    });
    return draw;
  }
}
