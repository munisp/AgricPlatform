import { BadRequestException } from '@nestjs/common';

/**
 * Simple-interest schedule math for small internal VSLA loans (wave
 * VSLACARBON). Interest is charged ONCE over the loan term at a flat rate
 * in basis points — the classic VSLA "service charge" model — with integer
 * kobo math throughout:
 *
 *   interestKobo = floor(principalKobo * rateBps / 10_000)
 *   totalDueKobo = principalKobo + interestKobo
 */

/** Maximum flat rate: 30% per loan term (3_000 bps) — usury guard. */
export const MAX_VSLA_INTEREST_RATE_BPS = 3_000;

export function simpleInterestKobo(principalKobo: number, rateBps: number): number {
  assertLoanTerms(principalKobo, rateBps);
  return Math.floor((principalKobo * rateBps) / 10_000);
}

export function totalDueKobo(principalKobo: number, rateBps: number): number {
  return principalKobo + simpleInterestKobo(principalKobo, rateBps);
}

export function assertLoanTerms(principalKobo: number, rateBps: number): void {
  if (!Number.isSafeInteger(principalKobo) || principalKobo <= 0) {
    throw new BadRequestException('principalKobo must be a positive integer kobo value');
  }
  if (
    !Number.isSafeInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > MAX_VSLA_INTEREST_RATE_BPS
  ) {
    throw new BadRequestException(
      `interestRateBps must be an integer between 0 and ${MAX_VSLA_INTEREST_RATE_BPS}`
    );
  }
}
