import type {
  FloodSeverityRank,
  ParametricPayoutBand,
  ParametricTriggerDefinition
} from '@agric-platform/shared';

/**
 * Parametric trigger evaluation engine (wave-insurance) — pure functions.
 * The same trigger definition + observed value always produce the same
 * outcome; all persistence and provider I/O live in InsuranceService.
 *
 * Breach-ratio math (documented in docs/parametric-insurance.md):
 *   - 'lte' (rainfall deficit): ratio = (threshold − observed) / threshold
 *   - 'gte' (flood rank, heat days): ratio = (observed − threshold) / threshold
 * Exactly at the threshold the breach fires and the ratio is 0, which maps
 * to the lowest graduated payout band (minRatio: 0) — an at-threshold
 * breach is still a breach.
 */

/** Days at or above this daily maximum temperature count as heat days. */
export const HEAT_DAY_THRESHOLD_C = 38;

export interface TriggerEvaluation {
  triggered: boolean;
  /** 0 exactly at threshold; grows with breach severity. Never negative. */
  breachRatio: number;
}

/** Compares the observed aggregate against the trigger threshold. */
export function evaluateTrigger(
  trigger: Pick<ParametricTriggerDefinition, 'operator' | 'threshold'>,
  observedValue: number
): TriggerEvaluation {
  if (trigger.operator === 'lte') {
    const triggered = observedValue <= trigger.threshold;
    const breachRatio =
      triggered && trigger.threshold > 0
        ? (trigger.threshold - observedValue) / trigger.threshold
        : 0;
    return { triggered, breachRatio };
  }
  const triggered = observedValue >= trigger.threshold;
  const breachRatio =
    triggered && trigger.threshold > 0
      ? (observedValue - trigger.threshold) / trigger.threshold
      : 0;
  return { triggered, breachRatio };
}

/**
 * Picks the graduated payout band for a breach ratio. Bands are matched
 * from the highest minRatio down; the first band with ratio >= minRatio
 * wins. Returns undefined when no band matches (a table without a
 * minRatio:0 band pays nothing for an at-threshold breach).
 */
export function payoutBandFor(
  payoutTable: readonly ParametricPayoutBand[],
  breachRatio: number
): ParametricPayoutBand | undefined {
  return [...payoutTable]
    .sort((a, b) => b.minRatio - a.minRatio)
    .find((band) => breachRatio >= band.minRatio);
}

/** Payout amount in kobo: sumInsured × payoutPercent / 100 (round half-up). */
export function payoutKoboFor(sumInsuredKobo: number, payoutPercent: number): number {
  return Math.round((sumInsuredKobo * payoutPercent) / 100);
}

/** Total rainfall (mm, one decimal) over the observation window. */
export function aggregateRainfallMm(dailyRainfallMm: readonly number[]): number {
  const total = dailyRainfallMm.reduce((sum, value) => sum + value, 0);
  return Math.round(total * 10) / 10;
}

/** Count of days with daily maximum temperature at/above the heat threshold. */
export function aggregateHeatDays(dailyMaxTempC: readonly number[]): number {
  return dailyMaxTempC.filter((value) => value >= HEAT_DAY_THRESHOLD_C).length;
}

/** Maps the geo-intel flood severity label to its rank (0-4). */
export function floodSeverityRank(severity: string): number {
  const ranks: FloodSeverityRank[] = ['none', 'low', 'moderate', 'high', 'severe'];
  const index = ranks.indexOf(severity as FloodSeverityRank);
  return index === -1 ? 0 : index;
}

/** Maps a numeric flood rank back to its band label. */
export function floodBandForRank(rank: number): FloodSeverityRank {
  const ranks: FloodSeverityRank[] = ['none', 'low', 'moderate', 'high', 'severe'];
  return ranks[Math.max(0, Math.min(ranks.length - 1, Math.round(rank)))];
}

/** Deterministic 32-bit FNV-1a hash — shared with the evidence fingerprint. */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Evidence fingerprint: a pure function of every input that determined the
 * evaluation. Re-running the deterministic evaluation with unchanged inputs
 * yields the same fingerprint, and the repository unique index makes the
 * re-run a no-op (no duplicate TriggerEvents).
 */
export function computeEvidenceFingerprint(parts: readonly unknown[]): string {
  return fnv1aHex(
    parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join('|')
  );
}
