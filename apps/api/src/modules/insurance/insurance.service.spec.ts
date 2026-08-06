import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FarmPlot, ParametricPolicy, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import {
  createInMemoryParametricPayoutRepository,
  createInMemoryParametricPolicyRepository,
  createInMemoryParametricProductRepository,
  createInMemoryParametricTriggerEventRepository
} from '../../database/repositories/insurance.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { StubFloodRiskDriver } from '../geo-intel/flood-risk.drivers.js';
import { computePremiumKobo } from './premium.js';
import {
  INSURANCE_PRODUCT_CATALOG,
  INSURER_CLAIMS_PAYABLE_ACCOUNT,
  InsuranceService
} from './insurance.service.js';
import { aggregateRainfallMm, floodSeverityRank } from './trigger-engine.js';
import { StubWeatherProvider } from './weather.provider.js';

const farmer = { id: 'farmer-1', roles: ['farmer'] } as unknown as User;
const otherFarmer = { id: 'farmer-2', roles: ['farmer'] } as unknown as User;
const admin = { id: 'admin-1', roles: ['admin'] } as unknown as User;

const ENV_KEYS = ['WEATHER_API_URL', 'WEATHER_API_KEY', 'FLOOD_ML_DRIVER', 'FLOOD_ML_URL'];
let savedEnv: Record<string, string | undefined> = {};

const h3 = new H3Service();
const stubWeather = new StubWeatherProvider();
const stubFlood = new StubFloodRiskDriver();

function plot(overrides: Partial<FarmPlot> = {}): FarmPlot {
  return {
    id: 'plot-1',
    ownerUserId: farmer.id,
    name: 'Zaria North Plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.0855,
    centroidLong: 7.7199,
    sizeHectares: 2.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides
  };
}

/**
 * Scans candidate coordinates for one whose stub rainfall total satisfies
 * the predicate — deterministic, and mirrors exactly what the service will
 * observe for the plot h3 cell.
 */
async function scanRainfallCell(
  predicate: (totalMm: number) => boolean
): Promise<{ lat: number; long: number; totalMm: number }> {
  for (let i = 0; i < 4_000; i += 1) {
    const lat = 8 + (i % 200) * 0.025;
    const long = 6.5 + Math.floor(i / 200) * 0.05;
    const cell = h3.cellAt(lat, long, 7);
    const series = await stubWeather.observe({ h3Cell: cell, season: '2026-wet', windowDays: 30 });
    const totalMm = aggregateRainfallMm(series.rainfallMm);
    if (predicate(totalMm)) {
      return { lat, long, totalMm };
    }
  }
  throw new Error('no coordinate matched the predicate');
}

async function scanHeatCell(
  predicate: (heatDays: number) => boolean
): Promise<{ lat: number; long: number; heatDays: number }> {
  for (let i = 0; i < 4_000; i += 1) {
    const lat = 8 + (i % 200) * 0.025;
    const long = 6.5 + Math.floor(i / 200) * 0.05;
    const cell = h3.cellAt(lat, long, 7);
    const series = await stubWeather.observe({ h3Cell: cell, season: '2026-dry', windowDays: 45 });
    const heatDays = series.maxTempC.filter((value) => value >= 38).length;
    if (predicate(heatDays)) {
      return { lat, long, heatDays };
    }
  }
  throw new Error('no coordinate matched the predicate');
}

async function scanFloodCell(
  predicate: (severity: string) => boolean
): Promise<{ lat: number; long: number; severity: string }> {
  for (let i = 0; i < 4_000; i += 1) {
    const lat = 8 + (i % 200) * 0.025;
    const long = 6.5 + Math.floor(i / 200) * 0.05;
    const assessment = await stubFlood.assess({ latitude: lat, longitude: long });
    if (predicate(assessment.severity)) {
      return { lat, long, severity: assessment.severity };
    }
  }
  throw new Error('no coordinate matched the predicate');
}

