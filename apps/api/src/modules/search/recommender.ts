/**
 * Deterministic content-based recommender (M16 Phase 3, Wave P5c).
 *
 * Pure scoring engine — no I/O, no external AI calls. Member profile signals
 * (state, LGA, crop interests, completed courses, order history categories)
 * are crossed with content metadata (tags, crop, state, type) to produce a
 * scored, ranked candidate list across courses, opportunities, listings and
 * knowledge resources.
 *
 * Every recommendation is explainable: the score decomposes into additive
 * weighted signals, and each fired signal is returned as a reason code so
 * clients (and tests) can show "why this item".
 *
 * Cold start (member has no usable signals) falls back to a popularity-based
 * trending ranking where every item carries the `trending_fallback` reason.
 */

export const RECOMMENDATION_TYPES = ['course', 'opportunity', 'listing', 'knowledge'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_REASONS = [
  'same_crop',
  'state_match',
  'lga_match',
  'value_chain_match',
  'category_affinity',
  'purchased_category',
  'completed_prerequisite',
  'trending_fallback'
] as const;
export type RecommendationReason = (typeof RECOMMENDATION_REASONS)[number];

/** Normalised member profile signals. All values lower-cased. */
export interface MemberSignals {
  state?: string;
  lga?: string;
  /** Crop / farming interests from the member profile. */
  crops: string[];
  /** Value chains from the member profile. */
  valueChains: string[];
  /** Categories of courses the member has completed. */
  completedCourseCategories: string[];
  /** Categories of courses the member is enrolled in but has not completed. */
  activeCourseCategories: string[];
  /** Crops the member has previously ordered (order history). */
  purchasedCrops: string[];
  /** Listing kinds the member has previously ordered. */
  purchasedKinds: string[];
  /** Opportunity types the member has applied to. */
  appliedOpportunityTypes: string[];
}

export function emptySignals(): MemberSignals {
  return {
    crops: [],
    valueChains: [],
    completedCourseCategories: [],
    activeCourseCategories: [],
    purchasedCrops: [],
    purchasedKinds: [],
    appliedOpportunityTypes: []
  };
}

/** Candidate content item with the metadata the scorer reads. */
export interface RecommendationCandidate {
  type: RecommendationType;
  id: string;
  title: string;
  summary: string;
  tags: string[];
  crop?: string;
  /** Primary state (listings, state-scoped content). */
  state?: string;
  /** Covered states (opportunities); empty means nationwide. */
  states?: string[];
  /** Course category / knowledge primary tag. */
  category?: string;
  /** Listing kind / opportunity type. */
  kind?: string;
  /** Popularity signal (enrolment count, view count) used for cold start. */
  popularity: number;
}

/** Weight configuration — every reason code maps to one additive weight. */
export interface RecommenderWeights {
  sameCrop: number;
  stateMatch: number;
  lgaMatch: number;
  valueChainMatch: number;
  categoryAffinity: number;
  purchasedCategory: number;
  completedPrerequisite: number;
  /** Multiplicative boost for the item's own popularity signal (0 disables). */
  popularityBoost: number;
}

export const DEFAULT_RECOMMENDER_WEIGHTS: RecommenderWeights = {
  sameCrop: 3,
  stateMatch: 2,
  lgaMatch: 1.5,
  valueChainMatch: 2,
  categoryAffinity: 2.5,
  purchasedCategory: 2,
  completedPrerequisite: 1.5,
  popularityBoost: 0.1
};

export interface ScoredRecommendation {
  type: RecommendationType;
  id: string;
  title: string;
  summary: string;
  score: number;
  reasons: RecommendationReason[];
}

const norm = (value: string | undefined): string | undefined =>
  value && value.trim() !== '' ? value.trim().toLowerCase() : undefined;

/** A member is cold-start when no signal bucket carries any information. */
export function isColdStart(signals: MemberSignals): boolean {
  return (
    !norm(signals.state) &&
    signals.crops.length === 0 &&
    signals.valueChains.length === 0 &&
    signals.completedCourseCategories.length === 0 &&
    signals.activeCourseCategories.length === 0 &&
    signals.purchasedCrops.length === 0 &&
    signals.purchasedKinds.length === 0 &&
    signals.appliedOpportunityTypes.length === 0
  );
}

function intersects(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const set = new Set(left);
  return right.some((value) => set.has(value));
}

/**
 * Scores one candidate against the member signals. The returned score is the
 * sum of fired signal weights plus a small popularity boost; `reasons` lists
 * every fired signal in weight-descending firing order of evaluation.
 */
export function scoreCandidate(
  signals: MemberSignals,
  candidate: RecommendationCandidate,
  weights: RecommenderWeights = DEFAULT_RECOMMENDER_WEIGHTS
): ScoredRecommendation {
  const reasons: RecommendationReason[] = [];
  let score = 0;

  const candidateCrop = norm(candidate.crop);
  const candidateState = norm(candidate.state);
  const candidateStates = (candidate.states ?? []).map((s) => s.toLowerCase());
  const candidateCategory = norm(candidate.category);
  const candidateKind = norm(candidate.kind);
  const memberState = norm(signals.state);

  // Crop affinity: member grows the crop this content is about.
  if (candidateCrop && signals.crops.includes(candidateCrop)) {
    score += weights.sameCrop;
    reasons.push('same_crop');
  }
  // Listing kind previously purchased (order history categories).
  if (candidateKind && signals.purchasedKinds.includes(candidateKind)) {
    score += weights.purchasedCategory;
    if (!reasons.includes('purchased_category')) reasons.push('purchased_category');
  }
  if (candidateCrop && signals.purchasedCrops.includes(candidateCrop)) {
    score += weights.purchasedCategory;
    if (!reasons.includes('purchased_category')) reasons.push('purchased_category');
  }
  // Geography: nationwide opportunities (empty states) match nobody
  // specifically; a listed state equal to the member's state does.
  if (
    memberState &&
    ((candidateState && candidateState === memberState) || candidateStates.includes(memberState))
  ) {
    score += weights.stateMatch;
    reasons.push('state_match');
  }
  // LGA match: only fires alongside a state match (LGA names repeat across states).
  if (reasons.includes('state_match') && signals.lga && candidate.tags.includes(norm(signals.lga)!)) {
    score += weights.lgaMatch;
    reasons.push('lga_match');
  }
  // Value chains: opportunity value chains overlapping member value chains.
  if (intersects(signals.valueChains, candidate.tags)) {
    score += weights.valueChainMatch;
    reasons.push('value_chain_match');
  }
  // Category affinity: course/knowledge category matches the member's crops
  // or value chains (topic-level interest without a structured crop field).
  if (
    candidateCategory &&
    (signals.crops.includes(candidateCategory) || signals.valueChains.includes(candidateCategory))
  ) {
    score += weights.categoryAffinity;
    reasons.push('category_affinity');
  }
  // Completed prerequisite: a course in a category the member already trained
  // in (completed or in-progress) — the natural "next step" recommendation.
  if (
    candidate.type === 'course' &&
    candidateCategory &&
    (signals.completedCourseCategories.includes(candidateCategory) ||
      signals.activeCourseCategories.includes(candidateCategory))
  ) {
    score += weights.completedPrerequisite;
    reasons.push('completed_prerequisite');
  }
  // Opportunity type the member has applied to before.
  if (
    candidate.type === 'opportunity' &&
    candidateKind &&
    signals.appliedOpportunityTypes.includes(candidateKind)
  ) {
    score += weights.categoryAffinity;
    if (!reasons.includes('category_affinity')) reasons.push('category_affinity');
  }

  // Popularity only breaks ties between signal-matched items; without any
  // fired signal a candidate stays at 0 and is dropped from the ranking.
  if (reasons.length > 0 && weights.popularityBoost > 0 && candidate.popularity > 0) {
    score += weights.popularityBoost * Math.log10(candidate.popularity + 1);
  }

  return {
    type: candidate.type,
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    score: Math.round(score * 10000) / 10000,
    reasons
  };
}

/** Ranks candidates by score (title tie-break) and keeps `limit`. */
export function rankCandidates(
  signals: MemberSignals,
  candidates: RecommendationCandidate[],
  options: { limit?: number; weights?: RecommenderWeights; excludeIds?: ReadonlySet<string> } = {}
): ScoredRecommendation[] {
  const weights = options.weights ?? DEFAULT_RECOMMENDER_WEIGHTS;
  return candidates
    .filter((candidate) => !options.excludeIds?.has(`${candidate.type}:${candidate.id}`))
    .map((candidate) => scoreCandidate(signals, candidate, weights))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, options.limit ?? 10);
}

