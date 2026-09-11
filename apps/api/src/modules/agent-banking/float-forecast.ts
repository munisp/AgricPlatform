/**
 * Float Forecaster — deterministic v1 model (Stage 27, Innovation 15).
 *
 * Pure, dependency-free functions: same input always yields the same output
 * (no clock reads, no randomness, no external calls), which is what makes
 * the known-answer test vectors meaningful and backtests reproducible.
 *
 * Model v1 ('seasonal-naive-trend-v1'): per-agent weekday seasonal naive +
 * linear trend over ledger-derived daily net flows.
 *   1. Least-squares fit y(t) = a + b*t over the dense daily series
 *      (t = calendar days since the first history day).
 *   2. seasonal[w] = mean residual of history days falling on weekday w.
 *   3. prediction(day) = a + b*t(day) + seasonal[weekday(day)], rounded to
 *      integer kobo (half up); EOD float accumulates the rounded integers.
 *
 * Fail-closed on thin data: fewer than MIN_HISTORY_DAYS days of history
 * yields basis='insufficient_history' with NO predictions — the service
 * stores a marker row and never raises an alert from it (a wrong depletion
 * alert sends an ops run to the wrong village).
 */

export const FLOAT_FORECAST_MODEL_VERSION = 'seasonal-naive-trend-v1';
/** Minimum dense daily history required before any prediction is made. */
export const MIN_HISTORY_DAYS = 14;
/** Default forecast horizon for the nightly run. */
export const DEFAULT_FORECAST_HORIZON_DAYS = 14;
/** Maximum horizon the model will project (beyond this the naive model is noise). */
export const MAX_FORECAST_HORIZON_DAYS = 45;

const DAY_MS = 86_400_000;

export interface DailyNetFlow {
  /** ISO calendar day, YYYY-MM-DD (UTC). */
  date: string;
  /** Signed net flow into the agent float for that day, integer kobo. */
  netFlowKobo: number;
}

export type ForecastBasis = 'seasonal_trend' | 'insufficient_history';

export interface ForecastDayPrediction {
  /** 1-based offset from asOfDate (0 is reserved for the insufficient-history marker row). */
  dayOffset: number;
  targetDate: string;
  predictedNetFlowKobo: number;
  predictedEodFloatKobo: number;
}

export interface ForecastResult {
  modelVersion: string;
  basis: ForecastBasis;
  /** Dense history days the fit consumed (0..n; < MIN_HISTORY_DAYS when insufficient). */
  historyDays: number;
  asOfDate: string;
  horizonDays: number;
  currentFloatKobo: number;
  /** Rounded least-squares trend, kobo/day; null when basis is insufficient_history. */
  trendKoboPerDay: number | null;
  predictions: ForecastDayPrediction[];
  /** First predicted day EOD float breaches the depletion threshold (<=), if any. */
  depletionDate?: string;
  /** First predicted day EOD float breaches the excess threshold (>=), if any. */
  excessDate?: string;
}

