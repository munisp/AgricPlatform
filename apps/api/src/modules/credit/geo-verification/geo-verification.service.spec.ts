import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreditLoanApplication, FarmPlot, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import {
  createInMemoryCreditCollateralRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGroupRepository,
  createInMemoryCreditGuarantorRepository,
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditRestructureRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository,
  InMemoryCreditLoanRepository,
  InMemoryCreditProductRepository
} from '../../../database/repositories/credit-suite.repository.js';
import { createInMemoryFarmPlotRepository } from '../../../database/repositories/farms.repository.js';
import { createInMemoryGeoCreditShadowRepository } from '../../../database/repositories/geo-credit-shadow.repository.js';
import { InMemoryOrderRepository } from '../../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../../database/repositories/outbox.repository.js';
import { InMemoryProfileRepository } from '../../../database/repositories/profile.repository.js';
import { CreditService } from '../credit.service.js';
import { StubFloodRiskDriver } from '../../geo-intel/flood-risk.drivers.js';
import { StubCropIntelClient } from './crop-intel.drivers.js';
import { computeGeoCreditFactor, floodBandFromSeverity } from './geo-credit-factor.js';
import { deriveSeasonForDate, GeoVerificationService } from './geo-verification.service.js';

const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };
const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };

const ENV_KEYS = [
  'GEO_CREDIT_MODE',
  'CROP_ML_DRIVER',
  'CROP_ML_URL',
  'FLOOD_ML_DRIVER',
  'FLOOD_ML_URL',
  'NODE_ENV',
  'SHADOW_FIXTURES'
];
let savedEnv: Record<string, string | undefined> = {};

function loan(overrides: Partial<CreditLoanApplication> = {}): CreditLoanApplication {
  return {
    id: 'cla-1',
    applicantUserId: farmer.id!,
    productId: 'cprd-seasonal',
    principalKobo: 1_000_000,
    status: 'submitted',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides
  };
}

function plot(overrides: Partial<FarmPlot> = {}): FarmPlot {
  return {
    id: 'plot-1',
    ownerUserId: farmer.id!,
    name: 'Zaria North Plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.0855,
    centroidLong: 7.7199,
    sizeHectares: 2.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-20T00:00:00.000Z',
    version: 1,
    ...overrides
  };
}

