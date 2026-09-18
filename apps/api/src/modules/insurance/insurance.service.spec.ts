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
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new InsuranceService(
    products,
    policies,
    triggerEvents,
    payouts,
    plotRepo,
    h3,
    ledger,
    events,
    audit as never
  );
  return { service, products, policies, triggerEvents, payouts, plotRepo, outbox, ledger, audit };
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
  vi.unstubAllEnvs();
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

describe('trigger evaluation — production fail-closed stub providers', () => {
  it('refuses to book ledger payouts from stub weather data in production (503)', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    vi.stubEnv('NODE_ENV', 'production');
    const context = makeService();
    const policy = await activeRainPolicy(context, coords);

    await expect(context.service.evaluateTriggers(admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    // Fail closed: NO trigger event, NO payout, policy stays ACTIVE.
    expect(await context.triggerEvents.all()).toHaveLength(0);
    expect(await context.payouts.all()).toHaveLength(0);
    expect((await context.policies.findById(policy.id))?.status).toBe('active');
  });

  it('refuses to book ledger payouts from stub flood data in production (503)', async () => {
    const coords = await scanFloodCell((severity) => floodSeverityRank(severity) >= 3);
    vi.stubEnv('NODE_ENV', 'production');
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

    await expect(context.service.evaluateTriggers(admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(await context.triggerEvents.all()).toHaveLength(0);
    expect(await context.payouts.all()).toHaveLength(0);
    expect((await context.policies.findById(policy.id))?.status).toBe('active');
  });

  it('treats NODE_ENV casing variants as production (fail closed)', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    vi.stubEnv('NODE_ENV', 'Production');
    const context = makeService();
    await activeRainPolicy(context, coords);
    await expect(context.service.evaluateTriggers(admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(await context.triggerEvents.all()).toHaveLength(0);
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

  it('fails closed with 503 in production: stub execution never marks a payout PAID (WP-G15)', async () => {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    const context = makeService();
    const policy = await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    expect(payout.status).toBe('proposed');

    vi.stubEnv('NODE_ENV', 'production');
    await expect(context.service.confirmPayout(admin, payout.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    // Fail closed: NOTHING changed — payout still proposed, policy still
    // payout_proposed, no settlement entry, no farmer account, no event.
    expect((await context.payouts.findById(payout.id))?.status).toBe('proposed');
    expect((await context.policies.findById(policy.id))?.status).toBe('payout_proposed');
    await expect(
      context.ledger.getAccountByCode(`farmer:${farmer.id}:insurance_payouts`)
    ).rejects.toBeInstanceOf(NotFoundException);
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).not.toContain('insurance.payout.paid');

    // Non-prod behaviour is unchanged once the guard lifts.
    vi.stubEnv('NODE_ENV', 'development');
    const paid = await context.service.confirmPayout(admin, payout.id);
    expect(paid.status).toBe('paid');
    expect(paid.execution).toBe('stub');
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


describe('payout disputes, rejection and appeals (V-42)', () => {
  /** Total-failure cell (≤20 mm → breach ratio ≥ 0.5 → 100% band). */
  async function proposedRainPayout(
    context: ReturnType<typeof makeService>
  ): Promise<{ payoutId: string; amountKobo: number }> {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 20);
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    return { payoutId: payout.id, amountKobo: payout.amountKobo };
  }

  it('lets the policy holder dispute a proposed payout and freezes confirmation', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    const disputed = await context.service.disputePayout(farmer, payoutId, 'Rainfall gauge misread');
    expect(disputed.status).toBe('disputed');
    expect(disputed.disputeReason).toBe('Rainfall gauge misread');
    expect(disputed.disputedAt).toBeTruthy();
    // Frozen: a disputed payout cannot be confirmed PAID.
    await expect(context.service.confirmPayout(admin, payoutId)).rejects.toBeInstanceOf(
      ConflictException
    );
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).toContain('insurance.payout.disputed');
  });

  it('rejects disputes from other farmers and on non-proposed payouts', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    await expect(
      context.service.disputePayout(otherFarmer, payoutId, 'not mine')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await context.service.confirmPayout(admin, payoutId);
    await expect(
      context.service.disputePayout(farmer, payoutId, 'too late — already paid')
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('enforces the appeal window on disputes', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      await expect(
        context.service.disputePayout(farmer, payoutId, 'late dispute')
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an erroneous proposal with an auditable record', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    const rejected = await context.service.rejectPayout(admin, payoutId, 'Trigger event evidence corrupted');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('Trigger event evidence corrupted');
    expect(rejected.rejectedAt).toBeTruthy();
    const auditCall = context.audit.record.mock.calls.find(
      (call) => call[0]?.action === 'insurance.payout.rejected'
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0]?.metadata?.reason).toBe('Trigger event evidence corrupted');
    const stored = await context.payouts.findById(payoutId);
    expect(stored?.status).toBe('rejected'); // row retained, not deleted
    await expect(
      context.service.rejectPayout(farmer, payoutId, 'farmer cannot reject')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows appeal of a rejected payout within the window, rejects late appeals', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    await context.service.rejectPayout(admin, payoutId, 'bad evidence');
    const appealed = await context.service.appealPayout(farmer, payoutId, 'corrected gauge data attached');
    expect(appealed.status).toBe('appealed');
    expect(appealed.appealedAt).toBeTruthy();

    const context2 = makeService();
    const { payoutId: payout2 } = await proposedRainPayout(context2);
    await context2.service.rejectPayout(admin, payout2, 'bad evidence');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      await expect(
        context2.service.appealPayout(farmer, payout2, 'late appeal')
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-evaluates a disputed payout with corrected evidence and posts a balanced correcting leg', async () => {
    const context = makeService();
    // Total rainfall failure (0 mm) → 100% band → 1,000,000 kobo proposed.
    const { payoutId, amountKobo } = await proposedRainPayout(context);
    expect(amountKobo).toBe(1_000_000);
    await context.service.disputePayout(farmer, payoutId, 'gauge missed 30 mm');

    // Corrected evidence: 30 mm observed → breach ratio 0.25 → 60% band.
    const reproposed = await context.service.reevaluatePayout(admin, payoutId, {
      observedValue: 30,
      notes: 'NPWC corrected gauge dump'
    });
    expect(reproposed.status).toBe('proposed');
    expect(reproposed.amountKobo).toBe(600_000);
    expect(reproposed.reevaluatedAt).toBeTruthy();
    // Balanced clawback leg: 400,000 kobo back off claims payable/expense.
    const entries = await context.ledger.entriesForAccount('insurer:claims_payable');
    const correction = entries.find(
      (entry) => entry.referenceType === 'insurance_payout_reevaluation'
    );
    expect(correction).toBeDefined();
    const debits = correction!.postings.filter((p) => p.direction === 'debit');
    const credits = correction!.postings.filter((p) => p.direction === 'credit');
    expect(debits.reduce((sum, p) => sum + p.amountKobo, 0)).toBe(400_000);
    expect(credits.reduce((sum, p) => sum + p.amountKobo, 0)).toBe(400_000);
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).toContain('insurance.payout.reproposed');
    // The re-proposed payout is confirmable again at the corrected amount.
    const paid = await context.service.confirmPayout(admin, payoutId);
    expect(paid.amountKobo).toBe(600_000);
  });

  it('rejects the payout when corrected evidence clears the breach', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    await context.service.disputePayout(farmer, payoutId, 'gauge wrong');
    const rejected = await context.service.reevaluatePayout(admin, payoutId, {
      observedValue: 55 // above the 40 mm deficit threshold → no breach
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toContain('trigger conditions not met');
    expect(rejected.reevaluatedAt).toBeTruthy();
  });

  it('restricts re-evaluation to admins and to disputed/appealed payouts', async () => {
    const context = makeService();
    const { payoutId } = await proposedRainPayout(context);
    await expect(
      context.service.reevaluatePayout(farmer, payoutId, { observedValue: 30 })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      context.service.reevaluatePayout(admin, payoutId, { observedValue: 30 })
    ).rejects.toBeInstanceOf(ConflictException); // still 'proposed', not disputed
  });

  it('proposes an ex-gratia payout for a loss the trigger missed (basis-risk valve)', async () => {
    const context = makeService();
    // Clear-weather policy: trigger never fires, but the crop still failed.
    const coords = await scanRainfallCell((totalMm) => totalMm > 40);
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    expect(await context.payouts.all()).toHaveLength(0);
    const [policy] = await context.policies.all();

    const payout = await context.service.proposeExGratiaPayout(admin, {
      policyId: policy.id,
      amountKobo: 200_000,
      reason: 'Field-verified crop failure with no trigger breach (basis risk)'
    });
    expect(payout.status).toBe('proposed');
    expect(payout.origin).toBe('ex_gratia');
    expect(payout.triggerEventId).toBeUndefined();
    expect(payout.ledgerProposalEntryId).toBeTruthy();
    // It walks the same rail as parametric payouts.
    const paid = await context.service.confirmPayout(admin, payout.id);
    expect(paid.status).toBe('paid');
    const auditCall = context.audit.record.mock.calls.find(
      (call) => call[0]?.action === 'insurance.payout.ex_gratia_proposed'
    );
    expect(auditCall).toBeDefined();
  });

  it('bounds ex-gratia payouts by the sum insured and requires admin + reason', async () => {
    const context = makeService();
    const coords = await scanRainfallCell((totalMm) => totalMm > 40);
    await activeRainPolicy(context, coords); // sumInsured 1,000,000
    const [policy] = await context.policies.all();
    await expect(
      context.service.proposeExGratiaPayout(admin, {
        policyId: policy.id,
        amountKobo: 1_000_001,
        reason: 'too much'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      context.service.proposeExGratiaPayout(farmer, {
        policyId: policy.id,
        amountKobo: 10_000,
        reason: 'farmer cannot'
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      context.service.proposeExGratiaPayout(admin, {
        policyId: policy.id,
        amountKobo: 10_000,
        reason: '  '
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('payout settlement confirmation (V-43)', () => {
  async function paidPayout(context: ReturnType<typeof makeService>) {
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    await context.service.confirmPayout(admin, payout.id);
    return context.payouts.findById(payout.id);
  }

  it('keeps a paid payout UNSETTLED until rail confirmation arrives', async () => {
    const context = makeService();
    const payout = (await paidPayout(context))!;
    expect(payout.status).toBe('paid');
    expect(payout.settledAt).toBeUndefined();

    // Solvency tracking: the paid-but-unsettled obligation is visible.
    const before = await context.service.insurerPortfolio();
    expect(before.unsettledPayoutKobo).toBe(payout.amountKobo);

    const settled = await context.service.confirmSettlement(admin, payout.id, 'rail-ref-001');
    expect(settled.status).toBe('settled');
    expect(settled.settlementReference).toBe('rail-ref-001');
    expect(settled.settledAt).toBeTruthy();

    const after = await context.service.insurerPortfolio();
    expect(after.unsettledPayoutKobo).toBe(0);
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).toContain('insurance.payout.settled');
  });

  it('never settles from the ledger posting alone: proposed/paid guards + reference required', async () => {
    const context = makeService();
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    // Proposed payouts cannot settle (no settlement leg booked yet).
    await expect(
      context.service.confirmSettlement(admin, payout.id, 'rail-ref-x')
    ).rejects.toBeInstanceOf(ConflictException);
    await context.service.confirmPayout(admin, payout.id);
    // A rail confirmation reference is mandatory.
    await expect(
      context.service.confirmSettlement(admin, payout.id, ' ')
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed in production: the stub rail cannot produce a confirmation (503)', async () => {
    const context = makeService();
    const payout = (await paidPayout(context))!;
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      context.service.confirmSettlement(admin, payout.id, 'rail-ref-prod')
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Nothing persisted: payout remains paid-unsettled, no settled event.
    expect((await context.payouts.findById(payout.id))?.status).toBe('paid');
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).not.toContain('insurance.payout.settled');
  });

  it('reverses the settlement leg and re-queues on rail failure; retry posts a FRESH leg', async () => {
    const context = makeService();
    const payout = (await paidPayout(context))!;
    const farmerAccount = `farmer:${farmer.id}:insurance_payouts`;
    const paidBalance = await context.ledger.balance(farmerAccount);
    expect(paidBalance.creditsKobo - paidBalance.debitsKobo).toBe(payout.amountKobo);

    const requeued = await context.service.recordSettlementFailure(
      admin,
      payout.id,
      'rail returned INSUFFICIENT_FUNDS'
    );
    expect(requeued.status).toBe('proposed');
    expect(requeued.settlementAttempts).toBe(1);
    expect(requeued.settlementFailureReason).toBe('rail returned INSUFFICIENT_FUNDS');
    // The reversal zeroes the farmer-facing credit.
    const reversedBalance = await context.ledger.balance(farmerAccount);
    expect(reversedBalance.creditsKobo - reversedBalance.debitsKobo).toBe(0);
    const names = (await context.outbox.list()).map((entry) => entry.name);
    expect(names).toContain('insurance.payout.settlement_failed');

    // Retry: a fresh settlement entry lands (no replay of the reversed one).
    const repaid = await context.service.confirmPayout(admin, payout.id);
    expect(repaid.status).toBe('paid');
    expect(repaid.ledgerSettlementEntryId).not.toBe(payout.ledgerSettlementEntryId);
    const repaidBalance = await context.ledger.balance(farmerAccount);
    expect(repaidBalance.creditsKobo - repaidBalance.debitsKobo).toBe(payout.amountKobo);

    const settled = await context.service.confirmSettlement(admin, payout.id, 'rail-ref-retry');
    expect(settled.status).toBe('settled');
  });

  it('rejects settlement-failure recording on non-paid payouts', async () => {
    const context = makeService();
    const coords = await scanRainfallCell((totalMm) => totalMm <= 40);
    await activeRainPolicy(context, coords);
    await context.service.evaluateTriggers(admin);
    const [payout] = await context.payouts.all();
    await expect(
      context.service.recordSettlementFailure(admin, payout.id, 'too early')
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
