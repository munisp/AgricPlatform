/**
 * Recommendation feedback loop (Wave P5c). Pure functions over persisted
 * clicked/dismissed events; the service layer supplies the aggregates.
 *
 * Global per-item feedback is Bayesian-smoothed with a Beta(α, β) prior so a
 * brand-new item with 1 click / 0 dismissals does not outrank an established
 * item with 100 clicks / 10 dismissals:
 *
 *   smoothedCtr = (clicks + α) / (clicks + dismissals + α + β)
 *
 * The smoothed CTR maps to a multiplicative adjustment centred on neutral:
 *
 *   multiplier = 0.5 + smoothedCtr        ∈ (0.5, 1.5) with the default prior
 *
 * A member's own feedback dominates: a dismissal divides the score by
 * OWN_DISMISSAL_PENALTY (default 4 → 25% of base), a click multiplies by
 * OWN_CLICK_BOOST.
 */

/** Beta prior pseudo-counts: neutral 0.5 CTR for unseen items. */
export const FEEDBACK_PRIOR_ALPHA = 1;
export const FEEDBACK_PRIOR_BETA = 1;

export const OWN_CLICK_BOOST = 1.25;
export const OWN_DISMISSAL_PENALTY = 4;

export type FeedbackAction = 'clicked' | 'dismissed';

export interface FeedbackAggregate {
  clicks: number;
  dismissals: number;
}

/** Bayesian-smoothed click-through rate for an item. */
export function smoothedCtr(
  clicks: number,
  dismissals: number,
  alpha = FEEDBACK_PRIOR_ALPHA,
  beta = FEEDBACK_PRIOR_BETA
): number {
  return (clicks + alpha) / (clicks + dismissals + alpha + beta);
}

/** Multiplicative ranking adjustment derived from global feedback. */
export function feedbackMultiplier(
  aggregate: FeedbackAggregate,
  alpha = FEEDBACK_PRIOR_ALPHA,
  beta = FEEDBACK_PRIOR_BETA
): number {
  return 0.5 + smoothedCtr(aggregate.clicks, aggregate.dismissals, alpha, beta);
}

/**
 * Applies feedback to a base score. `ownAction` is the current member's own
 * latest action on the item (if any) and takes precedence over the global
 * multiplier's magnitude.
 */
export function adjustScore(
  baseScore: number,
  global: FeedbackAggregate,
  ownAction?: FeedbackAction
): number {
  let score = baseScore * feedbackMultiplier(global);
  if (ownAction === 'clicked') {
    score *= OWN_CLICK_BOOST;
  } else if (ownAction === 'dismissed') {
    score /= OWN_DISMISSAL_PENALTY;
  }
  return Math.round(score * 10000) / 10000;
}

/** Folds a raw event list into a per-item aggregate keyed by `type:id`. */
export function aggregateFeedback(
  events: ReadonlyArray<{ itemType: string; itemId: string; action: FeedbackAction }>
): Map<string, FeedbackAggregate> {
  const aggregates = new Map<string, FeedbackAggregate>();
  for (const event of events) {
    const key = `${event.itemType}:${event.itemId}`;
    const aggregate = aggregates.get(key) ?? { clicks: 0, dismissals: 0 };
    if (event.action === 'clicked') aggregate.clicks += 1;
    else aggregate.dismissals += 1;
    aggregates.set(key, aggregate);
  }
  return aggregates;
}

/** Latest action per (member, item) — most recent event wins. */
export function ownActions(
  events: ReadonlyArray<{ itemType: string; itemId: string; action: FeedbackAction; createdAt: string }>
): Map<string, FeedbackAction> {
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const actions = new Map<string, FeedbackAction>();
  for (const event of sorted) {
    actions.set(`${event.itemType}:${event.itemId}`, event.action);
  }
  return actions;
}
