/**
 * Lender Lens (Stage 27, innovation #20) — pure scorecard assembly.
 *
 * Everything in this file is deterministic and side-effect free so that a
 * scorecard payload for (lender, version, period) is REPRODUCIBLE: given the
 * stored version definition and the same facts, `assembleScorecard` yields a
 * byte-identical payload and therefore an identical payload_hash (SHA-256
 * over the canonical JSON — sorted keys, no whitespace).
 *
 * PAR semantics come from `modules/credit/par.ts` (the single shared
 * implementation also used by the credit portfolio endpoint) — the scorecard
 * never re-implements PAR, it reconstructs as-of-period repayment facts and
 * calls the shared accumulation with the period-end instant.
 *
 * Privacy doctrine: payloads are ALL-AGGREGATE. No farmer identifier may
 * ever appear — `SCORECARD_PII_KEY_DENYLIST` /
 * `assertPayloadHasNoPii` enforce this structurally, and the pg contract
 * test re-checks it independently. Cross-lender benchmark cells apply the
 * k-anonymity floor (default >= 5 lenders per cell, else suppressed) — the
 * same doctrine as Chapter Map (innovation #10).
 *
 * No backslashes in this file by repo convention (see Stage-27 doctrine).
 */
import { createHash } from 'node:crypto';
import type { CreditLoanStatus, CreditRepaymentStatus } from '@agric-platform/shared';
import { computeParMetrics, parRatioBps, type ParLoanFact, type ParMetrics } from '../credit/par.js';
import { lagosDayRange } from './retention.js';

/* ------------------------------------------------------- definitions -- */

/**
 * Scorecard version definition (stored as analytics.lender_scorecard_versions
 * .definition jsonb). Pinning contract: changing any field REQUIRES a new
 * version string; a published version's definition is immutable.
 */
export interface ScorecardVersionDefinition {
  /** PAR windows in days; default [30, 60, 90]. */
  parWindowsDays: number[];
  /** Cohort rule for vintage curves; v1 pins 'origination_month'. */
  vintageCohort: 'origination_month';
  /** Geo bands with share below this (bps of outstanding) fold into 'other'. */
  geoMixFloorBps: number;
  /** k-anonymity floor for cross-lender benchmark cells (default 5). */
  kAnonymityFloor: number;
  /** Projector heartbeat lag beyond which served scorecards carry a stale badge. */
  staleThresholdMs: number;
}

export const DEFAULT_SCORECARD_DEFINITION: ScorecardVersionDefinition = {
  parWindowsDays: [30, 60, 90],
  vintageCohort: 'origination_month',
  geoMixFloorBps: 500,
  kAnonymityFloor: 5,
  staleThresholdMs: 6 * 60 * 60 * 1000
};

/** Validates/normalizes a raw definition; throws on anything unsupported. */
export function normalizeDefinition(raw: unknown): ScorecardVersionDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('scorecard definition must be an object');
  }
  const input = raw as Record<string, unknown>;
  const merged: ScorecardVersionDefinition = {
    ...DEFAULT_SCORECARD_DEFINITION,
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    )
  } as ScorecardVersionDefinition;
  const windows = merged.parWindowsDays;
  if (
    !Array.isArray(windows) ||
    windows.length !== 3 ||
    !windows.every((w) => Number.isInteger(w) && w > 0) ||
    windows.join(',') !== '30,60,90'
  ) {
    throw new Error("parWindowsDays must be exactly [30, 60, 90] (the shared PAR implementation's windows)");
  }
  if (merged.vintageCohort !== 'origination_month') {
    throw new Error("vintageCohort must be 'origination_month' (v1)");
  }
  if (!Number.isInteger(merged.geoMixFloorBps) || merged.geoMixFloorBps < 0 || merged.geoMixFloorBps > 10_000) {
    throw new Error('geoMixFloorBps must be an integer between 0 and 10000');
  }
  if (!Number.isInteger(merged.kAnonymityFloor) || merged.kAnonymityFloor < 2) {
    throw new Error('kAnonymityFloor must be an integer >= 2');
  }
  if (!Number.isInteger(merged.staleThresholdMs) || merged.staleThresholdMs <= 0) {
    throw new Error('staleThresholdMs must be a positive integer');
  }
  return merged;
}

/* ------------------------------------------------------------ payload -- */

export interface ScorecardRepaymentFact {
  dueAt: string;
  amountKobo: number;
  status: CreditRepaymentStatus;
  paidAt?: string;
}

/**
 * Loan fact for scorecard assembly. Carries only aggregate-safe attributes:
 * the product id (product mix), the borrower's STATE (geo mix band) and the
 * schedule. Never carries a farmer/user identifier.
 */
export interface ScorecardLoanFact {
  productId: string;
  borrowerState?: string;
  status: CreditLoanStatus;
  createdAt: string;
  repayments: readonly ScorecardRepaymentFact[];
}

