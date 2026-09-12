/**
 * Planting-Window Pulse — deterministic planting-window generator (Stage 27
 * Batch 1, innovation 4). Pure functions only: no I/O, no clock access, no
 * ML/LLM — the same deterministic posture as insurance/premium.ts and the
 * voice module's corpus-only retrieval. Inputs are a crop rule from the
 * versioned in-repo table below and a 14-day daily precipitation forecast
 * (from the live Open-Meteo driver); outputs are known-answer testable.
 *
 * Agronomic model (v1, deliberately simple and explainable):
 *   rain onset = the first forecast day whose 3-day cumulative precipitation
 *   reaches the crop's onset threshold; the planting window opens on the
 *   onset day and stays open for the crop's window length. An onset landing
 *   outside the crop's planting season is NOT a window (fail-closed: better
 *   to advise waiting than to push a farmer into an off-season planting).
 */

/** Version stamped on every generated window and dispatch row. */
export const PLANTING_RULES_VERSION = 'planting-rules-v1';

/** Days of cumulative rain examined for onset (Open-Meteo daily series). */
export const ONSET_LOOKAHEAD_DAYS = 3;

/** Onset rain ≥ this multiple of the threshold ⇒ 'high' confidence. */
export const HIGH_CONFIDENCE_MULTIPLE = 1.5;

export interface CropRule {
  /** Canonical crop key (lowercase). */
  crop: string;
  /** Extra names farmers use; resolved case-insensitively. */
  aliases: readonly string[];
  /** 3-day cumulative rainfall (mm) that declares rain onset. */
  onsetRainMm: number;
  /** Planting window length in days from the onset day. */
  windowDays: number;
  /** Inclusive planting-season bounds as calendar months (1–12, same year). */
  seasonStartMonth: number;
  seasonEndMonth: number;
}

/**
 * Crop rule table (v1). Thresholds follow standard Nigerian wet-season
 * agronomy guidance (onset ≈ 15–25 mm over 3 days for cereals; tubers need
 * more established rains). Content review by an agronomist is a documented
 * residual — the table is versioned so corrections ship as a new version.
 */
export const CROP_RULES: readonly CropRule[] = [
  { crop: 'maize', aliases: ['corn'], onsetRainMm: 20, windowDays: 14, seasonStartMonth: 3, seasonEndMonth: 7 },
  { crop: 'rice', aliases: ['paddy'], onsetRainMm: 25, windowDays: 14, seasonStartMonth: 5, seasonEndMonth: 7 },
  { crop: 'sorghum', aliases: ['guinea corn', 'dawa'], onsetRainMm: 15, windowDays: 21, seasonStartMonth: 5, seasonEndMonth: 7 },
  { crop: 'millet', aliases: ['gero'], onsetRainMm: 15, windowDays: 21, seasonStartMonth: 5, seasonEndMonth: 7 },
  { crop: 'cowpea', aliases: ['beans', 'wake'], onsetRainMm: 15, windowDays: 14, seasonStartMonth: 6, seasonEndMonth: 8 },
  { crop: 'groundnut', aliases: ['peanut', 'gyada'], onsetRainMm: 15, windowDays: 14, seasonStartMonth: 5, seasonEndMonth: 6 },
  { crop: 'soybean', aliases: ['soya'], onsetRainMm: 20, windowDays: 14, seasonStartMonth: 5, seasonEndMonth: 7 },
  { crop: 'cassava', aliases: ['manioc', 'rogo'], onsetRainMm: 20, windowDays: 28, seasonStartMonth: 3, seasonEndMonth: 6 },
  { crop: 'yam', aliases: ['doya'], onsetRainMm: 20, windowDays: 21, seasonStartMonth: 2, seasonEndMonth: 4 },
  { crop: 'sesame', aliases: ['beniseed', 'ridi'], onsetRainMm: 15, windowDays: 14, seasonStartMonth: 6, seasonEndMonth: 7 }
];

