import { describe, expect, it } from 'vitest';
import {
  adjustScore,
  aggregateFeedback,
  feedbackMultiplier,
  ownActions,
  OWN_CLICK_BOOST,
  OWN_DISMISSAL_PENALTY,
  smoothedCtr
} from './recommendation-feedback.js';

describe('smoothedCtr', () => {
  it('is neutral (0.5) for unseen items with the default Beta(1,1) prior', () => {
    expect(smoothedCtr(0, 0)).toBeCloseTo(0.5, 10);
  });

  it('smooths a single click toward the prior instead of jumping to 1', () => {
    // (1 + 1) / (1 + 0 + 2) = 2/3 — not 1.0.
    expect(smoothedCtr(1, 0)).toBeCloseTo(2 / 3, 10);
  });

  it('converges to the empirical rate as evidence accumulates', () => {
    expect(smoothedCtr(90, 10)).toBeCloseTo(91 / 102, 10);
  });
});

describe('feedbackMultiplier', () => {
  it('is neutral (1.0) for unseen items', () => {
    expect(feedbackMultiplier({ clicks: 0, dismissals: 0 })).toBeCloseTo(1, 10);
  });

  it('boosts well-liked items above 1 and penalises dismissed items below 1', () => {
    expect(feedbackMultiplier({ clicks: 100, dismissals: 10 })).toBeGreaterThan(1);
    expect(feedbackMultiplier({ clicks: 10, dismissals: 100 })).toBeLessThan(1);
  });

  it('ranks an established good item above a brand-new perfect item (Bayesian smoothing)', () => {
    const established = feedbackMultiplier({ clicks: 100, dismissals: 10 });
    const brandNew = feedbackMultiplier({ clicks: 1, dismissals: 0 });
    expect(established).toBeGreaterThan(brandNew);
  });
});

describe('adjustScore', () => {
  it('applies the global multiplier to the base score', () => {
    // multiplier = 0.5 + (10+1)/(10+0+2) = 0.5 + 11/12
    const adjusted = adjustScore(10, { clicks: 10, dismissals: 0 });
    expect(adjusted).toBeCloseTo(10 * (0.5 + 11 / 12), 3);
  });

  it('own click boosts the score by OWN_CLICK_BOOST', () => {
    const adjusted = adjustScore(10, { clicks: 0, dismissals: 0 }, 'clicked');
    expect(adjusted).toBeCloseTo(10 * OWN_CLICK_BOOST, 3);
  });

  it('own dismissal divides the score by OWN_DISMISSAL_PENALTY', () => {
    const adjusted = adjustScore(10, { clicks: 0, dismissals: 0 }, 'dismissed');
    expect(adjusted).toBeCloseTo(10 / OWN_DISMISSAL_PENALTY, 3);
  });
});

describe('aggregateFeedback / ownActions', () => {
  const events = [
    { itemType: 'course', itemId: 'c1', action: 'clicked' as const, createdAt: '2026-08-01T10:00:00.000Z' },
    { itemType: 'course', itemId: 'c1', action: 'clicked' as const, createdAt: '2026-08-01T11:00:00.000Z' },
    { itemType: 'course', itemId: 'c1', action: 'dismissed' as const, createdAt: '2026-08-01T12:00:00.000Z' },
    { itemType: 'listing', itemId: 'l1', action: 'dismissed' as const, createdAt: '2026-08-01T09:00:00.000Z' }
  ];

  it('folds events into per-item aggregates keyed by type:id', () => {
    const aggregates = aggregateFeedback(events);
    expect(aggregates.get('course:c1')).toEqual({ clicks: 2, dismissals: 1 });
    expect(aggregates.get('listing:l1')).toEqual({ clicks: 0, dismissals: 1 });
  });

  it('most recent event wins for own actions', () => {
    const actions = ownActions(events);
    expect(actions.get('course:c1')).toBe('dismissed');
    expect(actions.get('listing:l1')).toBe('dismissed');
  });
});