export interface ScorecardVintageRow {
  /** Origination cohort 'YYYY-MM' (Lagos). */
  cohort: string;
  activeLoans: number;
  outstandingKobo: number;
  par30Bps: number;
  par60Bps: number;
  par90Bps: number;
}

export interface ScorecardMixBand {
  /** State name or 'other' (geo); product id (product mix). */
  band: string;
  outstandingKobo: number;
  shareBps: number;
}

export interface LenderScorecardPayload {
  schema: 'lender-scorecard/1';
  version: string;
  /** Lagos calendar month 'YYYY-MM'. */
  period: string;
  lenderPartnerId: string;
  /** End of the period (exclusive), ISO-8601 UTC. */
  dataAsOf: string;
  portfolio: ParMetrics;
  vintages: ScorecardVintageRow[];
  geoMix: ScorecardMixBand[];
  productMix: ScorecardMixBand[];
}

const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function assertPeriodFormat(period: string): void {
  if (!PERIOD_PATTERN.test(period)) {
    throw new Error(`period must be a Lagos calendar month 'YYYY-MM', got '${period}'`);
  }
}

/** Exclusive end of a Lagos calendar month as an instant. */
export function periodEnd(period: string): Date {
  assertPeriodFormat(period);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const key = `${period}-${String(lastDay).padStart(2, '0')}`;
  return lagosDayRange(key).end;
}

/**
 * Reconstructs the PAR input facts as of `asOfMs`: a repayment whose paidAt
 * is after the as-of instant is coerced back to unpaid ('pending') so the
 * shared PAR accumulation sees the period-end state. Repayments stored as
 * 'paid' without a paidAt timestamp stay paid (recorded before the period
 * reconstruction existed — documented v1 approximation, see definition).
 */
function asOfFacts(facts: readonly ScorecardLoanFact[], asOfMs: number): ParLoanFact[] {
  return facts
    .filter((loan) => Date.parse(loan.createdAt) < asOfMs)
    .map((loan) => ({
      status: loan.status,
      repayments: loan.repayments.map((repayment) => ({
        dueAt: repayment.dueAt,
        amountKobo: repayment.amountKobo,
        status:
          repayment.paidAt && Date.parse(repayment.paidAt) >= asOfMs && repayment.status === 'paid'
            ? ('pending' as CreditRepaymentStatus)
            : repayment.status
      }))
    }));
}

/** Unpaid installment kobo for one loan as of the instant (mix-band shares). */
function unpaidKoboAt(loan: ParLoanFact): number {
  return loan.repayments
    .filter((repayment) => repayment.status !== 'paid')
    .reduce((sum, repayment) => sum + repayment.amountKobo, 0);
}

function isActive(status: CreditLoanStatus): boolean {
  return status === 'disbursed' || status === 'repaying';
}

/**
 * Assembles the immutable scorecard payload. PURE: identical (definition,
 * facts, period) inputs always produce an identical payload object.
 */
export function assembleScorecard(
  definition: ScorecardVersionDefinition,
  lenderPartnerId: string,
  version: string,
  period: string,
  facts: readonly ScorecardLoanFact[]
): LenderScorecardPayload {
  const asOf = periodEnd(period);
  const asOfMs = asOf.getTime();
  const scoped = facts.filter((loan) => Date.parse(loan.createdAt) < asOfMs);
  const reconstructed = asOfFacts(scoped, asOfMs);

  // Portfolio PAR — the shared credit implementation, period-end instant.
  const portfolio = computeParMetrics(reconstructed, asOfMs);

  // Vintage curves: origination cohort (createdAt month) x the shared PAR.
  const cohorts = new Map<string, ParLoanFact[]>();
  for (let i = 0; i < scoped.length; i += 1) {
    const cohort = scoped[i]!.createdAt.slice(0, 7);
    const bucket = cohorts.get(cohort) ?? [];
    bucket.push(reconstructed[i]!);
    cohorts.set(cohort, bucket);
  }
  const vintages: ScorecardVintageRow[] = [...cohorts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, loans]) => {
      const metrics = computeParMetrics(loans, asOfMs);
      return {
        cohort,
        activeLoans: metrics.activeLoans,
        outstandingKobo: metrics.outstandingKobo,
        par30Bps: metrics.par30Bps,
        par60Bps: metrics.par60Bps,
        par90Bps: metrics.par90Bps
      };
    });

  // Geo + product mix: outstanding-kobo share per band over active loans.
  const active = scoped
    .map((loan, index) => ({ loan, reconstructed: reconstructed[index]! }))
    .filter(({ loan }) => isActive(loan.status));
  const totalOutstanding = active.reduce(
    (sum, { reconstructed }) => sum + unpaidKoboAt(reconstructed),
    0
  );
  const mix = (bandOf: (loan: ScorecardLoanFact) => string): ScorecardMixBand[] => {
    const perBand = new Map<string, number>();
    for (const { loan, reconstructed } of active) {
      const band = bandOf(loan);
      perBand.set(band, (perBand.get(band) ?? 0) + unpaidKoboAt(reconstructed));
    }
    const rows = [...perBand.entries()]
      .map(([band, kobo]) => ({
        band,
        outstandingKobo: kobo,
        shareBps: parRatioBps(kobo, totalOutstanding)
      }))
      .sort((a, b) => b.shareBps - a.shareBps || a.band.localeCompare(b.band));
    return rows;
  };
  const geoRaw = mix((loan) => loan.borrowerState ?? 'unknown');
  // Small bands fold into 'other' so thin geographies cannot be reverse-
  // engineered against the benchmark cells (k-anonymity doctrine companion).
  const geoMix: ScorecardMixBand[] = [];
  let otherKobo = 0;
  for (const row of geoRaw) {
    if (row.band !== 'unknown' && row.shareBps < definition.geoMixFloorBps) {
      otherKobo += row.outstandingKobo;
    } else {
      geoMix.push(row);
    }
  }
  if (otherKobo > 0) {
    geoMix.push({
      band: 'other',
      outstandingKobo: otherKobo,
      shareBps: parRatioBps(otherKobo, totalOutstanding)
    });
  }
  const productMix = mix((loan) => loan.productId);

  return {
    schema: 'lender-scorecard/1',
    version,
    period,
    lenderPartnerId,
    dataAsOf: asOf.toISOString(),
    portfolio,
    vintages,
    geoMix,
    productMix
  };
}