function makeService(plots: FarmPlot[] = [plot()], loans: CreditLoanApplication[] = [loan()]) {
  const loanRepo = createInMemoryCreditLoanRepository();
  for (const item of loans) void loanRepo.create(item);
  const plotRepo = createInMemoryFarmPlotRepository(plots);
  const shadow = createInMemoryGeoCreditShadowRepository();
  const service = new GeoVerificationService(loanRepo, plotRepo, shadow);
  return { service, loanRepo, plotRepo, shadow };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.GEO_CREDIT_MODE;
  delete process.env.CROP_ML_DRIVER;
  delete process.env.CROP_ML_URL;
  delete process.env.FLOOD_ML_DRIVER;
  delete process.env.FLOOD_ML_URL;
  delete process.env.NODE_ENV;
  delete process.env.SHADOW_FIXTURES;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('deriveSeasonForDate (GAP-C02)', () => {
  it('maps April–October to the wet season and November–March to dry', () => {
    expect(deriveSeasonForDate('2026-04-01T00:00:00.000Z')).toBe('2026-wet');
    expect(deriveSeasonForDate('2026-10-31T23:59:59.000Z')).toBe('2026-wet');
    expect(deriveSeasonForDate('2026-06-15T12:00:00.000Z')).toBe('2026-wet');
    expect(deriveSeasonForDate('2026-11-01T00:00:00.000Z')).toBe('2026-dry');
    expect(deriveSeasonForDate('2026-03-01T00:00:00.000Z')).toBe('2026-dry');
    expect(deriveSeasonForDate('2026-01-15T00:00:00.000Z')).toBe('2026-dry');
    expect(deriveSeasonForDate('2026-12-31T00:00:00.000Z')).toBe('2026-dry');
  });

  it('always produces a value matching the crop-ml season pattern', () => {
    const pattern = /^\d{4}(-(wet|dry))?$/;
    for (let month = 0; month < 12; month += 1) {
      const iso = new Date(Date.UTC(2026, month, 15)).toISOString();
      expect(deriveSeasonForDate(iso)).toMatch(pattern);
    }
  });
});

describe('GeoVerificationService.computeForApplication (stub providers)', () => {
  it('computes a shadow factor matching the pure function, labelled stub/stub', async () => {
    const { service } = makeService();
    const now = '2026-03-01T00:00:00.000Z';
    const result = await service.computeForApplication(loan(), now);
    expect(result.status).toBe('computed');
    expect(result.basis).toEqual({ flood: 'stub', crop: 'stub' });
    // Known-answer: rebuild the expected result from the same deterministic
    // stub providers (flood stub for the plot centroid, crop stub for the
    // plot id) through the pure factor.
    const flood = await new StubFloodRiskDriver().assess({ latitude: 11.0855, longitude: 7.7199 });
    const crop = await new StubCropIntelClient().assessPlot({
      plotId: 'plot-1',
      // The service derives the season from `now` (2026-03-01 → dry season).
      season: deriveSeasonForDate(now)
    });
    const expected = computeGeoCreditFactor(
      {
        plotVerified: true,
        areaHectares: 2.5,
        floodBand: floodBandFromSeverity(flood.severity),
        cropHealthScore: crop.healthScore,
        plotUpdatedAt: plot().updatedAt
      },
      now
    );
    expect(result.breakdown).toEqual(expected.breakdown);
    expect(result.factorScore).toBe(expected.score);
    expect(result.factorScore).toBeGreaterThan(0);
    expect(result.computedAt).toBe(now);
  });

  it('applicant without plots scores 0 with every component at 0', async () => {
    const { service } = makeService([]);
    const result = await service.computeForApplication(loan());
    expect(result.status).toBe('computed');
    expect(result.factorScore).toBe(0);
    expect(result.breakdown).toEqual({
      plotVerification: 0,
      areaPlausibility: 0,
      floodRisk: 0,
      cropHealth: 0,
      dataFreshness: 0
    });
  });

  it('only considers plots owned by the applicant', async () => {
    const { service } = makeService([plot({ ownerUserId: 'user-other' })]);
    const result = await service.computeForApplication(loan());
    expect(result.factorScore).toBe(0);
  });

  it('picks the earliest-registered plot deterministically', async () => {
    const older = plot({ id: 'plot-b', createdAt: '2025-01-01T00:00:00.000Z', sizeHectares: 9 });
    const newer = plot({ id: 'plot-a', createdAt: '2026-01-01T00:00:00.000Z', sizeHectares: 0.001 });
    const { service } = makeService([newer, older]);
    const first = await service.computeForApplication(loan(), '2026-03-01T00:00:00.000Z');
    const second = await service.computeForApplication(loan(), '2026-03-01T00:00:00.000Z');
    expect(first).toEqual(second);
    // The 9 ha older plot wins; the 0.001 ha newer one would fail plausibility.
    expect(first.breakdown.areaPlausibility).toBe(15);
  });

  it('is deterministic end-to-end: same repositories → same score and fingerprint', async () => {
    const a = makeService();
    const b = makeService();
    const now = '2026-03-01T00:00:00.000Z';
    const first = await a.service.computeForApplication(loan(), now);
    const second = await b.service.computeForApplication(loan(), now);
    expect(first.factorScore).toBe(second.factorScore);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
  });
});

describe('GeoVerificationService.getShadowScore (read path)', () => {
  it('rejects non-reviewers', async () => {
    const { service } = makeService();
    await expect(service.getShadowScore('cla-1', farmer)).rejects.toThrow(ForbiddenException);
  });

  it('allows lenders, computes on first access and persists to the shadow store only', async () => {
    const { service, shadow } = makeService();
    const result = await service.getShadowScore('cla-1', lender);
    expect(result.status).toBe('computed');
    const stored = await shadow.all();
    expect(stored).toHaveLength(1);
    expect(stored[0].applicationId).toBe('cla-1');
  });

  it('serves the persisted row on repeat access without recomputation', async () => {
    const { service, shadow } = makeService();
    const first = await service.getShadowScore('cla-1', admin);
    const second = await service.getShadowScore('cla-1', admin);
    expect(second).toMatchObject(first);
    expect(await shadow.all()).toHaveLength(1);
  });

  it('answers 404 when GEO_CREDIT_MODE=off', async () => {
    process.env.GEO_CREDIT_MODE = 'off';
    const { service } = makeService();
    await expect(service.getShadowScore('cla-1', admin)).rejects.toThrow(NotFoundException);
  });
});

describe('fail-closed live providers', () => {
  it('crop-ml configured but unreachable → status unavailable, basis honest, NO stub substitution', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://127.0.0.1:1'; // connection refused
    const { service } = makeService();
    const result = await service.computeForApplication(loan());
    expect(result.status).toBe('unavailable');
    expect(result.basis.crop).toBe('unavailable');
    expect(result.factorScore).toBeNull();
  });

  it('on-demand shadow read answers 503 and persists nothing when live crop-ml is down', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://127.0.0.1:1';
    const { service, shadow } = makeService();
    await expect(service.getShadowScore('cla-1', admin)).rejects.toThrow(
      ServiceUnavailableException
    );
    expect(await shadow.all()).toHaveLength(0);
  });

  it('CROP_ML_DRIVER=http without CROP_ML_URL fails closed the same way', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    const { service } = makeService();
    const result = await service.computeForApplication(loan());
    expect(result.status).toBe('unavailable');
    expect(result.basis.crop).toBe('unavailable');
  });

  it('flood-ml configured but unreachable fails closed with 503', async () => {
    process.env.FLOOD_ML_DRIVER = 'http';
    process.env.FLOOD_ML_URL = 'http://127.0.0.1:1';
    const { service } = makeService();
    await expect(service.getShadowScore('cla-1', admin)).rejects.toThrow(
      ServiceUnavailableException
    );
  });
});

