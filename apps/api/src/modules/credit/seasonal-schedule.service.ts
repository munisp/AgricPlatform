import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException
} from '@nestjs/common';
import type {
  CreditLoanApplication,
  CreditRepayment,
  CreditSeasonalSchedule
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CREDIT_LOAN_REPOSITORY,
  CREDIT_PRODUCT_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CROP_PLANTING_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  SEASONAL_SCHEDULE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CreditLoanRepository,
  CreditProductRepository,
  CreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import type {
  CropPlantingRepository,
  FarmPlotRepository
} from '../../database/repositories/farms.repository.js';
import type { SeasonalScheduleRepository } from '../../database/repositories/seasonal-schedule.repository.js';
import { isCreditReviewer, type CreditActor } from './credit.service.js';
import {
  generateSeasonalSchedule,
  SEASONAL_DEFAULT_HARVEST_WINDOW_DAYS,
  seasonalScheduleTotalKobo
} from './seasonal-schedule.js';

export const SEASONAL_REPAYMENT_FLAG = 'seasonal-repayment';

export interface PreviewSeasonalScheduleInput {
  /** Borrower's plot with a growing planting that carries a crop calendar. */
  plotId?: string;
  /** Explicit calendar capture (plot without a recorded planting). */
  crop?: string;
  plantingDate?: string;
  harvestWindowStart?: string;
  harvestWindowEnd?: string;
  /** 1–3 balloon installments inside the harvest window (default 2). */
  harvestInstallments?: number;
  /** Window length in days when derived from a planting (default 30). */
  harvestWindowDays?: number;
}

export interface AcceptSeasonalScheduleResult {
  loan: CreditLoanApplication;
  schedule: CreditSeasonalSchedule;
  repayments: CreditRepayment[];
}

/** Loan statuses on which a seasonal schedule may still be shaped. */
const SEASONAL_SHAPABLE_STATUSES = ['draft', 'submitted', 'scoring', 'approved'] as const;

const DAY_MS = 86_400_000;

function requireReviewer(actor: CreditActor): void {
  if (!isCreditReviewer(actor)) {
    throw new ForbiddenException('Only admin or lender reviewers may manage seasonal schedules');
  }
}

function toDateOnly(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

/**
 * SeasonSync — harvest-linked repayment schedules (innovation wave 27,
 * batch 1 #1). Reshapes a credit loan's installment CALENDAR to the crop
 * season (grace through the growing season, harvest-weighted balloons
 * inside the harvest window) instead of the equal-installment calendar.
 *
 * Doctrine notes:
 * - No money moves here. SeasonSync only replaces pending
 *   credit.loan_repayments rows; disbursement and repayment posting stay on
 *   the existing paths (finance ledger disburse / credit recordPayment).
 * - Pinned snapshots: preview persists the calendar inputs and computed
 *   installments (migration 055) so later plot edits cannot rewrite terms.
 * - Fail-closed: a plot without a usable crop calendar answers 422
 *   CROP_CALENDAR_REQUIRED — dates are never invented.
 * - Gated by the `seasonal-repayment` feature flag at the controller
 *   (fail-closed, default OFF) plus reviewer role checks here.
 */
@Injectable()
export class SeasonalScheduleService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_PRODUCT_REPOSITORY) private readonly products: CreditProductRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    @Inject(CROP_PLANTING_REPOSITORY) private readonly plantings: CropPlantingRepository,
    @Inject(SEASONAL_SCHEDULE_REPOSITORY) private readonly seasonal: SeasonalScheduleRepository,
    private readonly telemetry: TelemetryService,
    @Optional() private readonly audit?: AuditService
  ) {}

  /* ------------------------------------------------------------ preview -- */

  /**
   * Officer preview: computes the seasonal schedule for a loan and pins it
   * as a new `previewed` version. Accepting later references this pinned
   * row, so the accepted terms can never drift from what was previewed.
   */
  async preview(
    loanId: string,
    input: PreviewSeasonalScheduleInput,
    actor: CreditActor
  ): Promise<CreditSeasonalSchedule> {
    requireReviewer(actor);
    const loan = await this.loans.getById(loanId);
    this.assertShapable(loan);
    const calendar = await this.resolveCalendar(loan, input);
    const product = await this.products.getById(loan.productId);
    const now = new Date().toISOString();

    const started = Date.now();
    const installments = await this.telemetry.withSpan(
      'credit.seasonal_schedule.generate',
      { crop: calendar.crop, tenor_days: product.termDays },
      () =>
        generateSeasonalSchedule({
          principalKobo: loan.principalKobo,
          interestBpsAnnual: product.interestBpsAnnual,
          termDays: product.termDays,
          startIso: now,
          plantingDateIso: calendar.plantingDate,
          harvestWindowStartIso: calendar.harvestWindowStart,
          harvestWindowEndIso: calendar.harvestWindowEnd,
          harvestInstallments: input.harvestInstallments
        })
    );
    this.telemetry.record('credit.schedule_generation_latency_ms', Date.now() - started, {
      crop: calendar.crop
    });

    const existing = await this.seasonal.find({ loanId });
    const version = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;
    const record: CreditSeasonalSchedule = {
      id: newId('csched'),
      loanId: loan.id,
      plotId: calendar.plotId,
      crop: calendar.crop,
      plantingDate: toDateOnly(calendar.plantingDate),
      harvestWindowStart: toDateOnly(calendar.harvestWindowStart),
      harvestWindowEnd: toDateOnly(calendar.harvestWindowEnd),
      installments,
      version,
      status: 'previewed',
      createdBy: actor.id,
      createdAt: now
    };
    const created = await this.seasonal.create(record);
    this.telemetry.increment('credit.seasonal_schedules_total', 1, {
      action: 'previewed',
      crop: created.crop
    });
    await this.events.publish(
      'credit.seasonal_schedule.created',
      {
        scheduleId: created.id,
        loanId: loan.id,
        version: created.version,
        installmentCount: created.installments.length,
        totalKobo: seasonalScheduleTotalKobo(created.installments)
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.seasonal_schedule.previewed',
      entityType: 'credit_seasonal_schedule',
      entityId: created.id,
      metadata: { loanId: loan.id, version: created.version, crop: created.crop }
    });
    return created;
  }

  /* ------------------------------------------------------------- accept -- */

  /**
   * Accepts a previewed seasonal schedule: replaces the loan's pending
   * equal-installment repayments with the pinned seasonal installments.
   * Guarded end to end:
   * - loan must be exactly `approved` (the equal schedule exists, no money
   *   has moved, no payment has been recorded) — loans already disbursed /
   *   repaying ("active") are rejected;
   * - pinned totals are re-validated against the current product rate
   *   (stale previews answer 409 — the officer re-previews);
   * - the schedule row transitions previewed → accepted by CAS, and the
   *   partial unique index guarantees exactly one accepted schedule per
   *   loan. A replayed accept returns the stored state unchanged.
   */
  async accept(
    loanId: string,
    scheduleId: string,
    actor: CreditActor
  ): Promise<AcceptSeasonalScheduleResult> {
    requireReviewer(actor);
    const loan = await this.loans.getById(loanId);
    const schedule = await this.seasonal.getById(scheduleId);
    if (schedule.loanId !== loan.id) {
      throw new NotFoundException(`Seasonal schedule ${scheduleId} not found for loan ${loanId}`);
    }
    if (schedule.status === 'accepted') {
      // Idempotent replay of an accept retry.
      return { loan, schedule, repayments: await this.repayments.find({ loanId }) };
    }
    if (schedule.status === 'superseded') {
      throw new ConflictException(
        `SEASONAL_SCHEDULE_SUPERSEDED: schedule ${scheduleId} was superseded by a newer preview`
      );
    }
    if (loan.status !== 'approved') {
      throw new BadRequestException(
        `SEASONAL_SCHEDULE_STATE: loan ${loanId} is '${loan.status}'; a seasonal schedule can ` +
          `only be accepted while the loan is approved (before disbursement)`
      );
    }
    const product = await this.products.getById(loan.productId);
    const expectedTotal =
      Number(
        (BigInt(loan.principalKobo) * BigInt(product.interestBpsAnnual) * BigInt(product.termDays)) /
          (10_000n * 365n)
      ) + loan.principalKobo;
    if (seasonalScheduleTotalKobo(schedule.installments) !== expectedTotal) {
      throw new ConflictException(
        `SEASONAL_TERMS_STALE: schedule ${scheduleId} no longer matches the product terms; ` +
          `preview again before accepting`
      );
    }
    const current = await this.repayments.find({ loanId });
    if (current.some((repayment) => repayment.status !== 'pending')) {
      throw new ConflictException(
        `SEASONAL_REPAYMENTS_RECORDED: loan ${loanId} already has recorded payments`
      );
    }

    // Swap the calendar: remove the pending equal installments and insert
    // the pinned seasonal ones. No ledger movement — repayment posting is
    // unchanged (only due dates/amounts differ).
    for (const repayment of current) {
      await this.repayments.remove(repayment.id);
    }
    const replacements: CreditRepayment[] = [];
    for (const installment of schedule.installments) {
      replacements.push(
        await this.repayments.create({
          id: newId('crp'),
          loanId: loan.id,
          sequence: installment.sequence,
          dueAt: installment.dueAt,
          amountKobo: installment.amountKobo,
          status: 'pending'
        })
      );
    }

    const accepted = await this.seasonal.updateStatusExpected(
      schedule.id,
      'accepted',
      'previewed',
      { acceptedAt: new Date().toISOString() }
    );
    this.telemetry.increment('credit.seasonal_schedules_total', 1, {
      action: 'accepted',
      crop: accepted.crop
    });
    await this.events.publish(
      'credit.seasonal_schedule.accepted',
      {
        scheduleId: accepted.id,
        loanId: loan.id,
        version: accepted.version,
        installmentCount: accepted.installments.length,
        totalKobo: seasonalScheduleTotalKobo(accepted.installments)
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.seasonal_schedule.accepted',
      entityType: 'credit_seasonal_schedule',
      entityId: accepted.id,
      metadata: {
        loanId: loan.id,
        version: accepted.version,
        installmentCount: accepted.installments.length
      }
    });
    return { loan, schedule: accepted, repayments: replacements };
  }

  /** Pinned seasonal schedules for a loan (party-visible, newest first). */
  async listForLoan(loanId: string, actor: CreditActor): Promise<CreditSeasonalSchedule[]> {
    const loan = await this.loans.getById(loanId);
    if (loan.applicantUserId !== actor.id && !isCreditReviewer(actor)) {
      throw new ForbiddenException('You may only access loans you are a party to');
    }
    return (await this.seasonal.find({ loanId })).sort((a, b) => b.version - a.version);
  }

  /* ------------------------------------------------------------ helpers -- */

  private assertShapable(loan: CreditLoanApplication): void {
    if (!(SEASONAL_SHAPABLE_STATUSES as readonly string[]).includes(loan.status)) {
      throw new BadRequestException(
        `SEASONAL_SCHEDULE_STATE: loan ${loan.id} is '${loan.status}'; seasonal schedules can ` +
          `only be shaped before disbursement`
      );
    }
  }

  /**
   * Resolves the crop calendar for the schedule. With a plotId the calendar
   * comes from the plot's growing planting (plantedAt → expectedHarvestAt +
   * window days). Without one, the calendar must be captured explicitly —
   * a missing calendar answers 422 CROP_CALENDAR_REQUIRED, never invented
   * dates.
   */
  private async resolveCalendar(
    loan: CreditLoanApplication,
    input: PreviewSeasonalScheduleInput
  ): Promise<{
    plotId?: string;
    crop: string;
    plantingDate: string;
    harvestWindowStart: string;
    harvestWindowEnd: string;
  }> {
    if (input.plotId) {
      const plot = await this.plots.getById(input.plotId);
      if (plot.ownerUserId !== loan.applicantUserId) {
        throw new BadRequestException(
          `SEASONAL_PLOT_OWNER: plot ${input.plotId} does not belong to the loan applicant`
        );
      }
      const plantings = (await this.plantings.find({ plotId: plot.id, status: 'growing' }))
        .filter((planting) => planting.expectedHarvestAt !== undefined)
        .filter((planting) => !input.crop || planting.crop === input.crop)
        .sort((a, b) => Date.parse(a.expectedHarvestAt!) - Date.parse(b.expectedHarvestAt!));
      const planting = plantings[0];
      if (!planting) {
        throw new UnprocessableEntityException(
          `CROP_CALENDAR_REQUIRED: plot ${plot.id} has no growing planting with an expected ` +
            `harvest date; capture the calendar explicitly instead`
        );
      }
      const windowDays = input.harvestWindowDays ?? SEASONAL_DEFAULT_HARVEST_WINDOW_DAYS;
      if (!Number.isSafeInteger(windowDays) || windowDays < 1) {
        throw new BadRequestException('SEASONAL_WINDOW_DAYS: harvestWindowDays must be >= 1');
      }
      return {
        plotId: plot.id,
        crop: planting.crop,
        plantingDate: planting.plantedAt,
        harvestWindowStart: planting.expectedHarvestAt!,
        harvestWindowEnd: new Date(
          Date.parse(planting.expectedHarvestAt!) + windowDays * DAY_MS
        ).toISOString()
      };
    }
    if (!input.crop || !input.plantingDate || !input.harvestWindowStart || !input.harvestWindowEnd) {
      throw new UnprocessableEntityException(
        'CROP_CALENDAR_REQUIRED: provide a plotId with a growing planting, or an explicit ' +
          'crop + plantingDate + harvestWindowStart + harvestWindowEnd'
      );
    }
    return {
      crop: input.crop,
      plantingDate: input.plantingDate,
      harvestWindowStart: input.harvestWindowStart,
      harvestWindowEnd: input.harvestWindowEnd
    };
  }
}
