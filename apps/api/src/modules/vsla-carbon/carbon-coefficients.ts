import { BadRequestException } from '@nestjs/common';
import type { CarbonPracticeType } from '../../database/repositories/vsla-carbon.repository.js';

/**
 * Carbon ESTIMATE coefficient table (wave VSLACARBON). Deterministic,
 * versioned and committed in the repo so every persisted estimate names the
 * exact table that produced it.
 *
 * These are rough screening factors for donor/MRV reporting ONLY — the
 * figures they produce are ALWAYS labelled basis 'estimate' and are NOT
 * verification-grade. They are deliberately conservative, order-of-magnitude
 * annual sequestration factors for smallholder sub-Saharan systems,
 * synthesised from public literature:
 *
 *   - IPCC 2006 Guidelines for National Greenhouse Gas Inventories, Vol. 4
 *     (AFOLU), Ch. 4 default biomass carbon increments for agroforestry and
 *     perennial systems (using the 44/12 CO2:C ratio).
 *   - IPCC 2019 Refinement to the 2006 Guidelines, Vol. 4 — soil carbon
 *     stock-change factors for conservation tillage / reduced disturbance.
 *   - Bayala et al. & FMNR field literature (e.g. "Farmer-managed natural
 *     regeneration" parkland studies, Sahel) — tree-cover accrual in the
 *     low single-digit tCO2e/ha/yr range for assisted regeneration.
 *
 * They are NOT a carbon-standard methodology (no Verra/Gold Standard
 * endorsement is claimed or implied). Credit issuance requires the external
 * gates documented in docs/vsla-carbon-mrv.md.
 */

export const CO2E_COEFFICIENT_VERSION = 'v1.2026.1';

export interface CarbonCoefficient {
  practiceType: CarbonPracticeType;
  /** Milli-tonnes CO2e sequestered per hectare per year (tonnes * 1000). */
  co2eMilliTonnesPerHaYear: number;
  /** Short human citation for docs/UI honesty. */
  source: string;
}

export const CARBON_COEFFICIENTS: readonly CarbonCoefficient[] = [
  {
    practiceType: 'agroforestry',
    co2eMilliTonnesPerHaYear: 4_000,
    source: 'IPCC 2006 GL Vol.4 AFOLU agroforestry biomass increments (44/12 CO2:C)'
  },
  {
    practiceType: 'fmnr',
    co2eMilliTonnesPerHaYear: 3_000,
    source: 'FMNR parkland regeneration literature, Sahel (conservative tree-cover accrual)'
  },
  {
    practiceType: 'woodlot',
    co2eMilliTonnesPerHaYear: 6_000,
    source: 'IPCC 2006 GL Vol.4 planted-forest biomass increments, tropical dry (44/12 CO2:C)'
  },
  {
    practiceType: 'conservation_agriculture',
    co2eMilliTonnesPerHaYear: 1_000,
    source: 'IPCC 2019 Refinement Vol.4 soil-carbon stock-change factors, reduced disturbance'
  }
] as const;

export function coefficientFor(practiceType: CarbonPracticeType): CarbonCoefficient {
  const coefficient = CARBON_COEFFICIENTS.find((entry) => entry.practiceType === practiceType);
  if (!coefficient) {
    throw new BadRequestException(`No carbon coefficient for practice type '${practiceType}'`);
  }
  return coefficient;
}

export interface CarbonEstimateInput {
  /** Hectares * 100 (fixed-point). */
  hectaresCenti: number;
  practiceType: CarbonPracticeType;
  /** Observed survival 0-100. */
  survivalRatePct: number;
  /** Number of seasons the practice has been adopted (>= 1). */
  seasonCount: number;
}

/**
 * Deterministic ESTIMATE: tonnes CO2e (milli-tonnes, fixed-point) =
 * hectares * rate * survival * seasons, with ONE integer floor at the end
 * so re-computation is byte-stable. Pure function of the versioned table —
 * no clock, no randomness.
 */
export function computeCo2eEstimateMilliTonnes(input: CarbonEstimateInput): number {
  if (!Number.isSafeInteger(input.hectaresCenti) || input.hectaresCenti <= 0) {
    throw new BadRequestException('hectaresCenti must be a positive integer (hectares * 100)');
  }
  if (
    !Number.isSafeInteger(input.survivalRatePct) ||
    input.survivalRatePct < 0 ||
    input.survivalRatePct > 100
  ) {
    throw new BadRequestException('survivalRatePct must be an integer between 0 and 100');
  }
  if (!Number.isSafeInteger(input.seasonCount) || input.seasonCount < 1) {
    throw new BadRequestException('seasonCount must be a positive integer');
  }
  const rate = coefficientFor(input.practiceType).co2eMilliTonnesPerHaYear;
  // Single division point: floor at the end keeps the estimate exact and
  // deterministic across runtimes.
  return Math.floor(
    (input.hectaresCenti * rate * input.survivalRatePct * input.seasonCount) / (100 * 100)
  );
}