/** Locales with shipped message templates. */
export const PULSE_LOCALES = ['en', 'ha', 'yo'] as const;
export type PulseLocale = (typeof PULSE_LOCALES)[number];

export interface DailyRainPoint {
  /** ISO calendar day (yyyy-mm-dd), ascending across the series. */
  date: string;
  precipitationMm: number;
}

export interface PlantingWindowInput {
  crop: string;
  /** Daily precipitation forecast (14 days from the Open-Meteo driver). */
  daily: readonly DailyRainPoint[];
  /** ISO calendar day the advisory is generated for. */
  referenceDate: string;
}

export type PlantingWindowResult =
  | {
      kind: 'window';
      crop: string;
      windowStart: string;
      windowEnd: string;
      onsetDate: string;
      onsetRainMm: number;
      daysUntilOnset: number;
      confidence: 'high' | 'medium';
      ruleVersion: string;
    }
  | {
      kind: 'wait';
      crop: string;
      reason: 'no_onset_in_horizon' | 'outside_season';
      onsetRainMm: number;
      ruleVersion: string;
    }
  | { kind: 'unknown_crop'; crop: string };

/** Case/whitespace-insensitive rule lookup; undefined for unknown crops. */
export function findCropRule(crop: string): CropRule | undefined {
  const key = crop.trim().toLowerCase();
  return CROP_RULES.find((rule) => rule.crop === key || rule.aliases.includes(key));
}

/** Adds `days` to an ISO yyyy-mm-dd date (UTC-safe, no clock access). */
export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map((part) => Number.parseInt(part, 10));
  const ms = Date.UTC(year, month - 1, day) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (ISO yyyy-mm-dd); negative when `to` is past. */
export function daysBetween(from: string, to: string): number {
  const parse = (iso: string): number => {
    const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10));
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * Computes the planting window for one crop over one forecast series.
 * Deterministic: identical inputs always produce the identical result.
 */