function makeService(plots: FarmPlot[] = [plot()]) {
  const products = createInMemoryParametricProductRepository();
  const policies = createInMemoryParametricPolicyRepository();
  const triggerEvents = createInMemoryParametricTriggerEventRepository();
  const payouts = createInMemoryParametricPayoutRepository();
  const plotRepo = createInMemoryFarmPlotRepository(plots);
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const service = new InsuranceService(
    products,
    policies,
    triggerEvents,
    payouts,
    plotRepo,
    h3,
    ledger,
    events
  );
  return { service, products, policies, triggerEvents, payouts, plotRepo, outbox, ledger };
}

async function activeRainPolicy(
  context: ReturnType<typeof makeService>,
  coords: { lat: number; long: number },
  sumInsuredKobo = 1_000_000
): Promise<ParametricPolicy> {
  const { service, plotRepo } = context;
  await plotRepo.create(plot({ id: 'plot-trigger', centroidLat: coords.lat, centroidLong: coords.long }));
  const { policy } = await service.quote(farmer, {
    productCode: 'NG-RAIN-WET-26',
    plotId: 'plot-trigger',
    season: '2026-wet',
    sumInsuredKobo
  });
  return service.issue(farmer, policy.id);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('product catalog (repository seed)', () => {
  it('seeds exactly 3 parametric products through the repository, not migration data', async () => {
    const { service, products } = makeService();
    const catalog = await service.listProducts();
    expect(catalog).toHaveLength(3);
    expect(catalog.map((product) => product.code).sort()).toEqual([
      'NG-FLOOD-26',
      'NG-HEAT-DRY-26',
      'NG-RAIN-WET-26'
    ]);
    expect(await products.all()).toHaveLength(3);
  });

  it('seeding is idempotent and keeps product ids stable', async () => {
    const { service } = makeService();
    const first = await service.listProducts();
    const second = await service.listProducts();
    expect(second.map((product) => product.id).sort()).toEqual(
      first.map((product) => product.id).sort()
    );
  });

  it('every catalog product carries a graduated payout table with an at-threshold band', () => {
    for (const product of INSURANCE_PRODUCT_CATALOG) {
      expect(product.payoutTable.some((band) => band.minRatio === 0)).toBe(true);
      for (const band of product.payoutTable) {
        expect(band.payoutPercent).toBeGreaterThan(0);
        expect(band.payoutPercent).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('quote', () => {
  it('prices with the deterministic rate card and persists a QUOTED policy', async () => {
    const { service } = makeService();
    const coords = { latitude: plot().centroidLat, longitude: plot().centroidLong };
    const assessment = await stubFlood.assess(coords);
    const expectedBand = (['none', 'low', 'moderate', 'high', 'severe'] as const)[
      floodSeverityRank(assessment.severity)
    ];
    const { quote, policy } = await service.quote(farmer, {
      productCode: 'NG-RAIN-WET-26',
      plotId: 'plot-1',
      season: '2026-wet',
      sumInsuredKobo: 1_000_000
    });
    const expected = computePremiumKobo({
      sumInsuredKobo: 1_000_000,
      premiumRateBps: 800,
      floodBand: expectedBand
    });
    expect(quote.premiumKobo).toBe(expected.premiumKobo);
    expect(quote.floodBand).toBe(expectedBand);
    expect(quote.pricingBasis).toBe('stub');
    expect(policy.status).toBe('quoted');
    expect(policy.premiumKobo).toBe(expected.premiumKobo);
  });

  it('rejects a season the product does not cover', async () => {
    const { service } = makeService();
    await expect(
      service.quote(farmer, {
        productCode: 'NG-RAIN-WET-26',
        plotId: 'plot-1',
        season: '2026-dry',
        sumInsuredKobo: 1_000_000
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects sum-insured amounts outside the rate-card bounds', async () => {
    const { service } = makeService();
    await expect(
      service.quote(farmer, {
        productCode: 'NG-RAIN-WET-26',
        plotId: 'plot-1',
        season: '2026-wet',
        sumInsuredKobo: 50_000
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.quote(farmer, {
        productCode: 'NG-RAIN-WET-26',
        plotId: 'plot-1',
        season: '2026-wet',
        sumInsuredKobo: 500_000_000
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects quoting someone else’s plot', async () => {
    const { service } = makeService();
    await expect(
      service.quote(otherFarmer, {
        productCode: 'NG-RAIN-WET-26',
        plotId: 'plot-1',
        season: '2026-wet',
        sumInsuredKobo: 1_000_000
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects unknown products and plots', async () => {
    const { service } = makeService();
    await expect(
      service.quote(farmer, {
        productCode: 'NOPE',
        plotId: 'plot-1',
        season: '2026-wet',
        sumInsuredKobo: 1_000_000
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.quote(farmer, {
        productCode: 'NG-RAIN-WET-26',
        plotId: 'plot-missing',
        season: '2026-wet',
        sumInsuredKobo: 1_000_000
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('policy state machine', () => {
  async function quotedPolicy(context: ReturnType<typeof makeService>) {
    const { policy } = await context.service.quote(farmer, {
      productCode: 'NG-RAIN-WET-26',
      plotId: 'plot-1',
      season: '2026-wet',
      sumInsuredKobo: 1_000_000
    });
    return policy;
  }

  it('issues a quoted policy (QUOTED → ACTIVE) and emits insurance.policy.issued', async () => {
    const context = makeService();
    const policy = await quotedPolicy(context);
    const issued = await context.service.issue(farmer, policy.id);
    expect(issued.status).toBe('active');
    const names = (await context.outbox.list()).map((event) => event.name);
    expect(names).toContain('insurance.policy.issued');
  });

  it('rejects issuing an already-active policy with 409', async () => {
    const context = makeService();
    const policy = await quotedPolicy(context);
    await context.service.issue(farmer, policy.id);
    await expect(context.service.issue(farmer, policy.id)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('rejects issuing someone else’s policy', async () => {
    const context = makeService();
    const policy = await quotedPolicy(context);
    await expect(context.service.issue(otherFarmer, policy.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('expires an active policy (admin) and rejects expiring a quoted one', async () => {
    const context = makeService();
    const policy = await quotedPolicy(context);
    await expect(context.service.expire(admin, policy.id)).rejects.toBeInstanceOf(
      ConflictException
    );
    await context.service.issue(farmer, policy.id);
    const expired = await context.service.expire(admin, policy.id);
    expect(expired.status).toBe('expired');
  });

  it('restricts expiry to admins', async () => {
    const context = makeService();
    const policy = await quotedPolicy(context);
    await context.service.issue(farmer, policy.id);
    await expect(context.service.expire(farmer, policy.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('trigger evaluation — stub determinism', () => {
  it('triggers a rainfall deficit policy, records evidence and proposes a ledger payout', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    const policy = await activeRainPolicy(context, coords);

    const report = await context.service.evaluateTriggers(admin);
    expect(report.triggered).toBe(1);
    expect(report.payoutsProposed).toBe(1);
    expect(report.unavailable).toBe(0);

    const events = await context.triggerEvents.all();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.policyId).toBe(policy.id);
    expect(event.evidence.metric).toBe('rainfall_mm');
    expect(event.evidence.observedValue).toBe(coords.totalMm);
    expect(event.evidence.threshold).toBe(40);
    expect(event.evidence.operator).toBe('lte');
    expect(event.evidence.breachRatio).toBeCloseTo((40 - coords.totalMm) / 40, 10);
    expect(event.evidence.basis.weather).toBe('stub');
    expect(event.evidence.h3Cell).toBe(h3.cellAt(coords.lat, coords.long, 7));
    expect(event.evidence.dailyValues).toHaveLength(30);

    // Graduated payout from the product table.
    const ratio = (40 - coords.totalMm) / 40;
    const expectedPercent = ratio >= 0.5 ? 100 : ratio >= 0.25 ? 60 : 25;
    expect(event.payoutPercent).toBe(expectedPercent);
    expect(event.payoutKobo).toBe(Math.round((1_000_000 * expectedPercent) / 100));

    // Payout proposal in stub execution, booked through the ledger.
    const payouts = await context.payouts.all();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].status).toBe('proposed');
    expect(payouts[0].execution).toBe('stub');
    expect(payouts[0].amountKobo).toBe(event.payoutKobo);
    expect(payouts[0].ledgerProposalEntryId).toBeTruthy();
    const payable = await context.ledger.balance(INSURER_CLAIMS_PAYABLE_ACCOUNT);
    expect(payable.creditsKobo - payable.debitsKobo).toBe(event.payoutKobo);

    // Policy walked ACTIVE → PAYOUT_PROPOSED; domain events published.
    expect((await context.policies.findById(policy.id))?.status).toBe('payout_proposed');
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).toContain('insurance.trigger.raised');
    expect(names).toContain('insurance.payout.proposed');
  });

  it('is idempotent: a re-run replays the event (duplicate) without a second payout', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const second = await context.service.evaluateTriggers(admin);
    // Policy is no longer ACTIVE, so the batch skips it entirely.
    expect(second.evaluated).toBe(0);
    expect(second.triggered).toBe(0);
    expect(second.payoutsProposed).toBe(0);
    expect(await context.triggerEvents.all()).toHaveLength(1);
    expect(await context.payouts.all()).toHaveLength(1);
  });

  it('replays identical events when the same policy is re-evaluated while still active', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    const policy = await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    // Reset the policy back to active to simulate a payout-write crash.
    const stored = await context.policies.findById(policy.id);
    await context.policies.update({ ...stored!, status: 'active' });
    const before = await context.triggerEvents.all();
    const report = await context.service.evaluateTriggers(admin);
    const after = await context.triggerEvents.all();
    expect(after).toHaveLength(before.length);
    expect(after[0].id).toBe(before[0].id);
    expect(report.duplicates + report.payoutsProposed).toBe(1);
  });

  it('pays the lowest graduated band exactly at the threshold (breach ratio 0)', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm === 40);
    const context = makeService();
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [event] = await context.triggerEvents.all();
    expect(event.evidence.observedValue).toBe(40);
    expect(event.evidence.breachRatio).toBe(0);
    expect(event.payoutPercent).toBe(25);
    expect(event.payoutKobo).toBe(250_000);
  });

  it('pays 100% in the top band for a total rainfall failure', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 20);
    const context = makeService();
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [event] = await context.triggerEvents.all();
    expect(event.payoutPercent).toBe(100);
    expect(event.payoutKobo).toBe(1_000_000);
  });

  it('leaves clear policies ACTIVE with no trigger event', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm > 40);
    const context = makeService();
    const policy = await activeRainPolicy(context, coords);
    const report = await context.service.evaluateTriggers(admin);
    expect(report.triggered).toBe(0);
    expect(report.cells[0].status).toBe('clear');
    expect(await context.triggerEvents.all()).toHaveLength(0);
    expect((await context.policies.findById(policy.id))?.status).toBe('active');
  });

  it('triggers heat stress products from the weather provider', async () => {
    const coords = await scanHeatCell((heatDays) => heatDays >= 10);
    const context = makeService();
    await context.plotRepo.create(
      plot({ id: 'plot-heat', centroidLat: coords.lat, centroidLong: coords.long })
    );
    const { policy } = await context.service.quote(farmer, {
      productCode: 'NG-HEAT-DRY-26',
      plotId: 'plot-heat',
      season: '2026-dry',
      sumInsuredKobo: 1_000_000
    });
    await context.service.issue(farmer, policy.id);
    const report = await context.service.evaluateTriggers(admin);
    expect(report.triggered).toBe(1);
    const [event] = await context.triggerEvents.all();
    expect(event.evidence.metric).toBe('heat_days');
    expect(event.evidence.observedValue).toBe(coords.heatDays);
    expect(event.evidence.basis.weather).toBe('stub');
  });

  it('triggers flood products from the geo-intel flood port', async () => {
    const coords = await scanFloodCell((severity) => floodSeverityRank(severity) >= 3);
    const context = makeService();
    await context.plotRepo.create(
      plot({ id: 'plot-flood', centroidLat: coords.lat, centroidLong: coords.long })
    );
    const { policy } = await context.service.quote(farmer, {
      productCode: 'NG-FLOOD-26',
      plotId: 'plot-flood',
      season: '2026-wet',
      sumInsuredKobo: 1_000_000
    });
    await context.service.issue(farmer, policy.id);
    const report = await context.service.evaluateTriggers(admin);
    expect(report.triggered).toBe(1);
    const [event] = await context.triggerEvents.all();
    expect(event.evidence.metric).toBe('flood_rank');
    expect(event.evidence.observedValue).toBe(floodSeverityRank(coords.severity));
    expect(event.evidence.basis.flood).toBe('stub');
  });

  it('restricts evaluation to admins', async () => {
    const context = makeService();
    await expect(context.service.evaluateTriggers(farmer)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('trigger evaluation — fail-closed live weather', () => {
  it('marks cells unavailable and answers 503 when live weather is configured but unreachable', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    await activeRainPolicy(context, coords);
    process.env.WEATHER_API_URL = 'https://weather.invalid';
    process.env.WEATHER_API_KEY = 'secret';
    context.service.resetProvidersForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));

    await expect(context.service.evaluateTriggers(admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    // Fail-closed: NO trigger event, NO payout, policy stays ACTIVE.
    expect(await context.triggerEvents.all()).toHaveLength(0);
    expect(await context.payouts.all()).toHaveLength(0);
    const active = await context.policies.find({ status: 'active' });
    expect(active).toHaveLength(1);
  });

  it('fails the quote with 503 when the live flood sidecar is configured but unreachable', async () => {
    const context = makeService();
    process.env.FLOOD_ML_DRIVER = 'http';
    process.env.FLOOD_ML_URL = 'https://flood.invalid';
    context.service.resetProvidersForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));
    await expect(
      context.service.quote(farmer, {
        productCode: 'NG-RAIN-WET-26',
        plotId: 'plot-1',
        season: '2026-wet',
        sumInsuredKobo: 1_000_000
      })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('payout settlement (stub execution)', () => {
  it('confirms a proposed payout as PAID with a ledger settlement entry', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    const policy = await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();

    const paid = await context.service.confirmPayout(admin, payout.id);
    expect(paid.status).toBe('paid');
    expect(paid.execution).toBe('stub');
    expect(paid.ledgerSettlementEntryId).toBeTruthy();
    expect(paid.paidAt).toBeTruthy();
    expect((await context.policies.findById(policy.id))?.status).toBe('paid');
    const farmerBalance = await context.ledger.balance(`farmer:${farmer.id}:insurance_payouts`);
    expect(farmerBalance.creditsKobo - farmerBalance.debitsKobo).toBe(payout.amountKobo);
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).toContain('insurance.payout.paid');
  });

  it('rejects confirming an already-paid payout with 409', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    await context.service.confirmPayout(admin, payout.id);
    await expect(context.service.confirmPayout(admin, payout.id)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('restricts payout confirmation to admins', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    await expect(context.service.confirmPayout(farmer, payout.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('insurer portfolio', () => {
  it('aggregates policies, premiums and payouts for the insurer read API', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    await activeRainPolicy(context, coords);
    // A second, clear policy in the portfolio.
    const clearCoords = await scanRainfallCell((totalMm) => totalMm > 40);
    await context.plotRepo.create(
      plot({ id: 'plot-clear', centroidLat: clearCoords.lat, centroidLong: clearCoords.long })
    );
    const { policy: clearPolicy } = await context.service.quote(farmer, {
      productCode: 'NG-RAIN-WET-26',
      plotId: 'plot-clear',
      season: '2026-wet',
      sumInsuredKobo: 2_000_000
    });
    await context.service.issue(farmer, clearPolicy.id);

    await context.service.evaluateTriggers(admin);
    const portfolio = await context.service.insurerPortfolio();
    expect(portfolio.triggerEventCount).toBe(1);
    expect(portfolio.totalSumInsuredKobo).toBe(3_000_000);
    expect(portfolio.policiesByStatus.payout_proposed).toBe(1);
    expect(portfolio.policiesByStatus.active).toBe(1);
    expect(portfolio.totalPremiumKobo).toBeGreaterThan(0);
    expect(portfolio.payoutsByStatus.proposed).toBe(1);
    expect(portfolio.totalPayoutKobo).toBeGreaterThan(0);
  });
});
