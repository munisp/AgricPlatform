/**
 * Pure portfolio-at-risk (PAR) accumulation — Stage 27, innovation #20
 * ("Lender Lens") extraction.
 *
 * This is THE single implementation of the platform's PAR definition,
 * extracted unchanged from `CreditService.portfolio()` so the credit
 * reporting endpoint and the analytics lender-scorecard assembly
 * (`modules/analytics/lender-scorecard.ts`) share one formula instead of
 * drifting copies:
 *
 *   PAR-N = outstanding kobo on active (disbursed|repaying) loans with any
 *   repayment overdue >= N days, expressed in integer basis points of total
 *   outstanding kobo. Outstanding = sum of unpaid installment amounts on
 *   disbursed|repaying loans; defaulted stock is accumulated separately.
 *
 * The function is pure and float-free: callers pass the facts (loan status
 * + repayment schedule facts) and the "as of" instant in milliseconds. The
 * scorecard projector reconstructs as-of-period facts (a repayment with
 * `paidAt <= asOf` is passed with status 'paid') and calls this with the
 * period end — the same code path then answers both "PAR now" (credit
 * module) and "PAR at period end, per vintage cohort" (analytics module).
 */

import type { CreditLoanStatus, CreditRepaymentStatus } from '@agric-platform/shared';

const DAY_MS = 86_400_000;

/** Repayment schedule fact the PAR accumulation reads. */
export interface ParRepaymentFact {
  dueAt: string;
  amountKobo: number;
  status: CreditRepaymentStatus;
}

/** Loan fact the PAR accumulation reads (status + its schedule facts). */
export interface ParLoanFact {
  status: CreditLoanStatus;
  repayments: readonly ParRepaymentFact[];
}

/** Integer-kobo / basis-point PAR metrics (float-free). */
export interface ParMetrics {
  activeLoans: number;
  defaultedLoans: number;
  outstandingKobo: number;
  defaultedKobo: number;
  par30Kobo: number;
  par60Kobo: number;
  par90Kobo: number;
  par30Bps: number;
  par60Bps: number;
  par90Bps: number;
}

/** part / outstanding in integer basis points; 0 when nothing is outstanding. */
export function parRatioBps(part: number, outstandingKobo: number): number {
  return outstandingKobo > 0 ? Math.round((part * 10_000) / outstandingKobo) : 0;
}

/**
 * Accumulates PAR metrics over the given loan facts as of `asOfMs`
 * (milliseconds since epoch). Identical semantics to the historical
 * CreditService.portfolio() loop.
 */
export function computeParMetrics(
  loans: readonly ParLoanFact[],
  asOfMs: number
): ParMetrics {
  let activeLoans = 0;
  let defaultedLoans = 0;
  let outstandingKobo = 0;
  let defaultedKobo = 0;
  let par30Kobo = 0;
  let par60Kobo = 0;
  let par90Kobo = 0;
  for (const loan of loans) {
    if (loan.status !== 'disbursed' && loan.status !== 'repaying' && loan.status !== 'defaulted') {
      continue;
    }
    const unpaid = loan.repayments.filter((repayment) => repayment.status !== 'paid');
    const unpaidKobo = unpaid.reduce((sum, repayment) => sum + repayment.amountKobo, 0);
    if (loan.status === 'defaulted') {
      defaultedLoans += 1;
      defaultedKobo += unpaidKobo;
      continue;
    }
    activeLoans += 1;
    outstandingKobo += unpaidKobo;
    let maxOverdueDays = 0;
    for (const repayment of unpaid) {
      const overdueMs = asOfMs - Date.parse(repayment.dueAt);
      if (overdueMs > 0) {
        maxOverdueDays = Math.max(maxOverdueDays, Math.floor(overdueMs / DAY_MS));
      }
    }
    if (maxOverdueDays >= 30) par30Kobo += unpaidKobo;
    if (maxOverdueDays >= 60) par60Kobo += unpaidKobo;
    if (maxOverdueDays >= 90) par90Kobo += unpaidKobo;
  }
  return {
    activeLoans,
    defaultedLoans,
    outstandingKobo,
    defaultedKobo,
    par30Kobo,
    par60Kobo,
    par90Kobo,
    par30Bps: parRatioBps(par30Kobo, outstandingKobo),
    par60Bps: parRatioBps(par60Kobo, outstandingKobo),
    par90Bps: parRatioBps(par90Kobo, outstandingKobo)
  };
}
