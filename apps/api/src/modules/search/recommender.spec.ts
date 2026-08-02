import { describe, expect, it } from 'vitest';
import {
  coldStartRank,
  DEFAULT_RECOMMENDER_WEIGHTS,
  emptySignals,
  isColdStart,
  rankCandidates,
  scoreCandidate,
  similarItems,
  type MemberSignals,
  type RecommendationCandidate
} from './recommender.js';

const course = (over: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
  type: 'course',
  id: 'course-1',
  title: 'Maize Agronomy 101',
  summary: 'maize',
  tags: ['maize'],
  category: 'maize',
  popularity: 40,
  ...over
});

const listing = (over: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
  type: 'listing',
  id: 'listing-1',
  title: 'Fresh maize 50kg',
  summary: '50 kg — Kano',
  tags: ['maize', 'produce'],
  crop: 'Maize',
  state: 'Kano',
  kind: 'produce',
  popularity: 1,
  ...over
});

const opportunity = (over: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
  type: 'opportunity',
  id: 'opp-1',
  title: 'Youth Agri Grant',
  summary: 'grant',
  tags: ['grains'],
  states: ['kano'],
  kind: 'grant',
  popularity: 1,
  ...over
});

const signals = (over: Partial<MemberSignals> = {}): MemberSignals => ({
  ...emptySignals(),
  ...over
});

describe('isColdStart', () => {
  it('treats empty signals as cold start', () => {
    expect(isColdStart(emptySignals())).toBe(true);
  });

  it('treats whitespace-only state as no signal', () => {
    expect(isColdStart(signals({ state: '   ' }))).toBe(true);
  });

  it('any single signal exits cold start', () => {
    expect(isColdStart(signals({ state: 'kano' }))).toBe(false);
    expect(isColdStart(signals({ crops: ['maize'] }))).toBe(false);
    expect(isColdStart(signals({ completedCourseCategories: ['agronomy'] }))).toBe(false);
    expect(isColdStart(signals({ purchasedKinds: ['produce'] }))).toBe(false);
  });
});

describe('scoreCandidate', () => {
  const w = DEFAULT_RECOMMENDER_WEIGHTS;

  it('fires same_crop when the member grows the candidate crop', () => {
    const result = scoreCandidate(signals({ crops: ['maize'] }), listing(), w);
    expect(result.reasons).toContain('same_crop');
    expect(result.score).toBeGreaterThanOrEqual(w.sameCrop);
  });

  it('fires state_match for listings in the member state', () => {
    const result = scoreCandidate(signals({ state: 'kano' }), listing(), w);
    expect(result.reasons).toContain('state_match');
  });

  it('fires state_match for opportunities covering the member state (case-insensitive)', () => {
    const result = scoreCandidate(signals({ state: 'Kano' }), opportunity(), w);
    expect(result.reasons).toContain('state_match');
  });

  it('does not fire state_match for nationwide opportunities without a member state', () => {
    const result = scoreCandidate(signals({ crops: ['maize'] }), opportunity({ states: [] }), w);
    expect(result.reasons).not.toContain('state_match');
  });

  it('fires lga_match only alongside state_match', () => {
    const withState = scoreCandidate(
      signals({ state: 'kano', lga: 'dala' }),
      listing({ tags: ['dala'] }),
      w
    );
    expect(withState.reasons).toEqual(expect.arrayContaining(['state_match', 'lga_match']));
    const withoutState = scoreCandidate(signals({ lga: 'dala' }), listing({ tags: ['dala'] }), w);
    expect(withoutState.reasons).not.toContain('lga_match');
  });

  it('fires value_chain_match when opportunity value chains overlap member value chains', () => {
    const result = scoreCandidate(signals({ valueChains: ['grains'] }), opportunity(), w);
    expect(result.reasons).toContain('value_chain_match');
  });

  it('fires completed_prerequisite for courses in a completed category', () => {
    const result = scoreCandidate(
      signals({ completedCourseCategories: ['maize'] }),
      course(),
      w
    );
    expect(result.reasons).toContain('completed_prerequisite');
    expect(result.score).toBeGreaterThanOrEqual(w.completedPrerequisite);
  });

  it('fires completed_prerequisite for courses in an in-progress category', () => {
    const result = scoreCandidate(signals({ activeCourseCategories: ['maize'] }), course(), w);
    expect(result.reasons).toContain('completed_prerequisite');
  });

  it('fires purchased_category from order history kinds and crops without duplicating the reason', () => {
    const result = scoreCandidate(
      signals({ purchasedKinds: ['produce'], purchasedCrops: ['maize'] }),
      listing(),
      w
    );
    expect(result.reasons.filter((r) => r === 'purchased_category')).toHaveLength(1);
    expect(result.score).toBeGreaterThanOrEqual(w.purchasedCategory * 2);
  });

  it('fires category_affinity for opportunity types the member applied to before', () => {
    const result = scoreCandidate(signals({ appliedOpportunityTypes: ['grant'] }), opportunity(), w);
    expect(result.reasons).toContain('category_affinity');
  });

  it('score is the additive sum of fired signal weights plus popularity boost', () => {
    const s = signals({ crops: ['maize'], state: 'kano' });
    const result = scoreCandidate(s, listing(), { ...w, popularityBoost: 0 });
    expect(result.score).toBeCloseTo(w.sameCrop + w.stateMatch, 4);
    expect(result.reasons).toEqual(expect.arrayContaining(['same_crop', 'state_match']));
  });

  it('popularity boost scales logarithmically when enabled', () => {
    const s = signals({ crops: ['maize'] });
    const popular = scoreCandidate(s, listing({ popularity: 1000 }), w);
    const obscure = scoreCandidate(s, listing({ popularity: 0 }), w);
    expect(popular.score).toBeGreaterThan(obscure.score);
    expect(popular.score - obscure.score).toBeCloseTo(w.popularityBoost * 3, 3);
  });

  it('returns zero score and no reasons when nothing matches', () => {
    const result = scoreCandidate(signals({ crops: ['rice'] }), listing(), {
      ...w,
      popularityBoost: 0
    });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });
});