/**
 * Cold-start fallback: popularity-ranked "trending" items. Every item gets
 * the `trending_fallback` reason; score is log-scaled popularity.
 */
export function coldStartRank(
  candidates: RecommendationCandidate[],
  limit = 10,
  excludeIds?: ReadonlySet<string>
): ScoredRecommendation[] {
  return candidates
    .filter((candidate) => !excludeIds?.has(`${candidate.type}:${candidate.id}`))
    .map((candidate) => ({
      type: candidate.type,
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      score: Math.round(Math.log10(candidate.popularity + 1) * 10000) / 10000,
      reasons: ['trending_fallback' as RecommendationReason]
    }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * Item-to-item similarity ("similar to this item"): ranks candidates sharing
 * metadata with the source item. Reasons mirror the member-facing codes.
 */
export function similarItems(
  source: RecommendationCandidate,
  candidates: RecommendationCandidate[],
  options: { limit?: number } = {}
): ScoredRecommendation[] {
  const sourceTags = new Set(source.tags);
  const sourceCrop = norm(source.crop);
  const sourceStates = new Set(
    [norm(source.state), ...(source.states ?? []).map((s) => s.toLowerCase())].filter(
      (v): v is string => v !== undefined
    )
  );
  const sourceCategory = norm(source.category);
  const scored: ScoredRecommendation[] = [];
  for (const candidate of candidates) {
    if (candidate.type === source.type && candidate.id === source.id) continue;
    const reasons: RecommendationReason[] = [];
    let score = 0;
    const shared = candidate.tags.filter((tag) => sourceTags.has(tag)).length;
    if (shared > 0) {
      score += shared;
      reasons.push('value_chain_match');
    }
    const candidateCrop = norm(candidate.crop);
    if (sourceCrop && candidateCrop && sourceCrop === candidateCrop) {
      score += DEFAULT_RECOMMENDER_WEIGHTS.sameCrop;
      reasons.push('same_crop');
    }
    if (sourceCategory && norm(candidate.category) === sourceCategory) {
      score += DEFAULT_RECOMMENDER_WEIGHTS.categoryAffinity;
      reasons.push('category_affinity');
    }
    const candidateStates = [norm(candidate.state), ...(candidate.states ?? []).map((s) => s.toLowerCase())];
    if (candidateStates.some((s) => s !== undefined && sourceStates.has(s))) {
      score += DEFAULT_RECOMMENDER_WEIGHTS.stateMatch;
      reasons.push('state_match');
    }
    if (score > 0) {
      scored.push({
        type: candidate.type,
        id: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
        score: Math.round(score * 10000) / 10000,
        reasons
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, options.limit ?? 10);
}