describe('live crop-ml contract (GAP-C01/GAP-C02)', () => {
  /** Realistic sidecar payload — mirrors services/crop-ml/app/models.py. */
  const SIDECAR_RESPONSE = {
    plot_id: 'plot-1',
    season: '2026-dry',
    provider: 'live',
    seasonality: {
      plot_id: 'plot-1',
      acquisitions: 10,
      ndvi: [{ date: '2026-01-10', ndvi: 0.4 }],
      phenology: {
        sos_date: '2025-11-10',
        eos_date: '2026-03-01',
        peak_date: '2026-01-05',
        peak_value: 0.78,
        base_value: 0.19,
        amplitude: 0.59,
        season_length_days: 111
      },
      mean_ndvi: 0.52,
      reference_phenology: null,
      classification: { label: 'normal', reason_codes: ['within_baseline'] }
    },
    health: {
      plot_id: 'plot-1',
      score: 72,
      drivers: [{ code: 'ndvi_deficit', impact: 10, detail: 'mean NDVI below baseline' }],
      current_phenology: {
        sos_date: '2025-11-10',
        eos_date: '2026-03-01',
        peak_date: '2026-01-05',
        peak_value: 0.78,
        base_value: 0.19,
        amplitude: 0.59,
        season_length_days: 111
      },
      baseline_phenology: {
        sos_date: '2025-11-01',
        eos_date: '2026-03-05',
        peak_date: '2026-01-01',
        peak_value: 0.82,
        base_value: 0.18,
        amplitude: 0.64,
        season_length_days: 124
      }
    }
  };

  it('sends a derived season and maps the real response into the shadow factor', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://crop-ml.test';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SIDECAR_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { service } = makeService();
    const now = '2026-03-01T00:00:00.000Z'; // March → 2026-dry
    const result = await service.computeForApplication(loan(), now);

    // GAP-C02: a valid season is sent to the sidecar.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://crop-ml.test/v1/crop/assess-plot');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      plot_id: 'plot-1',
      season: '2026-dry'
    });

    // GAP-C01: the real health.score drives the factor — no 0/stressed/stub
    // degradation and honest live provenance.
    expect(result.status).toBe('computed');
    expect(result.basis.crop).toBe('live');
    expect(result.breakdown.cropHealth).toBe(Math.round((72 / 100) * 30));
    expect(result.factorScore).toBeGreaterThan(0);
  });

  it('fails closed (status unavailable) when the sidecar payload is malformed', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://crop-ml.test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ plot_id: 'plot-1', provider: 'live' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    const { service } = makeService();
    const result = await service.computeForApplication(loan(), '2026-03-01T00:00:00.000Z');
    expect(result.status).toBe('unavailable');
    expect(result.basis.crop).toBe('unavailable');
    expect(result.factorScore).toBeNull();
  });
});

