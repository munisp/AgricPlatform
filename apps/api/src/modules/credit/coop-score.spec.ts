import { describe, expect, it } from 'vitest';
import type { CoopScoreFactorKey } from '@agric-platform/shared';
import {
  canonicalStringify,
  computeCoopInputsHash,
  computeCoopScore,
  COOP_BAND_THRESHOLDS,
  COOP_SCORE_MAX,
  COOP_SCORE_WEIGHTS,
  coopScoreBand,
  type CoopScoreInputs
} from './coop-score.js';

/**
 * Known-answer vectors for the deterministic cooperative score (stage-27
 * Innovation 14). Every number below is computed by hand from the documented
 * weighting table in coop-score.ts; the tests pin them exactly.
 */

const FULL_INPUTS: CoopScoreInputs = {
  repayment: { loansConsidered: 5, onTimeKobo: 80_000, lateKobo: 10_000, missedKobo: 10_000 },
  vsla: { cyclesTotal: 4, cyclesClosed: 3, shareOutsPlanned: 10, shareOutsPaid: 9 },
  governance: { meetingsHeld: 6, attendanceTotal: 60, rsvpTotal: 60, windowDays: 180 },
  commercial: { escrowsReleased: 8, escrowsRefunded: 1, escrowsDisputed: 1 },
  data: { memberCount: 10, membersWithProfile: 8, membersWithPlot: 6 }
};

const EMPTY_INPUTS: CoopScoreInputs = {
  repayment: null,
  vsla: null,
  governance: null,
  commercial: null,
  data: null
};

function factorPoints(inputs: CoopScoreInputs, key: CoopScoreFactorKey) {
  return computeCoopScore(inputs).factors.find((factor) => factor.key === key)!;
}

