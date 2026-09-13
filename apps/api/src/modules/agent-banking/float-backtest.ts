/**
 * Float Forecaster backtest harness (Stage 27, Innovation 15).
 *
 * Walk-forward evaluation of model v1 over a fixture ledger history: for
 * each cutoff, the model sees ONLY the days before the cutoff, projects the
 * next horizonDays, and the projection is scored against what actually
 * happened. This is the platform's honesty mechanism — accuracy numbers
 * (MAPE in basis points, depletion hit-rate) are EMITTED from this harness
 * (gauge histogram agent_banking.forecast_mape_bps, labelled per
 * model_version), never claimed without it.
 *
 * Pure and deterministic: same series in, same metrics out.
 */

import {
  FLOAT_FORECAST_MODEL_VERSION,
  MIN_HISTORY_DAYS,
  daysBetween,
  densifyDailyFlows,
  fitForecast,
  roundKobo,
  type DailyNetFlow
} from './float-forecast.js';

export interface BacktestConfig {
  horizonDays: number;
  /** Float at the start of the first history day, integer kobo. */
  initialFloatKobo: number;
  depletionThresholdKobo: number;
  excessThresholdKobo?: number;
  /** A predicted depletion within +/- this many days of the actual one counts as a hit. */
  hitToleranceDays: number;
}

export interface BacktestResult {
  modelVersion: string;
  horizonDays: number;
  /** Cutoffs evaluated (each sees >= MIN_HISTORY_DAYS days of history). */
  samples: number;
  /** Forecast days contributing to MAPE (actual net flow != 0). */
  evaluatedDays: number;
  /** Mean absolute percentage error in basis points; null when nothing was eligible. */
  mapeBps: number | null;
  /** Cutoffs where the float actually depleted inside the horizon. */
  depletionCases: number;
  /** Of those, where the model predicted depletion within +/- hitToleranceDays. */
  depletionHits: number;
  /** depletionHits / depletionCases in basis points; null when no actual depletions. */
  depletionHitRateBps: number | null;
  /** Predicted depletions with no actual depletion inside the horizon. */
  falseAlarms: number;
}

export const DEFAULT_HIT_TOLERANCE_DAYS = 1;

/**
 * Walk-forward backtest. `history` is the FULL daily series (sparse ok);
 * the float level at each cutoff is replayed from initialFloatKobo plus the
 * net flows before the cutoff, so the harness needs no ledger access.
 */
export function runBacktest(history: DailyNetFlow[], config: BacktestConfig): BacktestResult {
  if (!Number.isSafeInteger(config.hitToleranceDays) || config.hitToleranceDays < 0) {
    throw new Error('hitToleranceDays must be a non-negative integer');
  }
  const dense = densifyDailyFlows(history);
  const cumulative: number[] = [];
  let floatKobo = config.initialFloatKobo;
  for (const row of dense) {
    floatKobo += row.netFlowKobo;
    cumulative.push(floatKobo);
  }

  let samples = 0;
  let evaluatedDays = 0;
  let errorBpsSum = 0;
  let depletionCases = 0;
  let depletionHits = 0;
  let falseAlarms = 0;

  for (let cutoff = MIN_HISTORY_DAYS; cutoff < dense.length; cutoff += 1) {
    const train = dense.slice(0, cutoff);
    const asOfDate = train[train.length - 1].date;
    const forecast = fitForecast({
      history: train,
      asOfDate,
      horizonDays: config.horizonDays,
      currentFloatKobo: cumulative[cutoff - 1],
      depletionThresholdKobo: config.depletionThresholdKobo,
      ...(config.excessThresholdKobo !== undefined
        ? { excessThresholdKobo: config.excessThresholdKobo }
        : {})
    });
    if (forecast.basis !== 'seasonal_trend') {
      continue; // defensive: cutoff >= MIN_HISTORY_DAYS always fits
    }
    samples += 1;

    // Actual depletion inside the horizon, replayed from the cutoff float.
    let actualDepletionDate: string | undefined;
    let actualFloat = cumulative[cutoff - 1];
    for (let index = cutoff; index < Math.min(cutoff + config.horizonDays, dense.length); index += 1) {
      actualFloat += dense[index].netFlowKobo;
      if (actualFloat <= config.depletionThresholdKobo) {
        actualDepletionDate = dense[index].date;
        break;
      }
    }

    for (const prediction of forecast.predictions) {
      const actualIndex = cutoff + prediction.dayOffset - 1;
      if (actualIndex >= dense.length) {
        break; // no actuals beyond the series — score only what exists
      }
      const actual = dense[actualIndex].netFlowKobo;
      if (actual === 0) {
        continue; // MAPE undefined at zero actual; standard practice is to skip
      }
      evaluatedDays += 1;
      errorBpsSum += (Math.abs(prediction.predictedNetFlowKobo - actual) / Math.abs(actual)) * 10_000;
    }

    if (actualDepletionDate !== undefined) {
      depletionCases += 1;
      if (
        forecast.depletionDate !== undefined &&
        Math.abs(daysBetween(forecast.depletionDate, actualDepletionDate)) <= config.hitToleranceDays
      ) {
        depletionHits += 1;
      }
    } else if (forecast.depletionDate !== undefined && cutoff + config.horizonDays <= dense.length) {
      // Full horizon was observed and no depletion occurred: a real false alarm
      // (not counted when the series ends before the horizon plays out).
      falseAlarms += 1;
    }
  }

  return {
    modelVersion: FLOAT_FORECAST_MODEL_VERSION,
    horizonDays: config.horizonDays,
    samples,
    evaluatedDays,
    mapeBps: evaluatedDays === 0 ? null : roundKobo(errorBpsSum / evaluatedDays),
    depletionCases,
    depletionHits,
    depletionHitRateBps: depletionCases === 0 ? null : roundKobo((depletionHits / depletionCases) * 10_000),
    falseAlarms
  };
}
