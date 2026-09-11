import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  CreditLoanApplication,
  CreditLoanProduct,
  CreditRepayment,
  CropPlanting,
  FarmPlot,
  User
} from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  InMemoryCreditLoanRepository,
  InMemoryCreditProductRepository,
  InMemoryCreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import {
  createInMemoryCropPlantingRepository,
  createInMemoryFarmPlotRepository,
  InMemoryCropPlantingRepository,
  InMemoryFarmPlotRepository
} from '../../database/repositories/farms.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemorySeasonalScheduleRepository,
  InMemorySeasonalScheduleRepository
} from '../../database/repositories/seasonal-schedule.repository.js';
import { seasonalScheduleTotalKobo } from './seasonal-schedule.js';
import { SeasonalScheduleService } from './seasonal-schedule.service.js';

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };

const DAY_MS = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString();

const PRODUCT: CreditLoanProduct = {
  id: 'cprd-seasonal',
  name: 'Seasonal input loan',
  minPrincipalKobo: 100_000,
  maxPrincipalKobo: 5_000_000,
  interestBpsAnnual: 1200,
  termDays: 180,
  groupLending: false,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

// principal 1_000_000, 1200 bps over 180 days → interest 59_178 → total 1_059_178
const EXPECTED_TOTAL = 1_059_178;

function makeLoan(status: CreditLoanApplication['status']): CreditLoanApplication {
  return {
    id: `cloan-${status}`,
    applicantUserId: farmer.id,
    productId: PRODUCT.id,
    principalKobo: 1_000_000,
    status,
    createdAt: iso(-70),
    updatedAt: iso(-1)
  };
}

function makePlot(): FarmPlot {
  return {
    id: 'plot-1',
    ownerUserId: farmer.id,
    name: 'Adamu maize plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.1,
    centroidLong: 7.7,
    sizeHectares: 1.5,
    createdAt: iso(-80),
    updatedAt: iso(-80),
    version: 1
  };
}

function makePlanting(overrides: Partial<CropPlanting> = {}): CropPlanting {
  return {
    id: 'planting-1',
    plotId: 'plot-1',
    crop: 'maize',
    season: '2026-wet',
    plantedAt: iso(-60),
    expectedHarvestAt: iso(90),
    status: 'growing',
    createdAt: iso(-60),
    updatedAt: iso(-60),
    version: 1,
    ...overrides
  };
}

function makeService(options: {
  loans?: InMemoryCreditLoanRepository;
  products?: InMemoryCreditProductRepository;
  repayments?: InMemoryCreditRepaymentRepository;
  plots?: InMemoryFarmPlotRepository;
  plantings?: InMemoryCropPlantingRepository;
  seasonal?: InMemorySeasonalScheduleRepository;
} = {}) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const loans = options.loans ?? createInMemoryCreditLoanRepository();
  const products = options.products ?? new InMemoryCreditProductRepository([PRODUCT]);
  const repayments = options.repayments ?? createInMemoryCreditRepaymentRepository();
  const plots = options.plots ?? createInMemoryFarmPlotRepository();
  const plantings = options.plantings ?? createInMemoryCropPlantingRepository();
  const seasonal = options.seasonal ?? createInMemorySeasonalScheduleRepository();
  const service = new SeasonalScheduleService(
    events,
    loans,
    products,
    repayments,
    plots,
    plantings,
    seasonal,
    new TelemetryService()
  );
  return { service, events, outbox, loans, products, repayments, plots, plantings, seasonal };
}

/** Seeds an approved loan with the equal-installment schedule approve() would write. */
async function seedApprovedLoan() {
  const equalInstallments: CreditRepayment[] = [1, 2, 3, 4, 5, 6].map((sequence) => ({
    id: `crp-equal-${sequence}`,
    loanId: 'cloan-approved',
    sequence,
    dueAt: iso(sequence * 30),
    amountKobo: sequence === 6 ? 176_531 : 176_529, // 1_059_178 over 6, remainder last
    status: 'pending'
  }));
  const harness = makeService({
    loans: new InMemoryCreditLoanRepository([makeLoan('approved')]),
    repayments: new InMemoryCreditRepaymentRepository(equalInstallments),
    plots: createInMemoryFarmPlotRepository([makePlot()]),
    plantings: createInMemoryCropPlantingRepository([makePlanting()])
  });
  return harness;
}

