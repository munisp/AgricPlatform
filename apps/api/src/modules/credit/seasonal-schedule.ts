import { BadRequestException } from '@nestjs/common';
import type { CreditSeasonalInstallment } from '@agric-platform/shared';

/**
 * SeasonSync — pure, deterministic harvest-linked schedule generator
 * (innovation wave 27, batch 1 #1). No I/O, no clocks, no randomness: the
 * same inputs always produce byte-identical installments, mirroring the
 * determinism doctrine of insurance/premium.ts.
 *
 * Shape: grace through the growing season (NO installment falls before the
 * harvest window opens), then 1–3 harvest-weighted balloon installments
 * inside the harvest window. Balloon weighting is increasing — later
 * installments are larger because crop is marketed progressively over the
 * window (weights 1..N over the installment index).
 *
 * Interest invariant is IDENTICAL to the equal-installment path
 * (credit.service.ts generateCreditSchedule): interest is the annual bps
 * rate prorated over the term, principal * bps * termDays / (10000 * 365),
 * computed with bigint — never floats. The sum of the seasonal installments
 * equals principal + interest exactly; residual kobo are distributed by
 * largest-remainder, ties breaking toward the later (larger) installment,
 * consistent with the equal path landing its remainder on the final
 * installment.
 */

const DAY_MS = 86_400_000;

export const SEASONAL_HARVEST_INSTALLMENTS_MIN = 1;
export const SEASONAL_HARVEST_INSTALLMENTS_MAX = 3;
export const SEASONAL_DEFAULT_HARVEST_INSTALLMENTS = 2;
/** Default harvest/marketing window length when derived from a plot planting. */
export const SEASONAL_DEFAULT_HARVEST_WINDOW_DAYS = 30;

export interface SeasonalScheduleInput {
  principalKobo: number;
  interestBpsAnnual: number;
  termDays: number;
  /** Schedule anchor (typically the preview/approval timestamp). */
  startIso: string;
  plantingDateIso: string;
  harvestWindowStartIso: string;
  harvestWindowEndIso: string;
  /** 1–3 balloon installments inside the harvest window (default 2). */
  harvestInstallments?: number;
}

function parseMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new BadRequestException(`SEASONAL_CALENDAR_INVALID: ${field} is not a valid date`);
  }
  return ms;
}

/**
 * Generates the seasonal installment list. Throws BadRequestException with
 * a stable `SEASONAL_*` code prefix on any invalid input — the generator
 * never clamps, invents, or fabricates calendar data.
 */
export function generateSeasonalSchedule(input: SeasonalScheduleInput): CreditSeasonalInstallment[] {
  if (!Number.isSafeInteger(input.principalKobo) || input.principalKobo < 1) {
    throw new BadRequestException('SEASONAL_PRINCIPAL: principalKobo must be an integer kobo amount >= 1');
  }
  if (!Number.isSafeInteger(input.interestBpsAnnual) || input.interestBpsAnnual < 0) {
    throw new BadRequestException('SEASONAL_RATE: interestBpsAnnual must be a non-negative integer');
  }
  if (!Number.isSafeInteger(input.termDays) || input.termDays < 1) {
    throw new BadRequestException('SEASONAL_TENOR: termDays must be a positive integer');
  }
  const count = input.harvestInstallments ?? SEASONAL_DEFAULT_HARVEST_INSTALLMENTS;
  if (
    !Number.isSafeInteger(count) ||
    count < SEASONAL_HARVEST_INSTALLMENTS_MIN ||
    count > SEASONAL_HARVEST_INSTALLMENTS_MAX
  ) {
    throw new BadRequestException(
      `SEASONAL_BALLOON_COUNT: harvestInstallments must be an integer between ` +
        `${SEASONAL_HARVEST_INSTALLMENTS_MIN} and ${SEASONAL_HARVEST_INSTALLMENTS_MAX}`
    );
  }

  const startMs = parseMs(input.startIso, 'startIso');
  const plantingMs = parseMs(input.plantingDateIso, 'plantingDateIso');
  const windowStartMs = parseMs(input.harvestWindowStartIso, 'harvestWindowStartIso');
  const windowEndMs = parseMs(input.harvestWindowEndIso, 'harvestWindowEndIso');

  if (windowEndMs <= windowStartMs) {
    throw new BadRequestException(
      'SEASONAL_WINDOW_ORDER: harvestWindowEnd must be after harvestWindowStart'
    );
  }
  if (plantingMs >= windowStartMs) {
    throw new BadRequestException(
      'SEASONAL_WINDOW_ORDER: plantingDate must be before the harvest window opens'
    );
  }
  if (windowStartMs < startMs) {
    throw new BadRequestException(
      'SEASONAL_WINDOW_BEFORE_START: the harvest window opens before the schedule start; ' +
        'a grace-shaped schedule cannot be built on an elapsed season'
    );
  }
  if (windowEndMs > startMs + input.termDays * DAY_MS) {
    throw new BadRequestException(
      'SEASONAL_WINDOW_BEYOND_TENOR: the harvest window ends after the loan term; ' +
        'extend the product tenor or shorten the window'
    );
  }

  // Interest invariant identical to generateCreditSchedule (bigint, exact).
  const principal = BigInt(input.principalKobo);
  const interest =
    (principal * BigInt(input.interestBpsAnnual) * BigInt(input.termDays)) / (10_000n * 365n);
  const total = principal + interest;

  // Increasing balloon weights 1..count; W = count*(count+1)/2.
  const weightSum = BigInt((count * (count + 1)) / 2);
  const amounts: bigint[] = [];
  const fractional: bigint[] = [];
  let assigned = 0n;
  for (let index = 0; index < count; index += 1) {
    const raw = total * BigInt(index + 1);
    const floor = raw / weightSum;
    amounts.push(floor);
    fractional.push(raw % weightSum);
    assigned += floor;
  }
  // Largest-remainder distribution of the residual kobo; ties break toward
  // the later installment (balloon-consistent).
  const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => {
    if (fractional[a] !== fractional[b]) {
      return fractional[a] < fractional[b] ? 1 : -1;
    }
    return b - a;
  });
  const remainder = total - assigned;
  for (let k = 0n; k < remainder; k += 1n) {
    amounts[order[Number(k)]] += 1n;
  }

  // Due dates: evenly spaced across the harvest window, first installment at
  // the window open and the last at the window close (single-balloon loans
  // fall due at the window open).
  const schedule: CreditSeasonalInstallment[] = [];
  for (let index = 0; index < count; index += 1) {
    const dueMs =
      count === 1
        ? windowStartMs
        : windowStartMs + Math.round((index * (windowEndMs - windowStartMs)) / (count - 1));
    schedule.push({
      sequence: index + 1,
      dueAt: new Date(dueMs).toISOString(),
      amountKobo: Number(amounts[index])
    });
  }
  return schedule;
}

/** Sum of installment amounts — the principal + interest invariant. */
export function seasonalScheduleTotalKobo(installments: readonly CreditSeasonalInstallment[]): number {
  return installments.reduce((sum, installment) => sum + installment.amountKobo, 0);
}