describe('rankCandidates', () => {
  it('orders by score descending and drops zero-score candidates', () => {
    const s = signals({ crops: ['maize'], state: 'kano' });
    const ranked = rankCandidates(s, [
      listing({ id: 'l-strong' }),
      course({ id: 'c-weak', category: 'poultry', tags: ['poultry'] }),
      opportunity({ id: 'o-mid', states: ['kano'] })
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['l-strong', 'o-mid']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('respects the limit', () => {
    const s = signals({ state: 'kano' });
    const candidates = Array.from({ length: 5 }, (_, i) => listing({ id: `l-${i}` }));
    expect(rankCandidates(s, candidates, { limit: 2 })).toHaveLength(2);
  });

  it('custom weights change the ranking', () => {
    const s = signals({ crops: ['maize'], state: 'kano' });
    const cropHeavy = rankCandidates(s, [listing({ id: 'both' }), opportunity({ id: 'state-only' })], {
      weights: { ...DEFAULT_RECOMMENDER_WEIGHTS, sameCrop: 10, stateMatch: 1, popularityBoost: 0 }
    });
    expect(cropHeavy[0].id).toBe('both');
  });
});

describe('coldStartRank', () => {
  it('ranks by popularity and tags every item with trending_fallback', () => {
    const ranked = coldStartRank([
      course({ id: 'hot', popularity: 500 }),
      course({ id: 'cold', title: 'Cold course', popularity: 2 })
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['hot', 'cold']);
    expect(ranked.every((r) => r.reasons.includes('trending_fallback'))).toBe(true);
  });

  it('includes zero-popularity items with score 0 for full coverage', () => {
    const ranked = coldStartRank([course({ id: 'zero', popularity: 0 })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBe(0);
  });
});

describe('similarItems', () => {
  it('ranks shared-tag and same-crop items above unrelated ones and excludes the source', () => {
    const source = listing({ id: 'src' });
    const results = similarItems(source, [
      source,
      listing({ id: 'same-crop', title: 'Another maize lot' }),
      course({ id: 'maize-course', tags: ['maize'] }),
      course({ id: 'poultry-course', category: 'poultry', tags: ['poultry'], title: 'Poultry' })
    ]);
    expect(results.map((r) => r.id)).not.toContain('src');
    expect(results.map((r) => r.id)).not.toContain('poultry-course');
    expect(results[0].reasons.length).toBeGreaterThan(0);
  });

  it('returns an empty list when nothing shares metadata', () => {
    const source = course({ id: 'src', category: 'apiculture', tags: ['apiculture'] });
    expect(similarItems(source, [course({ id: 'other', category: 'poultry', tags: ['poultry'] })])).toEqual([]);
  });
});
