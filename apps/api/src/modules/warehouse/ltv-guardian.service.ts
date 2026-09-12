import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import type {
  CollateralPosition,
  CollateralPositionDetail,
  LoanApplication,
  LtvObservation,
  LtvPriceBasis,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  COLLATERAL_POSITION_REPOSITORY,
  LOAN_APPLICATION_REPOSITORY,
  LTV_OBSERVATION_REPOSITORY,
  WAREHOUSE_PLEDGE_REPOSITORY,
  WAREHOUSE_RECEIPT_REPOSITORY,
  COMMODITY_PRICE_PROVIDER
} from '../../database/persistence.tokens.js';
import type { LoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import type {
  CollateralPositionRepository,
  LtvObservationRepository
} from '../../database/repositories/warehouse-ltv.repository.js';
import { LIVE_POSITION_STATUSES } from '../../database/repositories/warehouse-ltv.repository.js';
import type {
  WarehousePledgeRepository,
  WarehouseReceiptRepository
} from '../../database/repositories/warehouse.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import type {
  CommodityPriceProvider,
  CommodityPriceQuote
} from '../integrations/drivers/commodity-price.provider.js';
import {
  classifyLtv,
  computeLtvBps,
  nairaPerTonneToKoboPerKg,
  BPS_DENOMINATOR
} from './ltv.js';

type Actor = Pick<User, 'id' | 'roles'>;

export interface AttachMonitorInput {
  loanId: string;
  pledgedQtyKg: number;
  commodity: string;
  haircutBps: number;
  ltvLimitBps: number;
  marginCallBps: number;
}

export type PositionEvaluationOutcome =
  | 'observed'
  | 'margin_call_raised'
  | 'cured'
  | 'unchanged'
  | 'unavailable';

export interface PositionEvaluationResult {
  positionId: string;
  outcome: PositionEvaluationOutcome;
  priceBasis: LtvPriceBasis | 'unavailable';
  ltvBps?: number;
}

export interface LtvRunSummary {
  evaluatedAt: string;
  evaluated: number;
  observed: number;
  unavailable: number;
  marginCallsRaised: number;
  cured: number;
  results: PositionEvaluationResult[];
}

function isIntInRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Receipt LTV Guardian (Stage 27 / Innovation 8, migration 066): live
 * collateral monitoring for warehouse-receipt-backed loans.
 *
 * Doctrine:
 *  - The outstanding balance is ALWAYS read from the finance ledger
 *    (position.ledgerAccountCode) at evaluation time — never copied.
 *  - Margin-call state changes are compare-and-set: a call is raised only
 *    from 'active' (exactly once per erosion episode) and cured only from
 *    'margin_call'; concurrent evaluation runs cannot double-raise.
 *  - Observations are append-only evidence; the repository port has no
 *    update/delete surface.
 *  - FAIL-CLOSED on price provenance: margin calls and cures are evaluated
 *    ONLY from 'live' prices. Stub/fixture quotes are recorded (basis
 *    honestly labelled) but never move state; a failed fetch records NO
 *    observation, flags the position priceStale for human review and emits
 *    warehouse.ltv_evaluations_total{basis=unavailable}.
 */
