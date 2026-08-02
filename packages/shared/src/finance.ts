/**
 * Wave P2a finance math: VAT, equal-installment amortisation and the
 * versioned credit scoring function. All money is integer kobo; these
 * functions never return floats (amortisation uses BigInt fixed-point so
 * results are deterministic across runtimes).
 */

/** Nigeria VAT rate in basis points (7.5%). */
export const VAT_RATE_BPS = 750;

/** VAT on a kobo subtotal, rounded to the nearest kobo (integer math). */
export function computeVatKobo(subtotalKobo: number): number {
  assertKobo(subtotalKobo, 'subtotalKobo');
  return Math.round((subtotalKobo * VAT_RATE_BPS) / 10_000);
}

function assertKobo(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer kobo amount`);
  }
}

export interface AmortisationInput {
  principalKobo: number;
  /** Annual interest in basis points (integer; 0 allowed). */
  annualRateBps: number;
  termMonths: number;
  /** ISO date (YYYY-MM-DD) of the first installment; later ones step monthly. */
  firstDueDate: string;
}

export interface AmortisationInstallment {
  sequence: number;
  dueDate: string;
  principalKobo: number;
  interestKobo: number;
  totalKobo: number;
}

/** Monthly due dates from an ISO start date, clamped to the month end. */
export function addMonthsIso(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Round half-up for BigInt numerator/denominator division. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Equal-installment (annuity) amortisation in integer kobo.
 *
 * The constant payment A = P·b·(d+b)^n / (d·((d+b)^n − d^n)) with
 * b = annualRateBps, d = 120000 (monthly basis-point denominator) is
 * evaluated exactly in BigInt and rounded once to kobo. Each period's
 * interest is round(balance·b/d); the final installment absorbs the
 * rounding remainder so sum(principal) === principalKobo exactly.
 */
export function generateAmortisationSchedule(input: AmortisationInput): AmortisationInstallment[] {
  assertKobo(input.principalKobo, 'principalKobo');
  assertKobo(input.annualRateBps, 'annualRateBps');
  if (!Number.isSafeInteger(input.termMonths) || input.termMonths < 1) {
    throw new Error('termMonths must be a positive integer');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstDueDate)) {
    throw new Error('firstDueDate must be an ISO date (YYYY-MM-DD)');
  }

  const n = input.termMonths;
  const principal = BigInt(input.principalKobo);
  const bps = BigInt(input.annualRateBps);
  const denominator = 120_000n;

  let payment: bigint;
  if (bps === 0n) {
    payment = divRound(principal, BigInt(n));
  } else {
    const pow = (denominator + bps) ** BigInt(n);
    const den = denominator ** BigInt(n);
    payment = divRound(principal * bps * pow, denominator * (pow - den));
  }

  const installments: AmortisationInstallment[] = [];
  let balance = principal;
  for (let sequence = 1; sequence <= n; sequence += 1) {
    const interest = divRound(balance * bps, denominator);
    const isLast = sequence === n;
    const principalPart = isLast ? balance : payment - interest;
    if (principalPart <= 0n) {
      throw new Error('amortisation underflow: installment does not cover interest');
    }
    balance -= principalPart;
    installments.push({
      sequence,
      dueDate: addMonthsIso(input.firstDueDate, sequence - 1),
      principalKobo: Number(principalPart),
      interestKobo: Number(interest),
      totalKobo: Number(principalPart + interest)
    });
  }
  return installments;
}

/* ---------------------------------------------------------------------------
 * Versioned credit scoring (deterministic; unit-tested).
 * ------------------------------------------------------------------------- */

export const CREDIT_SCORE_VERSION = 'credit-score/v1';

export interface CreditScoreSignals {
  completedCourses: number;
  completedOrders: number;
  repaidLoans: number;
  defaultedLoans: number;
  onTimeRepayments: number;
  lateRepayments: number;
  verifiedDocuments: number;
}

export interface CreditScoreBreakdown {
  score: number;
  components: Record<string, number>;
}

function clampSignals(signals: CreditScoreSignals): CreditScoreSignals {
  const out = { ...signals };
  for (const [key, value] of Object.entries(out)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`credit signal '${key}' must be a non-negative integer`);
    }
  }
  return out;
}

/**
 * credit-score/v1: platform-signal score in [0, 100].
 *   base                10
 *   training            min(30, completedCourses × 6)
 *   trade history       min(25, completedOrders × 5)
 *   repayment history   min(25, repaidLoans × 12 + onTimeRepayments × 2)
 *   documentation       min(10, verifiedDocuments × 5)
 *   penalties           defaultedLoans × 20 + lateRepayments × 3
 * Pure integer arithmetic — identical inputs always yield identical scores.
 */
export function computeCreditScore(rawSignals: CreditScoreSignals): CreditScoreBreakdown {
  const signals = clampSignals(rawSignals);
  const components: Record<string, number> = {
    base: 10,
    training: Math.min(30, signals.completedCourses * 6),
    trade_history: Math.min(25, signals.completedOrders * 5),
    repayment_history: Math.min(25, signals.repaidLoans * 12 + signals.onTimeRepayments * 2),
    documentation: Math.min(10, signals.verifiedDocuments * 5),
    penalties: signals.defaultedLoans * 20 + signals.lateRepayments * 3
  };
  const positive =
    components.base +
    components.training +
    components.trade_history +
    components.repayment_history +
    components.documentation;
  const score = Math.max(0, Math.min(100, positive - components.penalties));
  return { score, components };
}