/* ----------------------------------------------- canonical hashing -- */

/** Canonical JSON: recursively sorted object keys, compact separators. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Lower-case hex SHA-256 over the canonical JSON of any value. */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Lower-case hex SHA-256 over the canonical JSON of the payload. */
export function scorecardPayloadHash(payload: LenderScorecardPayload): string {
  return canonicalSha256(payload);
}

/* -------------------------------------------------- PII denylisting -- */

/**
 * Substrings (lower-cased) that must NEVER appear in a scorecard payload key
 * — every one is a farmer-identifier channel. Lender/partner identifiers are
 * organisation-level and allowed ('lenderpartnerid' contains none of these).
 */
export const SCORECARD_PII_KEY_DENYLIST = [
  'userid',
  'farmer',
  'borrower',
  'applicant',
  'guarantor',
  'nin',
  'bvn',
  'phone',
  'email',
  'fullname',
  'firstname',
  'lastname'
] as const;

/** Recursively asserts no payload key matches the farmer-PII denylist. */
export function assertPayloadHasNoPii(value: unknown, path = 'payload'): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPayloadHasNoPii(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    for (const denied of SCORECARD_PII_KEY_DENYLIST) {
      if (normalized.includes(denied)) {
        throw new Error(
          `scorecard payload key '${path}.${key}' matches farmer-PII denylist entry '${denied}' — ` +
            'scorecards are aggregate-only'
        );
      }
    }
    assertPayloadHasNoPii(child, `${path}.${key}`);
  }
}

/* -------------------------------------------------------- benchmarks -- */

export interface BenchmarkCell {
  metric: 'par30_bps' | 'par60_bps' | 'par90_bps';
  band: string;
  lenderCount: number;
  /** NULL when suppressed by the k-anonymity floor. */
  valueBps: number | null;
  suppressed: boolean;
}

export interface BenchmarkInput {
  lenderPartnerId: string;
  payload: LenderScorecardPayload;
}

const BENCHMARK_METRICS = [
  { metric: 'par30_bps', read: (p: LenderScorecardPayload) => p.portfolio.par30Bps },
  { metric: 'par60_bps', read: (p: LenderScorecardPayload) => p.portfolio.par60Bps },
  { metric: 'par90_bps', read: (p: LenderScorecardPayload) => p.portfolio.par90Bps }
] as const;

/**
 * Cross-lender benchmark cells for one (version, period). k-anonymity floor:
 * a cell is published only when at least `definition.kAnonymityFloor`
 * distinct lenders contribute; below the floor the cell is returned with
 * suppressed = true and valueBps = null (stored, so "suppressed" is
 * distinguishable from "missing"). One row per lender is assumed — the
 * repository enforces the (lender, version, period) natural key.
 */
export function computeBenchmarkCells(
  definition: ScorecardVersionDefinition,
  scorecards: readonly BenchmarkInput[]
): BenchmarkCell[] {
  const lenders = new Set(scorecards.map((row) => row.lenderPartnerId));
  const lenderCount = lenders.size;
  const underFloor = lenderCount < definition.kAnonymityFloor;
  return BENCHMARK_METRICS.map(({ metric, read }) => {
    if (underFloor) {
      return { metric, band: 'all', lenderCount, valueBps: null, suppressed: true };
    }
    const values = scorecards.map((row) => read(row.payload));
    const mean = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    return { metric, band: 'all', lenderCount, valueBps: mean, suppressed: false };
  });
}
