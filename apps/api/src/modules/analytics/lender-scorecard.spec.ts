/**
 * Lender Lens unit tests (Stage 27, innovation #20):
 *   - known-answer scorecard assembly from fixture facts (PAR values reuse
 *     the shared modules/credit/par.ts accumulation);
 *   - version pinning: the same facts + a stored old-version definition
 *     reproduce the old payload byte-for-byte (identical payload_hash);
 *   - k-anonymity benchmark suppression (<5 lenders -> cell suppressed);
 *   - farmer-PII denylist enforcement on payload keys.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPayloadHasNoPii,
  assembleScorecard,
  canonicalJson,
  computeBenchmarkCells,
  DEFAULT_SCORECARD_DEFINITION,
  normalizeDefinition,
  periodEnd,
  scorecardPayloadHash,
  type ScorecardLoanFact
} from './lender-scorecard.js';

const PERIOD = '2026-08';
// Lagos (UTC+1) end of August 2026, exclusive: 2026-09-01T00:00+01:00.
const AS_OF_ISO = '2026-08-31T23:00:00.000Z';

/**
 * Fixture facts (zero PII — join keys resolved by the service layer):
 *  L1 Kaduna prod-inputs repaying: one paid, one unpaid installment overdue
 *     47 days at period end -> PAR30 yes, PAR60 no.
 *  L2 Kano prod-cash disbursed: unpaid installments, at most 1 day overdue.
 *  L3 Kaduna prod-inputs defaulted: 200_000 kobo defaulted stock.
 *  L4 created after the period -> excluded.
 */
const FACTS: ScorecardLoanFact[] = [
  {
    productId: 'prod-inputs',
    borrowerState: 'Kaduna',
    status: 'repaying',
    createdAt: '2026-05-10T08:00:00.000Z',
    repayments: [
      {
        dueAt: '2026-06-15T00:00:00.000Z',
        amountKobo: 100_000,
        status: 'paid',
        paidAt: '2026-06-14T10:00:00.000Z'
      },
      { dueAt: '2026-07-15T00:00:00.000Z', amountKobo: 100_000, status: 'pending' }
    ]
  },
  {
    productId: 'prod-cash',
    borrowerState: 'Kano',
    status: 'disbursed',
    createdAt: '2026-07-01T08:00:00.000Z',
    repayments: [
      { dueAt: '2026-08-30T00:00:00.000Z', amountKobo: 50_000, status: 'pending' },
      { dueAt: '2026-09-30T00:00:00.000Z', amountKobo: 50_000, status: 'pending' }
    ]
  },
  {
    productId: 'prod-inputs',
    borrowerState: 'Kaduna',
    status: 'defaulted',
    createdAt: '2026-04-01T08:00:00.000Z',
    repayments: [{ dueAt: '2026-05-01T00:00:00.000Z', amountKobo: 200_000, status: 'pending' }]
  },
  {
    productId: 'prod-cash',
    borrowerState: 'Kano',
    status: 'disbursed',
    createdAt: '2026-09-05T08:00:00.000Z',
    repayments: [{ dueAt: '2026-10-01T00:00:00.000Z', amountKobo: 10_000, status: 'pending' }]
  }
];

describe('lender scorecard assembly (known answer)', () => {
  const payload = assembleScorecard(
    DEFAULT_SCORECARD_DEFINITION,
    'lender-a',
    '1.0.0',
    PERIOD,
    FACTS
  );

  it('pins the period end to the Lagos calendar month end', () => {
    expect(periodEnd(PERIOD).toISOString()).toBe(AS_OF_ISO);
    expect(payload.dataAsOf).toBe(AS_OF_ISO);
  });

  it('assembles the exact expected payload', () => {
    expect(payload).toEqual({
      schema: 'lender-scorecard/1',
      version: '1.0.0',
      period: PERIOD,
      lenderPartnerId: 'lender-a',
      dataAsOf: AS_OF_ISO,
      portfolio: {
        activeLoans: 2,
        defaultedLoans: 1,
        outstandingKobo: 200_000,
        defaultedKobo: 200_000,
        par30Kobo: 100_000,
        par60Kobo: 0,
        par90Kobo: 0,
        par30Bps: 5000,
        par60Bps: 0,
        par90Bps: 0
      },
      vintages: [
        { cohort: '2026-04', activeLoans: 0, outstandingKobo: 0, par30Bps: 0, par60Bps: 0, par90Bps: 0 },
        {
          cohort: '2026-05',
          activeLoans: 1,
          outstandingKobo: 100_000,
          par30Bps: 10_000,
          par60Bps: 0,
          par90Bps: 0
        },
        {
          cohort: '2026-07',
          activeLoans: 1,
          outstandingKobo: 100_000,
          par30Bps: 0,
          par60Bps: 0,
          par90Bps: 0
        }
      ],
      geoMix: [
        { band: 'Kaduna', outstandingKobo: 100_000, shareBps: 5000 },
        { band: 'Kano', outstandingKobo: 100_000, shareBps: 5000 }
      ],
      productMix: [
        { band: 'prod-cash', outstandingKobo: 100_000, shareBps: 5000 },
        { band: 'prod-inputs', outstandingKobo: 100_000, shareBps: 5000 }
      ]
    });
  });

  it('is deterministic: same facts -> identical canonical JSON and hash', () => {
    const again = assembleScorecard(
      DEFAULT_SCORECARD_DEFINITION,
      'lender-a',
      '1.0.0',
      PERIOD,
      FACTS
    );
    expect(canonicalJson(again)).toBe(canonicalJson(payload));
    expect(scorecardPayloadHash(again)).toBe(scorecardPayloadHash(payload));
    // Known-answer hash (recomputed whenever the v1 definition changes).
    expect(scorecardPayloadHash(payload)).toBe(
      'f48b9793a9dea096c73b8d98fed27de0f1877db981fad319a60a5f6acb3ad486'
    );
  });

  it('excludes loans created after the period end', () => {
    // L4 (2026-09) contributes nowhere: totals above exclude its 10_000 kobo.
    expect(payload.portfolio.activeLoans).toBe(2);
    expect(payload.productMix.map((band) => band.outstandingKobo)).toEqual([100_000, 100_000]);
  });

  it('treats a repayment paid after the period as unpaid at period end', () => {
    const facts: ScorecardLoanFact[] = [
      {
        productId: 'prod-cash',
        borrowerState: 'Kano',
        status: 'repaying',
        createdAt: '2026-05-01T08:00:00.000Z',
        repayments: [
          {
            dueAt: '2026-06-01T00:00:00.000Z',
            amountKobo: 40_000,
            status: 'paid',
            paidAt: '2026-09-02T09:00:00.000Z' // after the 2026-08 period end
          }
        ]
      }
    ];
    const result = assembleScorecard(DEFAULT_SCORECARD_DEFINITION, 'lender-a', '1.0.0', PERIOD, facts);
    expect(result.portfolio.outstandingKobo).toBe(40_000);
    expect(result.portfolio.par30Bps).toBe(10_000);
  });
});