export interface FitForecastInput {
  /** Dense ascending daily series (use densifyDailyFlows on sparse input). */
  history: DailyNetFlow[];
  /** ISO day the forecast is computed as-of; predictions start the next day. */
  asOfDate: string;
  horizonDays: number;
  currentFloatKobo: number;
  /** Depletion = predicted EOD float at/below this (the agent's low-float threshold). */
  depletionThresholdKobo: number;
  /** Excess = predicted EOD float at/above this (float that should be swept). */
  excessThresholdKobo?: number;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function parseDigits(text: string, from: number, to: number): number {
  let value = 0;
  for (let index = from; index < to; index += 1) {
    const code = text.charCodeAt(index);
    if (!isDigit(code)) {
      throw new Error(`Invalid ISO date '${text}'`);
    }
    value = value * 10 + (code - 48);
  }
  return value;
}

/**
 * Parses a strict YYYY-MM-DD calendar day to UTC epoch milliseconds.
 * Hand-rolled (no regex) so the module stays backslash-free; rejects
 * impossible dates (2026-02-31) via a round-trip check.
 */
export function parseIsoDate(date: string): number {
  if (
    typeof date !== 'string' ||
    date.length !== 10 ||
    date.charAt(4) !== '-' ||
    date.charAt(7) !== '-'
  ) {
    throw new Error(`Invalid ISO date '${date}' (expected YYYY-MM-DD)`);
  }
  const year = parseDigits(date, 0, 4);
  const month = parseDigits(date, 5, 7);
  const day = parseDigits(date, 8, 10);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ISO date '${date}' (not a real calendar day)`);
  }
  return ms;
}

/** ISO day `days` after `date` (negative allowed). */
export function addDays(date: string, days: number): string {
  return new Date(parseIsoDate(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (to - from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / DAY_MS);
}

/** 0 = Sunday .. 6 = Saturday (UTC). */
export function weekdayOf(date: string): number {
  return new Date(parseIsoDate(date)).getUTCDay();
}

/** Integer kobo rounding, half up (matches Math.round; stated for backtest parity). */
export function roundKobo(value: number): number {
  return Math.round(value);
}

/**
 * Zero-fills a sparse daily series into a dense ascending one from its first
 * to its last date (days with no ledger postings have zero net flow — that
 * is a real observation, not missing data). Validates ascending ISO dates
 * with no duplicates; throws on malformed input (fail-closed).
 */
export function densifyDailyFlows(sparse: DailyNetFlow[]): DailyNetFlow[] {
  if (sparse.length === 0) {
    return [];
  }
  for (const row of sparse) {
    parseIsoDate(row.date);
    if (!Number.isSafeInteger(row.netFlowKobo)) {
      throw new Error(`netFlowKobo for ${row.date} must be a safe integer`);
    }
  }
  for (let index = 1; index < sparse.length; index += 1) {
    if (daysBetween(sparse[index - 1].date, sparse[index].date) <= 0) {
      throw new Error('daily flows must be ascending with unique dates');
    }
  }
  const dense: DailyNetFlow[] = [];
  const span = daysBetween(sparse[0].date, sparse[sparse.length - 1].date);
  let cursor = 0;
  for (let offset = 0; offset <= span; offset += 1) {
    const date = addDays(sparse[0].date, offset);
    if (cursor < sparse.length && sparse[cursor].date === date) {
      dense.push({ date, netFlowKobo: sparse[cursor].netFlowKobo });
      cursor += 1;
    } else {
      dense.push({ date, netFlowKobo: 0 });
    }
  }
  return dense;
}

/**
 * Fits model v1 and projects the float forward. Deterministic: output is a
 * pure function of the input, so the known-answer vectors in
 * float-forecast.spec.ts pin every kobo value.
 */
export function fitForecast(input: FitForecastInput): ForecastResult {
  parseIsoDate(input.asOfDate);
  if (!Number.isSafeInteger(input.horizonDays) || input.horizonDays < 1) {
    throw new Error('horizonDays must be a positive integer');
  }
  if (input.horizonDays > MAX_FORECAST_HORIZON_DAYS) {
    throw new Error(`horizonDays must be <= ${MAX_FORECAST_HORIZON_DAYS}`);
  }
  for (const field of ['currentFloatKobo', 'depletionThresholdKobo'] as const) {
    if (!Number.isSafeInteger(input[field])) {
      throw new Error(`${field} must be a safe integer`);
    }
  }
  if (input.excessThresholdKobo !== undefined && !Number.isSafeInteger(input.excessThresholdKobo)) {
    throw new Error('excessThresholdKobo must be a safe integer');
  }
  const history = densifyDailyFlows(input.history);
  for (const row of history) {
    if (daysBetween(row.date, input.asOfDate) < 0) {
      throw new Error(`history contains a day after asOfDate (${row.date})`);
    }
  }

  const base = {
    modelVersion: FLOAT_FORECAST_MODEL_VERSION,
    historyDays: history.length,
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
    currentFloatKobo: input.currentFloatKobo
  };

  if (history.length < MIN_HISTORY_DAYS) {
    // Fail closed: no prediction, no alert basis. The service stores a single
    // marker row (day_offset 0) so ops can see WHY there is no forecast.
    return { ...base, basis: 'insufficient_history', trendKoboPerDay: null, predictions: [] };
  }

  const n = history.length;
  const origin = history[0].date;
  const t = history.map((row) => daysBetween(origin, row.date));
  const y = history.map((row) => row.netFlowKobo);

  // Least-squares trend over the dense series.
  const tMean = t.reduce((sum, value) => sum + value, 0) / n;
  const yMean = y.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (t[index] - tMean) * (y[index] - yMean);
    denominator += (t[index] - tMean) * (t[index] - tMean);
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * tMean;

  // Weekday seasonal indices: mean detrended residual per weekday. With
  // >= MIN_HISTORY_DAYS dense days every weekday appears at least twice.
  const seasonalSums = new Array<number>(7).fill(0);
  const seasonalCounts = new Array<number>(7).fill(0);
  for (let index = 0; index < n; index += 1) {
    const weekday = weekdayOf(history[index].date);
    seasonalSums[weekday] += y[index] - (intercept + slope * t[index]);
    seasonalCounts[weekday] += 1;
  }
  const seasonal = seasonalSums.map((sum, weekday) =>
    seasonalCounts[weekday] === 0 ? 0 : sum / seasonalCounts[weekday]
  );

  const predictions: ForecastDayPrediction[] = [];
  let eodFloatKobo = input.currentFloatKobo;
  let depletionDate: string | undefined;
  let excessDate: string | undefined;
  for (let offset = 1; offset <= input.horizonDays; offset += 1) {
    const targetDate = addDays(input.asOfDate, offset);
    const targetT = daysBetween(origin, targetDate);
    const netFlowKobo = roundKobo(intercept + slope * targetT + seasonal[weekdayOf(targetDate)]);
    eodFloatKobo += netFlowKobo;
    predictions.push({
      dayOffset: offset,
      targetDate,
      predictedNetFlowKobo: netFlowKobo,
      predictedEodFloatKobo: eodFloatKobo
    });
    if (depletionDate === undefined && eodFloatKobo <= input.depletionThresholdKobo) {
      depletionDate = targetDate;
    }
    if (
      excessDate === undefined &&
      input.excessThresholdKobo !== undefined &&
      eodFloatKobo >= input.excessThresholdKobo
    ) {
      excessDate = targetDate;
    }
  }

  return {
    ...base,
    basis: 'seasonal_trend',
    trendKoboPerDay: roundKobo(slope),
    predictions,
    ...(depletionDate !== undefined ? { depletionDate } : {}),
    ...(excessDate !== undefined ? { excessDate } : {})
  };
}
