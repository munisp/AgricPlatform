/**
 * Business-hours-aware SLA clock for the agronomist console (Stage 27
 * innovation #19). Pure and deterministic: the SLA is a number of BUSINESS
 * hours counted only inside the configured window on configured weekdays
 * (UTC, config-driven via AGRONOMIST_SLA_* env — see .env.example). An
 * escalation raised Friday evening against a Mon–Fri window is due Monday
 * morning, not Saturday night — the honest interpretation of "answered
 * within N working hours".
 */

export interface SlaBusinessHoursConfig {
  /** SLA length in business hours. */
  slaBusinessHours: number;
  /** Window start hour UTC, inclusive (0–23). */
  windowStartHour: number;
  /** Window end hour UTC, exclusive (1–24, > windowStartHour). */
  windowEndHour: number;
  /** Business weekdays, 0=Sunday … 6=Saturday (UTC). */
  businessDays: number[];
}

export const SLA_BUSINESS_HOURS_DEFAULT = 4;
export const SLA_WINDOW_START_DEFAULT = 8;
export const SLA_WINDOW_END_DEFAULT = 17;
export const SLA_BUSINESS_DAYS_DEFAULT = [1, 2, 3, 4, 5];

const HOUR_MS = 3_600_000;
/** Iteration backstop for degenerate configs (never loops forever). */
const MAX_DAYS = 370;

function clampHour(raw: number, fallback: number, max: number): number {
  return Number.isFinite(raw) && raw >= 0 && raw <= max ? Math.floor(raw) : fallback;
}

/** Parses the SLA clock config from env; every field falls back sanely. */
export function slaConfigFromEnv(env: NodeJS.ProcessEnv): SlaBusinessHoursConfig {
  const hours = Number(env.AGRONOMIST_SLA_BUSINESS_HOURS);
  const start = clampHour(Number(env.AGRONOMIST_SLA_WINDOW_START), SLA_WINDOW_START_DEFAULT, 23);
  const endRaw = clampHour(Number(env.AGRONOMIST_SLA_WINDOW_END), SLA_WINDOW_END_DEFAULT, 24);
  const daysRaw = (env.AGRONOMIST_SLA_BUSINESS_DAYS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return {
    slaBusinessHours: Number.isFinite(hours) && hours > 0 ? hours : SLA_BUSINESS_HOURS_DEFAULT,
    windowStartHour: start,
    windowEndHour: endRaw > start ? endRaw : SLA_WINDOW_END_DEFAULT,
    businessDays: daysRaw.length > 0 ? [...new Set(daysRaw)].sort() : [...SLA_BUSINESS_DAYS_DEFAULT]
  };
}

/**
 * Computes the SLA deadline: `slaBusinessHours` business hours after
 * `start`, counting only time inside the business window on business days.
 * A degenerate config (no business days) fails visibly — the deadline is
 * `start` itself, so the breacher sweep flags the case immediately rather
 * than the case silently never falling due.
 */
export function computeSlaDueAt(start: Date, config: SlaBusinessHoursConfig): Date {
  let remainingMs = Math.max(0, config.slaBusinessHours) * HOUR_MS;
  if (remainingMs === 0 || config.businessDays.length === 0) {
    return new Date(start.getTime());
  }
  const cursor = new Date(start.getTime());
  for (let dayOffset = 0; dayOffset < MAX_DAYS; dayOffset++) {
    const dayStart = Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate() + dayOffset
    );
    const day = new Date(dayStart);
    if (!config.businessDays.includes(day.getUTCDay())) {
      continue;
    }
    const windowStart = dayStart + config.windowStartHour * HOUR_MS;
    const windowEnd = dayStart + config.windowEndHour * HOUR_MS;
    const fromMs = dayOffset === 0 ? Math.max(cursor.getTime(), windowStart) : windowStart;
    if (fromMs >= windowEnd) {
      continue;
    }
    const availableMs = windowEnd - fromMs;
    if (remainingMs <= availableMs) {
      return new Date(fromMs + remainingMs);
    }
    remainingMs -= availableMs;
  }
  return new Date(start.getTime());
}