describe('SeasonalScheduleService.preview', () => {
  it('pins a seasonal schedule from the plot crop calendar (grace → balloons)', async () => {
    const { service, seasonal } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);

    expect(preview.status).toBe('previewed');
    expect(preview.version).toBe(1);
    expect(preview.plotId).toBe('plot-1');
    expect(preview.crop).toBe('maize');
    expect(preview.installments).toHaveLength(2);
    expect(seasonalScheduleTotalKobo(preview.installments)).toBe(EXPECTED_TOTAL);
    // Grace: nothing due before the harvest window opens (expected harvest
    // +90d); both balloons land inside the 30-day window.
    const windowStart = Date.parse(preview.harvestWindowStart);
    for (const installment of preview.installments) {
      expect(Date.parse(installment.dueAt)).toBeGreaterThanOrEqual(windowStart);
    }
    expect((await seasonal.find({ loanId: 'cloan-approved' })).length).toBe(1);
  });

  it('emits credit.seasonal_schedule.created through the outbox', async () => {
    const { service, outbox } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    const stored = await outbox.list();
    const event = stored.find((entry) => entry.name === 'credit.seasonal_schedule.created');
    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      scheduleId: preview.id,
      loanId: 'cloan-approved',
      version: 1,
      installmentCount: 2,
      totalKobo: EXPECTED_TOTAL
    });
  });

  it('appends a new version per preview (pinned snapshots never mutate)', async () => {
    const { service } = await seedApprovedLoan();
    const first = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    const second = await service.preview(
      'cloan-approved',
      { plotId: 'plot-1', harvestInstallments: 3 },
      lender
    );
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);
    const stored = await service.listForLoan('cloan-approved', lender);
    expect(stored[0].version).toBe(2);
    expect(stored[1].version).toBe(1);
  });

  it('accepts an explicitly captured calendar when the plot has none', async () => {
    const { service } = await seedApprovedLoan();
    const preview = await service.preview(
      'cloan-approved',
      {
        crop: 'rice',
        plantingDate: iso(-30),
        harvestWindowStart: iso(60),
        harvestWindowEnd: iso(90)
      },
      lender
    );
    expect(preview.plotId).toBeUndefined();
    expect(preview.crop).toBe('rice');
    expect(seasonalScheduleTotalKobo(preview.installments)).toBe(EXPECTED_TOTAL);
  });

  it('fails closed with 422 CROP_CALENDAR_REQUIRED when the plot has no usable calendar', async () => {
    const { service } = await seedApprovedLoan();
    // plot-1 exists but its planting has no expectedHarvestAt → harvest it
    // would require inventing dates; must 422.
    await expect(service.preview('cloan-approved', { plotId: 'plot-2' }, lender)).rejects.toThrow(
      NotFoundException
    );
    await expect(
      service.preview('cloan-approved', {}, lender)
    ).rejects.toThrowError(/CROP_CALENDAR_REQUIRED/);
    await expect(
      service.preview('cloan-approved', {}, lender)
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('422 when the plot planting lacks an expected harvest date', async () => {
    const harness = makeService({
      loans: new InMemoryCreditLoanRepository([makeLoan('approved')]),
      plots: createInMemoryFarmPlotRepository([makePlot()]),
      plantings: createInMemoryCropPlantingRepository([
        makePlanting({ expectedHarvestAt: undefined })
      ])
    });
    await expect(
      harness.service.preview('cloan-approved', { plotId: 'plot-1' }, lender)
    ).rejects.toThrowError(/CROP_CALENDAR_REQUIRED/);
  });

  it('rejects a plot that does not belong to the applicant', async () => {
    const harness = makeService({
      loans: new InMemoryCreditLoanRepository([makeLoan('approved')]),
      plots: createInMemoryFarmPlotRepository([{ ...makePlot(), ownerUserId: 'user-aisha' }]),
      plantings: createInMemoryCropPlantingRepository([makePlanting()])
    });
    await expect(
      harness.service.preview('cloan-approved', { plotId: 'plot-1' }, lender)
    ).rejects.toThrowError(/SEASONAL_PLOT_OWNER/);
  });

  it('is reviewer-only', async () => {
    const { service } = await seedApprovedLoan();
    await expect(service.preview('cloan-approved', { plotId: 'plot-1' }, farmer)).rejects.toThrow(
      ForbiddenException
    );
  });

  it('rejects loans already active (disbursed/repaying) at preview time', async () => {
    const { service } = makeService({
      loans: new InMemoryCreditLoanRepository([makeLoan('repaying')])
    });
    await expect(
      service.preview('cloan-repaying', { crop: 'maize', plantingDate: iso(-30),
        harvestWindowStart: iso(60), harvestWindowEnd: iso(90) }, lender)
    ).rejects.toThrowError(/SEASONAL_SCHEDULE_STATE/);
  });
});

describe('SeasonalScheduleService.accept', () => {
  it('replaces the equal installments with the pinned seasonal ones', async () => {
    const { service, repayments } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    const result = await service.accept('cloan-approved', preview.id, lender);

    expect(result.schedule.status).toBe('accepted');
    expect(result.schedule.acceptedAt).toBeDefined();
    expect(result.repayments).toHaveLength(2);
    const stored = await repayments.find({ loanId: 'cloan-approved' });
    expect(stored).toHaveLength(2);
    // Old equal-installment rows are gone; amounts/dates are the pinned ones.
    expect(stored.some((entry) => entry.id.startsWith('crp-equal-'))).toBe(false);
    expect(stored.map((entry) => entry.amountKobo).sort((a, b) => a - b)).toEqual(
      preview.installments.map((entry) => entry.amountKobo).sort((a, b) => a - b)
    );
    expect(stored.every((entry) => entry.status === 'pending')).toBe(true);
    expect(seasonalScheduleTotalKobo(preview.installments)).toBe(EXPECTED_TOTAL);
  });

  it('emits credit.seasonal_schedule.accepted through the outbox', async () => {
    const { service, outbox } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    await service.accept('cloan-approved', preview.id, lender);
    const stored = await outbox.list();
    const event = stored.find((entry) => entry.name === 'credit.seasonal_schedule.accepted');
    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      scheduleId: preview.id,
      loanId: 'cloan-approved',
      installmentCount: 2,
      totalKobo: EXPECTED_TOTAL
    });
  });

  it('is idempotent: a replayed accept returns stored state and never duplicates rows', async () => {
    const { service, repayments } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    const first = await service.accept('cloan-approved', preview.id, lender);
    const replay = await service.accept('cloan-approved', preview.id, lender);
    expect(replay.schedule.status).toBe('accepted');
    expect(await repayments.find({ loanId: 'cloan-approved' })).toHaveLength(2);
    expect(replay.repayments.map((entry) => entry.id).sort()).toEqual(
      first.repayments.map((entry) => entry.id).sort()
    );
  });

  it('rejects accept once the loan is active (repaying)', async () => {
    const harness = makeService({
      loans: new InMemoryCreditLoanRepository([makeLoan('approved')]),
      plots: createInMemoryFarmPlotRepository([makePlot()]),
      plantings: createInMemoryCropPlantingRepository([makePlanting()])
    });
    const preview = await harness.service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    // The loan moves on (disburse → repaying) before the officer accepts.
    await harness.loans.update('cloan-approved', { status: 'repaying' });
    await expect(
      harness.service.accept('cloan-approved', preview.id, lender)
    ).rejects.toThrowError(/SEASONAL_SCHEDULE_STATE/);
    await expect(
      harness.service.accept('cloan-approved', preview.id, lender)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects accept on an unapproved (still scoring) loan', async () => {
    const harness = makeService({
      loans: new InMemoryCreditLoanRepository([makeLoan('scoring')]),
      plots: createInMemoryFarmPlotRepository([makePlot()]),
      plantings: createInMemoryCropPlantingRepository([makePlanting()])
    });
    const preview = await harness.service.preview('cloan-scoring', { plotId: 'plot-1' }, lender);
    await expect(
      harness.service.accept('cloan-scoring', preview.id, lender)
    ).rejects.toThrowError(/SEASONAL_SCHEDULE_STATE/);
  });

  it('rejects a superseded schedule with 409', async () => {
    const { service, seasonal } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    await seasonal.updateStatusExpected(preview.id, 'superseded', 'previewed');
    await expect(service.accept('cloan-approved', preview.id, lender)).rejects.toThrowError(
      /SEASONAL_SCHEDULE_SUPERSEDED/
    );
    await expect(service.accept('cloan-approved', preview.id, lender)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('rejects stale terms with 409 when the product rate changed after preview', async () => {
    const { service, products } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    await products.update(PRODUCT.id, { interestBpsAnnual: 1500 });
    await expect(service.accept('cloan-approved', preview.id, lender)).rejects.toThrowError(
      /SEASONAL_TERMS_STALE/
    );
  });

  it('enforces exactly one accepted schedule per loan', async () => {
    const { service } = await seedApprovedLoan();
    const first = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    const second = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    await service.accept('cloan-approved', first.id, lender);
    await expect(service.accept('cloan-approved', second.id, lender)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('rejects a schedule that belongs to another loan', async () => {
    const other = { ...makeLoan('approved'), id: 'cloan-other' };
    const harness = makeService({
      loans: new InMemoryCreditLoanRepository([makeLoan('approved'), other]),
      plots: createInMemoryFarmPlotRepository([makePlot()]),
      plantings: createInMemoryCropPlantingRepository([makePlanting()])
    });
    const preview = await harness.service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    await expect(harness.service.accept('cloan-other', preview.id, lender)).rejects.toThrow(
      NotFoundException
    );
  });

  it('is reviewer-only', async () => {
    const { service } = await seedApprovedLoan();
    const preview = await service.preview('cloan-approved', { plotId: 'plot-1' }, lender);
    await expect(service.accept('cloan-approved', preview.id, farmer)).rejects.toThrow(
      ForbiddenException
    );
  });
});