describe('version pinning', () => {
  it('reproduces an old-version payload from its stored definition', () => {
    const v1 = normalizeDefinition({ geoMixFloorBps: 0 });
    const v2 = normalizeDefinition({ geoMixFloorBps: 10_000 });
    const oldPayload = assembleScorecard(v1, 'lender-a', '1.0.0', PERIOD, FACTS);
    const newPayload = assembleScorecard(v2, 'lender-a', '2.0.0', PERIOD, FACTS);
    // The definition change is observable: with a 100% floor every named
    // band folds into 'other'/'unknown'.
    expect(newPayload.geoMix).toEqual([{ band: 'other', outstandingKobo: 200_000, shareBps: 10_000 }]);
    expect(scorecardPayloadHash(newPayload)).not.toBe(scorecardPayloadHash(oldPayload));
    // Reproducibility: replaying with the stored v1 definition is identical.
    const replayed = assembleScorecard(v1, 'lender-a', '1.0.0', PERIOD, FACTS);
    expect(scorecardPayloadHash(replayed)).toBe(scorecardPayloadHash(oldPayload));
  });

  it('rejects unsupported definitions', () => {
    expect(() => normalizeDefinition({ parWindowsDays: [7, 30, 90] })).toThrow();
    expect(() => normalizeDefinition({ kAnonymityFloor: 1 })).toThrow();
    expect(() => normalizeDefinition('nope')).toThrow();
  });
});

describe('k-anonymity benchmark suppression', () => {
  const scorecardsFor = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      lenderPartnerId: `lender-${index}`,
      payload: assembleScorecard(DEFAULT_SCORECARD_DEFINITION, `lender-${index}`, '1.0.0', PERIOD, FACTS)
    }));

  it('suppresses cells below the 5-lender floor', () => {
    const cells = computeBenchmarkCells(DEFAULT_SCORECARD_DEFINITION, scorecardsFor(4));
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.suppressed).toBe(true);
      expect(cell.valueBps).toBeNull();
      expect(cell.lenderCount).toBe(4);
    }
  });

  it('publishes cells at the floor with the mean value', () => {
    const cells = computeBenchmarkCells(DEFAULT_SCORECARD_DEFINITION, scorecardsFor(5));
    const par30 = cells.find((cell) => cell.metric === 'par30_bps');
    expect(par30?.suppressed).toBe(false);
    expect(par30?.valueBps).toBe(5000);
    expect(par30?.lenderCount).toBe(5);
  });

  it('honours a raised floor from the version definition', () => {
    const definition = normalizeDefinition({ kAnonymityFloor: 7 });
    const cells = computeBenchmarkCells(definition, scorecardsFor(5));
    expect(cells.every((cell) => cell.suppressed)).toBe(true);
  });
});

describe('farmer-PII denylist', () => {
  it('accepts the assembled payload (aggregate keys only)', () => {
    const payload = assembleScorecard(
      DEFAULT_SCORECARD_DEFINITION,
      'lender-a',
      '1.0.0',
      PERIOD,
      FACTS
    );
    expect(() => assertPayloadHasNoPii(payload)).not.toThrow();
  });

  it('rejects payloads carrying farmer identifiers at any depth', () => {
    expect(() =>
      assertPayloadHasNoPii({ portfolio: { farmerId: 'u-1' } })
    ).toThrow(/denylist/);
    expect(() =>
      assertPayloadHasNoPii({ vintages: [{ cohort: '2026-05', borrowerPhone: '0803' }] })
    ).toThrow(/denylist/);
    expect(() => assertPayloadHasNoPii({ meta: { nin: '123' } })).toThrow(/denylist/);
  });
});