describe('GeoVerificationService.recomputeOpenApplications (batch)', () => {
  it('rejects non-admins', async () => {
    const { service } = makeService();
    await expect(service.recomputeOpenApplications(lender)).rejects.toThrow(ForbiddenException);
  });

  it('recomputes open applications only and is idempotent per input fingerprint', async () => {
    const loans = [
      loan({ id: 'cla-open-1', status: 'submitted' }),
      loan({ id: 'cla-open-2', status: 'scoring' }),
      loan({ id: 'cla-open-3', status: 'approved' }),
      loan({ id: 'cla-closed', status: 'disbursed' }),
      loan({ id: 'cla-rejected', status: 'rejected' })
    ];
    const { service, shadow } = makeService([plot()], loans);
    const first = await service.recomputeOpenApplications(admin);
    expect(first.applications).toBe(3);
    expect(first.recomputed).toBe(3);
    expect(first.skipped).toBe(0);
    expect(await shadow.all()).toHaveLength(3);

    const second = await service.recomputeOpenApplications(admin);
    expect(second.recomputed).toBe(0);
    expect(second.skipped).toBe(3);
    expect(await shadow.all()).toHaveLength(3);
  });

  it('writes a new row when inputs change (new fingerprint)', async () => {
    const { service, shadow, plotRepo } = makeService();
    await service.recomputeOpenApplications(admin);
    // Change an input: the plot record is refreshed (freshness + fingerprint change).
    await plotRepo.update('plot-1', { updatedAt: new Date().toISOString() });
    const report = await service.recomputeOpenApplications(admin);
    expect(report.recomputed).toBe(1);
    expect(report.skipped).toBe(0);
    const rows = await shadow.all();
    expect(rows).toHaveLength(2);
    const fingerprints = new Set(rows.map((row) => row.inputFingerprint));
    expect(fingerprints.size).toBe(rows.length);
  });

  it('counts live-crop-unavailable applications without persisting scores', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://127.0.0.1:1';
    const { service, shadow } = makeService();
    const report = await service.recomputeOpenApplications(admin);
    expect(report.unavailable).toBe(1);
    expect(report.recomputed).toBe(0);
    expect(await shadow.all()).toHaveLength(0);
  });

  it('answers 404 when GEO_CREDIT_MODE=off', async () => {
    process.env.GEO_CREDIT_MODE = 'off';
    const { service } = makeService();
    await expect(service.recomputeOpenApplications(admin)).rejects.toThrow(NotFoundException);
  });
});