@Injectable()
export class LtvGuardianService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly ledger: LedgerService,
    private readonly telemetry: TelemetryService,
    @Inject(WAREHOUSE_RECEIPT_REPOSITORY)
    private readonly receipts: WarehouseReceiptRepository,
    @Inject(WAREHOUSE_PLEDGE_REPOSITORY)
    private readonly pledges: WarehousePledgeRepository,
    @Inject(COLLATERAL_POSITION_REPOSITORY)
    private readonly positions: CollateralPositionRepository,
    @Inject(LTV_OBSERVATION_REPOSITORY)
    private readonly observations: LtvObservationRepository,
    @Inject(LOAN_APPLICATION_REPOSITORY)
    private readonly loans: LoanApplicationRepository,
    @Inject(COMMODITY_PRICE_PROVIDER)
    private readonly prices: CommodityPriceProvider,
    @Optional() private readonly audit?: AuditService
  ) {}

  /* --------------------------------------------------------- attach ------- */

  /**
   * Attaches a pledged receipt to a loan as a monitored collateral position
   * (lender holding the active pledge, or admin). Fail-closed: the loan must
   * be disbursed/repaying with a readable ledger balance, the monitored
   * commodity must be the receipt's crop, and the pledged quantity cannot
   * exceed the receipt weight.
   */
  async attachMonitor(
    receiptId: string,
    input: AttachMonitorInput,
    actor: Actor
  ): Promise<CollateralPosition> {
    const receipt = await this.receipts.getById(receiptId);
    if (receipt.status !== 'pledged') {
      throw new BadRequestException(
        `Only a pledged receipt can be monitored as loan collateral (receipt is '${receipt.status}')`
      );
    }
    const pledge = (await this.pledges.find({ receiptId, status: 'active' }))[0];
    if (!pledge) {
      throw new BadRequestException('Receipt has no active pledge to monitor');
    }
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin && actor.id !== pledge.lenderId) {
      throw new ForbiddenException('Only the pledge-holding lender may monitor this receipt');
    }
    const loan = await this.loans.getById(input.loanId);
    if (loan.status !== 'disbursed' && loan.status !== 'repaying') {
      throw new BadRequestException(
        `Only disbursed or repaying loans can be collateral-monitored (loan is '${loan.status}')`
      );
    }
    if (loan.lenderId !== pledge.lenderId) {
      throw new BadRequestException('The loan lender does not match the pledge lender');
    }
    if (loan.applicantId !== pledge.borrowerId) {
      throw new BadRequestException('The loan applicant does not match the pledge borrower');
    }
    if (
      !input.commodity?.trim() ||
      input.commodity.trim().toLowerCase() !== receipt.crop.trim().toLowerCase()
    ) {
      throw new BadRequestException(
        `Monitored commodity must be the receipt crop '${receipt.crop}' — never price the wrong commodity`
      );
    }
    if (!Number.isFinite(input.pledgedQtyKg) || input.pledgedQtyKg <= 0) {
      throw new BadRequestException('pledgedQtyKg must be a positive number');
    }
    if (input.pledgedQtyKg > receipt.weightKg) {
      throw new BadRequestException(
        `pledgedQtyKg (${input.pledgedQtyKg}) exceeds the receipt weight (${receipt.weightKg} kg)`
      );
    }
    if (!isIntInRange(input.haircutBps, 0, BPS_DENOMINATOR - 1)) {
      throw new BadRequestException('haircutBps must be an integer between 0 and 9999');
    }
    if (!isIntInRange(input.ltvLimitBps, 1, BPS_DENOMINATOR)) {
      throw new BadRequestException('ltvLimitBps must be an integer between 1 and 10000');
    }
    if (!isIntInRange(input.marginCallBps, 1, BPS_DENOMINATOR)) {
      throw new BadRequestException('marginCallBps must be an integer between 1 and 10000');
    }
    if (input.marginCallBps < input.ltvLimitBps) {
      throw new BadRequestException('marginCallBps must be greater than or equal to ltvLimitBps');
    }
    // The outstanding balance lives in the finance ledger only. Verify the
    // receivable account is readable now — fail closed instead of attaching
    // a monitor that can never evaluate.
    const ledgerAccountCode = this.loanReceivableAccountCode(loan);
    try {
      await this.ledger.balance(ledgerAccountCode);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new BadRequestException(
          `Loan '${loan.id}' has no ledger receivable account — refusing to monitor a loan without a ledger footprint`
        );
      }
      throw error;
    }
    const now = new Date().toISOString();
    const position: CollateralPosition = {
      id: newId('whcollat'),
      receiptId: receipt.id,
      loanId: loan.id,
      lenderId: pledge.lenderId,
      borrowerId: pledge.borrowerId,
      ledgerAccountCode,
      pledgedQtyKg: input.pledgedQtyKg,
      commodity: receipt.crop,
      haircutBps: input.haircutBps,
      ltvLimitBps: input.ltvLimitBps,
      marginCallBps: input.marginCallBps,
      status: 'active',
      priceStale: false,
      openedAt: now,
      createdAt: now,
      updatedAt: now
    };
    // The repository enforces one live position per receipt (pg partial
    // unique index; in-memory guard) — a duplicate surfaces as 409.
    const created = await this.positions.create(position);
    await this.audit?.record({
      actorId: actor.id,
      action: 'warehouse.position.opened',
      entityType: 'warehouse_collateral_position',
      entityId: created.id,
      metadata: {
        receiptId: created.receiptId,
        loanId: created.loanId,
        lenderId: created.lenderId,
        commodity: created.commodity,
        pledgedQtyKg: created.pledgedQtyKg
      }
    });
    await this.events.publish(
      'warehouse.position.opened',
      {
        positionId: created.id,
        receiptId: created.receiptId,
        loanId: created.loanId,
        lenderId: created.lenderId,
        commodity: created.commodity,
        pledgedQtyKg: created.pledgedQtyKg,
        ltvLimitBps: created.ltvLimitBps,
        marginCallBps: created.marginCallBps
      },
      actor.id
    );
    return created;
  }

  /* ----------------------------------------------------------- views ------ */

  /**
   * Lender-facing position detail including the append-only observation
   * history (newest first). Visible to the position lender, the borrower,
   * admin and regulator.
   */
  async getPosition(id: string, actor: Actor): Promise<CollateralPositionDetail> {
    const position = await this.positions.getById(id);
    const privileged =
      actor.roles.includes('admin') || actor.roles.includes('regulator');
    if (!privileged && actor.id !== position.lenderId && actor.id !== position.borrowerId) {
      throw new ForbiddenException('Only the position lender, borrower or oversight may view it');
    }
    const observations = (await this.observations.find({ positionId: position.id })).sort(
      (a, b) => b.observedAt.localeCompare(a.observedAt)
    );
    return { position, observations };
  }

  /* ------------------------------------------------------- evaluation ----- */

  /**
   * Internal cron/Temporal step: evaluates every live (active|margin_call)
   * position once. Per-position failures are isolated — one bad position
   * never aborts the run; provider outages degrade to priceStale flags.
   */
  async runEvaluation(actorId?: string): Promise<LtvRunSummary> {
    const live = (
      await Promise.all(
        LIVE_POSITION_STATUSES.map((status) => this.positions.find({ status }))
      )
    ).flat();
    const summary: LtvRunSummary = {
      evaluatedAt: new Date().toISOString(),
      evaluated: live.length,
      observed: 0,
      unavailable: 0,
      marginCallsRaised: 0,
      cured: 0,
      results: []
    };
    for (const position of live) {
      let result: PositionEvaluationResult;
      try {
        result = await this.evaluatePosition(position, actorId);
      } catch {
        // Isolate per-position failures: one bad position never aborts the
        // run. Fail closed — flag the position for human review.
        await this.markPriceStale(position, true);
        this.telemetry.increment('warehouse.ltv_evaluations_total', 1, {
          commodity: position.commodity,
          basis: 'unavailable'
        });
        result = { positionId: position.id, outcome: 'unavailable', priceBasis: 'unavailable' };
      }
      summary.results.push(result);
      if (result.outcome === 'unavailable') summary.unavailable += 1;
      if (result.outcome === 'observed' || result.outcome === 'unchanged') summary.observed += 1;
      if (result.outcome === 'margin_call_raised') {
        summary.observed += 1;
        summary.marginCallsRaised += 1;
      }
      if (result.outcome === 'cured') {
        summary.observed += 1;
        summary.cured += 1;
      }
    }
    return summary;
  }

  /**
   * Evaluates one position against the current price quote. Never throws on
   * provider failure — fail-closed means skip + flag, not crash the run.
   */
  async evaluatePosition(
    position: CollateralPosition,
    actorId?: string
  ): Promise<PositionEvaluationResult> {
    const fetchStartedAt = Date.now();
    let quote: CommodityPriceQuote;
    try {
      quote = await this.prices.fetchQuote(position.commodity);
    } catch {
      // Fail-closed: no price → no observation, no state change. Flag the
      // position for human review and emit the unavailable metric.
      this.telemetry.record('warehouse.price_fetch_latency_ms', Date.now() - fetchStartedAt, {
        commodity: position.commodity,
        outcome: 'error'
      });
      return this.failClosedUnavailable(position);
    }
    this.telemetry.record('warehouse.price_fetch_latency_ms', Date.now() - fetchStartedAt, {
      commodity: position.commodity,
      outcome: 'ok'
    });
    const priceBasis: LtvPriceBasis = this.prices.name === 'http' ? 'live' : 'stub';
    let pricePerKgKobo: number;
    try {
      pricePerKgKobo = nairaPerTonneToKoboPerKg(quote.pricePerTonneNaira);
    } catch {
      // Degenerate quote (non-positive or rounds to zero kobo) — same
      // fail-closed posture as a failed fetch: never evaluate on it.
      return this.failClosedUnavailable(position);
    }
    return this.telemetry.withSpan(
      'warehouse.ltv.evaluate',
      { commodity: position.commodity, price_basis: priceBasis, position_id: position.id },
      async () => {
        // Outstanding ALWAYS from the ledger (single source of truth).
        const outstandingKobo = (
          await this.ledger.balance(position.ledgerAccountCode)
        ).balanceKobo;
        const ltvBps = computeLtvBps({
          pledgedQtyKg: position.pledgedQtyKg,
          pricePerKgKobo,
          haircutBps: position.haircutBps,
          outstandingKobo
        });
        const observation: LtvObservation = {
          id: newId('ltvobs'),
          positionId: position.id,
          pricePerKgKobo,
          priceBasis,
          outstandingKobo,
          ltvBps,
          observedAt: new Date().toISOString()
        };
        await this.observations.append(observation);
        await this.events.publish(
          'warehouse.ltv.observed',
          {
            positionId: position.id,
            receiptId: position.receiptId,
            loanId: position.loanId,
            observationId: observation.id,
            ltvBps,
            priceBasis,
            outstandingKobo
          },
          actorId
        );
        this.telemetry.increment('warehouse.ltv_evaluations_total', 1, {
          commodity: position.commodity,
          basis: priceBasis
        });
        if (position.priceStale) {
          await this.markPriceStale(position, false);
        }
        // CRITICAL honesty constraint: stub/fixture prices NEVER move state.
        // Only a live quote may raise or cure a margin call.
        if (priceBasis !== 'live') {
          return { positionId: position.id, outcome: 'observed', priceBasis, ltvBps };
        }
        const band = classifyLtv(ltvBps, position.ltvLimitBps, position.marginCallBps);
        if (band === 'margin_call' && position.status === 'active') {
          await this.raiseMarginCall(position, ltvBps, observation.id, actorId);
          return { positionId: position.id, outcome: 'margin_call_raised', priceBasis, ltvBps };
        }
        if (band === 'within_limit' && position.status === 'margin_call') {
          await this.cureMarginCall(position, ltvBps, observation.id, actorId);
          return { positionId: position.id, outcome: 'cured', priceBasis, ltvBps };
        }
        return { positionId: position.id, outcome: 'unchanged', priceBasis, ltvBps };
      }
    );
  }

  /* ---------------------------------------------------- state machine ----- */

  /**
   * CAS active → margin_call (funds-integrity discipline): the guarded
   * update only applies while the position is still 'active', so a margin
   * call is raised exactly once per erosion episode — a concurrent run that
   * already raised it yields a ConflictException and is a no-op here. The
   * outbox event commits in the same transaction on pg.
   */
  private async raiseMarginCall(
    position: CollateralPosition,
    ltvBps: number,
    observationId: string,
    actorId?: string
  ): Promise<CollateralPosition> {
    const event = this.events.build(
      'warehouse.margin_call.raised',
      {
        positionId: position.id,
        receiptId: position.receiptId,
        loanId: position.loanId,
        lenderId: position.lenderId,
        borrowerId: position.borrowerId,
        ltvBps,
        marginCallBps: position.marginCallBps,
        observationId
      },
      actorId
    );
    let updated: CollateralPosition;
    try {
      updated = await this.positions.updateExpected(
        position.id,
        { status: 'margin_call', priceStale: false, updatedAt: new Date().toISOString() },
        { status: 'active' },
        event
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        // Exactly-once: a concurrent evaluation already raised the call.
        return this.positions.getById(position.id);
      }
      throw error;
    }
    if (this.positions.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    this.telemetry.increment('warehouse.margin_calls_total', 1, {
      commodity: position.commodity
    });
    await this.audit?.record({
      actorId: actorId ?? 'system',
      action: 'warehouse.margin_call.raised',
      entityType: 'warehouse_collateral_position',
      entityId: position.id,
      metadata: { ltvBps, marginCallBps: position.marginCallBps, observationId }
    });
    return updated;
  }

  /**
   * CAS margin_call → cured: the live LTV recovered to within the position's
   * limit, so the call is cured and the monitoring episode closes. Only a
   * position still in 'margin_call' can cure — anything else conflicts out.
   */
  private async cureMarginCall(
    position: CollateralPosition,
    ltvBps: number,
    observationId: string,
    actorId?: string
  ): Promise<CollateralPosition> {
    const now = new Date().toISOString();
    const event = this.events.build(
      'warehouse.margin_call.cured',
      {
        positionId: position.id,
        receiptId: position.receiptId,
        loanId: position.loanId,
        lenderId: position.lenderId,
        borrowerId: position.borrowerId,
        ltvBps,
        ltvLimitBps: position.ltvLimitBps,
        observationId
      },
      actorId
    );
    let updated: CollateralPosition;
    try {
      updated = await this.positions.updateExpected(
        position.id,
        { status: 'cured', closedAt: now, updatedAt: now },
        { status: 'margin_call' },
        event
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        return this.positions.getById(position.id);
      }
      throw error;
    }
    if (this.positions.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.audit?.record({
      actorId: actorId ?? 'system',
      action: 'warehouse.margin_call.cured',
      entityType: 'warehouse_collateral_position',
      entityId: position.id,
      metadata: { ltvBps, ltvLimitBps: position.ltvLimitBps, observationId }
    });
    return updated;
  }

  /**
   * Shared fail-closed path for unavailable/degenerate prices: NO
   * observation is recorded, the position is flagged priceStale for human
   * review and the basis=unavailable metric is emitted.
   */
  private async failClosedUnavailable(
    position: CollateralPosition
  ): Promise<PositionEvaluationResult> {
    this.telemetry.increment('warehouse.ltv_evaluations_total', 1, {
      commodity: position.commodity,
      basis: 'unavailable'
    });
    await this.markPriceStale(position, true);
    return { positionId: position.id, outcome: 'unavailable', priceBasis: 'unavailable' };
  }

  /**
   * Sets/clears the price_stale review flag. CAS-guarded on the current
   * status so a concurrent margin-call transition is never clobbered; a
   * conflict just defers the flag to the next run.
   */
  private async markPriceStale(
    position: CollateralPosition,
    stale: boolean
  ): Promise<CollateralPosition> {
    if (position.priceStale === stale) {
      return position;
    }
    try {
      return await this.positions.updateExpected(
        position.id,
        { priceStale: stale, updatedAt: new Date().toISOString() },
        { status: position.status }
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        return this.positions.getById(position.id);
      }
      throw error;
    }
  }

  /**
   * Ledger account whose debit-positive balance is the loan's outstanding
   * principal (finance/loan.service.ts disbursement convention).
   */
  private loanReceivableAccountCode(loan: LoanApplication): string {
    return `member:${loan.applicantId}:loans_receivable`;
  }
}