export function computePlantingWindow(input: PlantingWindowInput): PlantingWindowResult {
  const rule = findCropRule(input.crop);
  if (!rule) {
    return { kind: 'unknown_crop', crop: input.crop };
  }
  for (let i = 0; i + ONSET_LOOKAHEAD_DAYS <= input.daily.length; i += 1) {
    const rainMm = input.daily
      .slice(i, i + ONSET_LOOKAHEAD_DAYS)
      .reduce((sum, point) => sum + point.precipitationMm, 0);
    if (rainMm < rule.onsetRainMm) {
      continue;
    }
    const onsetDate = input.daily[i].date;
    const onsetMonth = Number.parseInt(onsetDate.slice(5, 7), 10);
    if (onsetMonth < rule.seasonStartMonth || onsetMonth > rule.seasonEndMonth) {
      return {
        kind: 'wait',
        crop: rule.crop,
        reason: 'outside_season',
        onsetRainMm: round1(rainMm),
        ruleVersion: PLANTING_RULES_VERSION
      };
    }
    return {
      kind: 'window',
      crop: rule.crop,
      windowStart: onsetDate,
      windowEnd: addDays(onsetDate, rule.windowDays),
      onsetDate,
      onsetRainMm: round1(rainMm),
      daysUntilOnset: daysBetween(input.referenceDate, onsetDate),
      confidence: rainMm >= rule.onsetRainMm * HIGH_CONFIDENCE_MULTIPLE ? 'high' : 'medium',
      ruleVersion: PLANTING_RULES_VERSION
    };
  }
  return {
    kind: 'wait',
    crop: rule.crop,
    reason: 'no_onset_in_horizon',
    onsetRainMm: 0,
    ruleVersion: PLANTING_RULES_VERSION
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** '2026-06-12' → '12 Jun' (deterministic, locale-independent). */
export function shortDate(isoDate: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = Number.parseInt(isoDate.slice(5, 7), 10);
  const day = Number.parseInt(isoDate.slice(8, 10), 10);
  return `${day} ${MONTHS[month - 1]}`;
}

export interface PulseMessageContext {
  /** Farmer-facing plot label (plot name). */
  plotName: string;
  locale?: string;
  /** ISO date of the forecast fetch (honesty: the advice states its basis). */
  forecastDate: string;
}

/**
 * Renders the farmer-facing message for a window result. Templates are plain
 * string interpolation — no free-form generation. Hausa/Yoruba templates are
 * v1 draft translations (content review tracked as a residual risk); unknown
 * locales fall back to English, mirroring the USSD menu engine's `t`.
 */
export function renderPulseMessage(
  result: Extract<PlantingWindowResult, { kind: 'window' | 'wait' }>,
  context: PulseMessageContext
): string {
  const locale: PulseLocale = (PULSE_LOCALES as readonly string[]).includes(context.locale ?? '')
    ? (context.locale as PulseLocale)
    : 'en';
  if (result.kind === 'window') {
    const slots = {
      crop: result.crop,
      plot: context.plotName,
      start: shortDate(result.windowStart),
      end: shortDate(result.windowEnd),
      onset: shortDate(result.onsetDate),
      rain: String(result.onsetRainMm),
      forecast: context.forecastDate
    };
    return fill(TEMPLATES[locale].window, slots);
  }
  const slots = {
    crop: result.crop,
    plot: context.plotName,
    days: '14',
    forecast: context.forecastDate
  };
  return fill(TEMPLATES[locale].wait, slots);
}

const TEMPLATES: Record<PulseLocale, { window: string; wait: string }> = {
  en: {
    window:
      'AgricPlatform: Plant {crop} on plot {plot} between {start} and {end}. ' +
      'Rain onset expected {onset} ({rain}mm over 3 days). Forecast: Open-Meteo {forecast}.',
    wait:
      'AgricPlatform: No reliable planting window for {crop} on plot {plot} in the next {days} days. ' +
      'Forecast rain stays below the onset threshold — wait and check again. Forecast: Open-Meteo {forecast}.'
  },
  // Draft translations (v1) — pending agronomy/content review before rollout.
  ha: {
    window:
      'AgricPlatform: Yi shukar {crop} a gonar {plot} tsakanin {start} da {end}. ' +
      'Ana sa ran farin ruwa a {onset} ({rain}mm cikin kwanaki 3). Hasashe: Open-Meteo {forecast}.',
    wait:
      'AgricPlatform: Babu ingantaccen lokutan shuka na {crop} a gonar {plot} cikin kwanaki {days} masu zuwa. ' +
      'Ruqan da ake sa rai bai isa ba — jira ka duba sake. Hasashe: Open-Meteo {forecast}.'
  },
  yo: {
    window:
      'AgricPlatform: Gbin {crop} ni oko {plot} laarin {start} ati {end}. ' +
      'A reti ibere ojo ni {onset} ({rain}mm ninu ojo meta). Asotele: Open-Meteo {forecast}.',
    wait:
      'AgricPlatform: Ko si window ogbin to da looto fun {crop} ni oko {plot} ninu ojo {days} to n bo. ' +
      'Ojo asotele ko to — duro, ki o si tun wo o. Asotele: Open-Meteo {forecast}.'
  }
};

/**
 * Substitutes `{slot}` markers in a template; unknown markers stay literal.
 * Implemented with split/join (no regex) so this file contains no literal
 * backslash sequences (MCP channel hazard — see PR #71 notes). Observable
 * behavior is identical to the previous regex pass: every `{key}` marker
 * for a known slot is replaced everywhere it appears, unknown `{...}`
 * markers are left untouched, and slot values are never re-scanned (slot
 * keys precede any value that could contain another marker).
 */
function fill(template: string, slots: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(slots)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }
  return rendered;
}