describe('coop-score weights', () => {
  it('weight-sum invariant: the five factor weights total exactly 1000', () => {
    const total = Object.values(COOP_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(COOP_SCORE_MAX);
    expect(Object.keys(COOP_SCORE_WEIGHTS)).toHaveLength(5);
  });

  it('a perfect fully-measured cooperative scores exactly 1000 (band A)', () => {
    const perfect: CoopScoreInputs = {
      repayment: { loansConsidered: 3, onTimeKobo: 100_000, lateKobo: 0, missedKobo: 0 },
      vsla: { cyclesTotal: 4, cyclesClosed: 4, shareOutsPlanned: 10, shareOutsPaid: 10 },
      governance: { meetingsHeld: 6, attendanceTotal: 60, rsvpTotal: 60, windowDays: 180 },
      commercial: { escrowsReleased: 10, escrowsRefunded: 0, escrowsDisputed: 0 },
      data: { memberCount: 10, membersWithProfile: 10, membersWithPlot: 10 }
    };
    const result = computeCoopScore(perfect);
    expect(result.score).toBe(1000);
    expect(result.band).toBe('A');
    expect(result.factors.every((factor) => factor.basis === 'measured')).toBe(true);
  });
});

describe('coop-score known-answer factor vectors', () => {
  it('repayment track record: on-time full, late half, missed zero (kobo-weighted)', () => {
    // decided = 100_000; weighted = 80_000*1000 + 10_000*500 = 85_000_000
    // points = round(300 * 85_000_000 / 100_000_000) = 255
    const factor = factorPoints(FULL_INPUTS, 'repaymentTrackRecord');
    expect(factor.points).toBe(255);
    expect(factor.weight).toBe(300);
    expect(factor.basis).toBe('measured');
    expect(factor.summary.decidedKobo).toBe(100_000);
  });

  it('vsla cycle discipline: half completion, half share-out follow-through', () => {
    // completion = 100 * 3/4 = 75; share-out = 100 * 9/10 = 90; total 165
    const factor = factorPoints(FULL_INPUTS, 'vslaCycleDiscipline');
    expect(factor.points).toBe(165);
    expect(factor.basis).toBe('measured');
  });

  it('governance activity: cadence capped at target, attendance vs RSVPs', () => {
    // cadence = min(75, 75 * 6*30/180) = 75; attendance = 75 * 60/60 = 75
    const factor = factorPoints(FULL_INPUTS, 'governanceActivity');
    expect(factor.points).toBe(150);
    expect(factor.basis).toBe('measured');
  });

  it('commercial reliability: released full, refunded half, disputed zero', () => {
    // resolved = 10; weighted = 8*1000 + 1*500 = 8500; 200 * 8500/10_000 = 170
    const factor = factorPoints(FULL_INPUTS, 'commercialReliability');
    expect(factor.points).toBe(170);
    expect(factor.basis).toBe('measured');
  });

  it('data completeness: equal halves for profile and plot coverage', () => {
    // points = 150 * (8 + 6) / (10 * 2) = 105
    const factor = factorPoints(FULL_INPUTS, 'dataCompleteness');
    expect(factor.points).toBe(105);
    expect(factor.basis).toBe('measured');
  });

  it('composite vector: the exact sum of the five factor points, banded', () => {
    const result = computeCoopScore(FULL_INPUTS);
    expect(result.score).toBe(255 + 165 + 150 + 170 + 105);
    expect(result.score).toBe(845);
    expect(result.band).toBe('A');
  });
});

describe('coop-score sparse-data degradation', () => {
  it('null input (unreadable source module) → UNAVAILABLE, 0 points, badge set', () => {
    const result = computeCoopScore(EMPTY_INPUTS);
    expect(result.score).toBe(0);
    expect(result.band).toBe('D');
    for (const factor of result.factors) {
      expect(factor.basis).toBe('unavailable');
      expect(factor.points).toBe(0);
    }
  });

  it('small loan sample → repayment contribution bounded at half weight', () => {
    // raw would be 300 (all on time) but 2 loans < 3 minimum → cap 150
    const factor = factorPoints(
      {
        ...EMPTY_INPUTS,
        repayment: { loansConsidered: 2, onTimeKobo: 20_000, lateKobo: 0, missedKobo: 0 }
      },
      'repaymentTrackRecord'
    );
    expect(factor.basis).toBe('sparse');
    expect(factor.points).toBe(150);
  });

  it('single VSLA cycle → capped at half weight', () => {
    const factor = factorPoints(
      {
        ...EMPTY_INPUTS,
        vsla: { cyclesTotal: 1, cyclesClosed: 1, shareOutsPlanned: 5, shareOutsPaid: 5 }
      },
      'vslaCycleDiscipline'
    );
    expect(factor.basis).toBe('sparse');
    expect(factor.points).toBe(100);
  });

  it('single meeting → governance capped at half weight', () => {
    // cadence = 75 * 1*30/180 = 12.5; attendance = 75; raw 87.5 → cap 75
    const factor = factorPoints(
      {
        ...EMPTY_INPUTS,
        governance: { meetingsHeld: 1, attendanceTotal: 10, rsvpTotal: 10, windowDays: 180 }
      },
      'governanceActivity'
    );
    expect(factor.basis).toBe('sparse');
    expect(factor.points).toBe(75);
  });

  it('two resolved escrows → commercial capped at half weight', () => {
    const factor = factorPoints(
      { ...EMPTY_INPUTS, commercial: { escrowsReleased: 2, escrowsRefunded: 0, escrowsDisputed: 0 } },
      'commercialReliability'
    );
    expect(factor.basis).toBe('sparse');
    expect(factor.points).toBe(100);
  });

  it('tiny membership → data completeness capped at half weight', () => {
    const factor = factorPoints(
      { ...EMPTY_INPUTS, data: { memberCount: 2, membersWithProfile: 2, membersWithPlot: 2 } },
      'dataCompleteness'
    );
    expect(factor.basis).toBe('sparse');
    expect(factor.points).toBe(75);
  });

  it('no decided obligations at all → sparse zero, never fabricated', () => {
    const result = computeCoopScore({
      repayment: { loansConsidered: 0, onTimeKobo: 0, lateKobo: 0, missedKobo: 0 },
      vsla: { cyclesTotal: 0, cyclesClosed: 0, shareOutsPlanned: 0, shareOutsPaid: 0 },
      governance: { meetingsHeld: 0, attendanceTotal: 0, rsvpTotal: 0, windowDays: 180 },
      commercial: { escrowsReleased: 0, escrowsRefunded: 0, escrowsDisputed: 0 },
      data: { memberCount: 0, membersWithProfile: 0, membersWithPlot: 0 }
    });
    expect(result.score).toBe(0);
    expect(result.factors.every((factor) => factor.basis === 'sparse')).toBe(true);
  });
});

describe('coop-score monotonicity spot checks', () => {
  it('repayment points never decrease as missed kobo converts to on-time', () => {
    let previous = -1;
    for (let onTime = 0; onTime <= 100_000; onTime += 25_000) {
      const factor = factorPoints(
        {
          ...EMPTY_INPUTS,
          repayment: {
            loansConsidered: 4,
            onTimeKobo: onTime,
            lateKobo: 0,
            missedKobo: 100_000 - onTime
          }
        },
        'repaymentTrackRecord'
      );
      expect(factor.points).toBeGreaterThanOrEqual(previous);
      previous = factor.points;
    }
  });

  it('governance points never decrease with more meetings held', () => {
    let previous = -1;
    for (let meetings = 1; meetings <= 6; meetings += 1) {
      const factor = factorPoints(
        {
          ...EMPTY_INPUTS,
          governance: { meetingsHeld: meetings, attendanceTotal: 50, rsvpTotal: 50, windowDays: 180 }
        },
        'governanceActivity'
      );
      expect(factor.points).toBeGreaterThanOrEqual(previous);
      previous = factor.points;
    }
  });

  it('commercial points never decrease as disputes convert to releases', () => {
    let previous = -1;
    for (let released = 0; released <= 10; released += 2) {
      const factor = factorPoints(
        {
          ...EMPTY_INPUTS,
          commercial: { escrowsReleased: released, escrowsRefunded: 0, escrowsDisputed: 10 - released }
        },
        'commercialReliability'
      );
      expect(factor.points).toBeGreaterThanOrEqual(previous);
      previous = factor.points;
    }
  });
});

describe('coop-score bands', () => {
  it('band boundaries are inclusive at the documented thresholds', () => {
    expect(coopScoreBand(1000)).toBe('A');
    expect(coopScoreBand(COOP_BAND_THRESHOLDS.A)).toBe('A');
    expect(coopScoreBand(COOP_BAND_THRESHOLDS.A - 1)).toBe('B');
    expect(coopScoreBand(COOP_BAND_THRESHOLDS.B)).toBe('B');
    expect(coopScoreBand(COOP_BAND_THRESHOLDS.B - 1)).toBe('C');
    expect(coopScoreBand(COOP_BAND_THRESHOLDS.C)).toBe('C');
    expect(coopScoreBand(COOP_BAND_THRESHOLDS.C - 1)).toBe('D');
    expect(coopScoreBand(0)).toBe('D');
  });
});

describe('coop-score inputs hash (recompute idempotency)', () => {
  it('canonical stringify is key-order invariant', () => {
    expect(canonicalStringify({ b: 1, a: { d: [2, 3], c: null } })).toBe(
      canonicalStringify({ a: { c: null, d: [2, 3] }, b: 1 })
    );
  });

  it('identical inputs hash identically; any change rehashes', () => {
    const left = computeCoopInputsHash('coop-1', FULL_INPUTS);
    const reordered = computeCoopInputsHash('coop-1', {
      data: FULL_INPUTS.data,
      commercial: FULL_INPUTS.commercial,
      governance: FULL_INPUTS.governance,
      vsla: FULL_INPUTS.vsla,
      repayment: FULL_INPUTS.repayment
    });
    expect(reordered).toBe(left);

    const changed = computeCoopInputsHash('coop-1', {
      ...FULL_INPUTS,
      data: { ...FULL_INPUTS.data!, membersWithPlot: 7 }
    });
    expect(changed).not.toBe(left);

    const otherCoop = computeCoopInputsHash('coop-2', FULL_INPUTS);
    expect(otherCoop).not.toBe(left);
  });
});