describe('production stub-fixture persistence gate (WP-G15)', () => {
  it('production: stub-derived shadow score is returned but NOT persisted', async () => {
    process.env.NODE_ENV = 'production';
    const { service, shadow } = makeService();
    const result = await service.getShadowScore('cla-1', admin);
    // Endpoint stays functional: the computed score is still returned...
    expect(result.status).toBe('computed');
    expect(result.basis).toEqual({ flood: 'stub', crop: 'stub' });
    // ...but no stub-fixture-derived row reaches the shadow table.
    expect(await shadow.all()).toHaveLength(0);
  });

  it('production: SHADOW_FIXTURES=true explicitly re-enables persistence', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SHADOW_FIXTURES = 'true';
    const { service, shadow } = makeService();
    const result = await service.getShadowScore('cla-1', admin);
    expect(result.status).toBe('computed');
    expect(await shadow.all()).toHaveLength(1);
  });

  it('production: batch recompute counts suppressed scores and persists nothing', async () => {
    process.env.NODE_ENV = 'production';
    const { service, shadow } = makeService();
    const report = await service.recomputeOpenApplications(admin);
    expect(report.applications).toBe(1);
    expect(report.suppressed).toBe(1);
    expect(report.recomputed).toBe(0);
    expect(await shadow.all()).toHaveLength(0);
  });

  it('non-production: stub-derived scores persist exactly as before', async () => {
    const { service, shadow } = makeService();
    const result = await service.getShadowScore('cla-1', admin);
    expect(result.basis).toEqual({ flood: 'stub', crop: 'stub' });
    expect(await shadow.all()).toHaveLength(1);
  });
});

/**
 * THE critical shadow-mode guarantee: the live decision path must produce
 * byte-identical output whether or not the geo-verification module exists
 * and has computed shadow scores for the same data.
 */
describe('decision-path neutrality (shadow mode)', () => {
  function makeCreditService(loans = new InMemoryCreditLoanRepository()) {
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const transactions = createInMemoryCreditSavingsTransactionRepository();
    return new CreditService(
      events,
      new InMemoryCreditProductRepository([
        {
          id: 'cprd-seasonal',
          name: 'Seasonal input loan',
          minPrincipalKobo: 100_000,
          maxPrincipalKobo: 5_000_000,
          interestBpsAnnual: 1200,
          termDays: 180,
          groupLending: false,
          active: true,
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]),
      loans,
      createInMemoryCreditRepaymentRepository(),
      createInMemoryCreditCollateralRepository(),
      createInMemoryCreditGuarantorRepository(),
      createInMemoryCreditGroupRepository(),
      createInMemoryCreditGroupMemberRepository(),
      createInMemoryCreditSavingsAccountRepository(transactions),
      new InMemoryProfileRepository(),
      new InMemoryOrderRepository(),
      createInMemoryCreditRestructureRepository(),
      transactions
    );
  }

  it('CreditService.score output is identical with shadow enabled vs disabled', async () => {
    // Shadow DISABLED: plain decision path.
    const creditAlone = makeCreditService();
    const draftA = await creditAlone.apply(
      { productId: 'cprd-seasonal', principalKobo: 1_000_000 },
      farmer
    );
    await creditAlone.submit(draftA.id, farmer);
    const scoredAlone = await creditAlone.score(draftA.id, lender);

    // Shadow ENABLED: geo-verification computes + persists a shadow score
    // for an equivalent application BEFORE the decision path runs.
    const { service: geo } = makeService();
    await geo.getShadowScore('cla-1', admin);

    const creditWithShadow = makeCreditService();
    const draftB = await creditWithShadow.apply(
      { productId: 'cprd-seasonal', principalKobo: 1_000_000 },
      farmer
    );
    await creditWithShadow.submit(draftB.id, farmer);
    const scoredWithShadow = await creditWithShadow.score(draftB.id, lender);

    expect(scoredWithShadow.creditScore).toBe(scoredAlone.creditScore);
    expect(scoredWithShadow.scoreFactors).toEqual(scoredAlone.scoreFactors);
    expect(scoredWithShadow.status).toBe(scoredAlone.status);
  });

  it('the decision service never references the shadow store or geo-verification module', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const decisionSource = readFileSync(join(here, '..', 'credit.service.ts'), 'utf8');
    expect(decisionSource).not.toContain('geo-verification');
    expect(decisionSource).not.toContain('GEO_CREDIT_SHADOW_REPOSITORY');
    expect(decisionSource).not.toContain('geo_credit_shadow');
  });

  it('the applications controller exposes no geo-shadow route on the decision controller', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const controllerSource = readFileSync(join(here, '..', 'applications.controller.ts'), 'utf8');
    expect(controllerSource).not.toContain('geo-shadow');
  });
});
