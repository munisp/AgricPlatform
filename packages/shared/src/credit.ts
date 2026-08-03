/**
 * Credit suite types (Wave CREDIT — best-of-both merge of the
 * farmer-data-collection microfinance suite into AgricPlatform).
 *
 * Money is integer kobo throughout — never floats. PostgreSQL columns are
 * bigint; the API carries safe integers (validated with Number.isSafeInteger
 * at the trust boundary) and all interest/proration math is computed with
 * bigint internally before being narrowed.
 */

/* ----------------------------------------------------------- statuses -- */

export const CREDIT_LOAN_STATUSES = [
  'draft',
  'submitted',
  'scoring',
  'approved',
  'rejected',
  'disbursed',
  'repaying',
  'repaid',
  'defaulted',
  'written_off'
] as const;
export type CreditLoanStatus = (typeof CREDIT_LOAN_STATUSES)[number];

export const CREDIT_REPAYMENT_STATUSES = ['pending', 'paid', 'late', 'missed'] as const;
export type CreditRepaymentStatus = (typeof CREDIT_REPAYMENT_STATUSES)[number];

export const CREDIT_COLLATERAL_STATUSES = ['pledged', 'released', 'claimed'] as const;
export type CreditCollateralStatus = (typeof CREDIT_COLLATERAL_STATUSES)[number];

export const CREDIT_GUARANTOR_STATUSES = ['invited', 'accepted', 'declined'] as const;
export type CreditGuarantorStatus = (typeof CREDIT_GUARANTOR_STATUSES)[number];

export const CREDIT_GROUP_ROLES = ['member', 'leader'] as const;
export type CreditGroupRole = (typeof CREDIT_GROUP_ROLES)[number];

export const SAVINGS_DIRECTIONS = ['deposit', 'withdrawal'] as const;
export type SavingsDirection = (typeof SAVINGS_DIRECTIONS)[number];

/* ----------------------------------------------------------- products -- */

export interface CreditLoanProduct {
  id: string;
  name: string;
  minPrincipalKobo: number;
  maxPrincipalKobo: number;
  /** Annual interest in basis points (1% = 100 bps), prorated over termDays. */
  interestBpsAnnual: number;
  termDays: number;
  /** VSLA/chama group lending product (co-obligor applications). */
  groupLending: boolean;
  active: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------ scoring -- */

/**
 * Deterministic 5-factor credit model ported from the source suite's
 * credit-scoring service (payment history / utilization / history length /
 * diversity / inquiries) and re-anchored to AgricPlatform data:
 *   - repaymentHistory:     prior loan performance (own credit repo)
 *   - profileCompleteness:  farm profile completion (profiles.completionScore)
 *   - transactionVolume:    marketplace order history (orders repo)
 *   - guarantorStrength:    accepted guarantors backing the applicant
 *   - groupStanding:        VSLA/chama membership + leadership + group savings
 * Each factor contributes 0–200; the total score is 0–1000.
 */
export interface CreditScoreFactors {
  repaymentHistory: number;
  profileCompleteness: number;
  transactionVolume: number;
  guarantorStrength: number;
  groupStanding: number;
}

export const CREDIT_SCORE_MAX = 1000;
export const CREDIT_FACTOR_MAX = 200;

export interface CreditScoreAssessment {
  userId: string;
  /** 0–1000, sum of the five factors. */
  score: number;
  factors: CreditScoreFactors;
  computedAt: string;
}

/* ------------------------------------------------------------- loans --- */

export interface CreditLoanApplication {
  id: string;
  applicantUserId: string;
  productId: string;
  principalKobo: number;
  status: CreditLoanStatus;
  creditScore?: number;
  scoreFactors?: CreditScoreFactors;
  purpose?: string;
  /** Set for VSLA/chama group loan applications. */
  groupId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface CreditRepayment {
  id: string;
  loanId: string;
  /** 1-based position in the amortisation schedule. */
  sequence: number;
  dueAt: string;
  amountKobo: number;
  paidAt?: string;
  paidAmountKobo?: number;
  /**
   * Stored status. 'late' is computed at read time (due_at < now && still
   * pending) — no timers mutate this row; 'missed' is set explicitly by a
   * reviewer when the loan is defaulted.
   */
  status: CreditRepaymentStatus;
}

export interface CreditCollateral {
  id: string;
  loanId: string;
  kind: string;
  description: string;
  estimatedValueKobo: number;
  status: CreditCollateralStatus;
}

export interface CreditGuarantor {
  id: string;
  loanId: string;
  guarantorUserId: string;
  status: CreditGuarantorStatus;
}

/* ------------------------------------------------- groups (chama/VSLA) -- */

export interface CreditGroup {
  id: string;
  name: string;
  chapterId?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreditGroupMember {
  groupId: string;
  userId: string;
  role: CreditGroupRole;
  joinedAt: string;
}

/* ------------------------------------------------------------ savings -- */

export interface CreditSavingsAccount {
  id: string;
  /** Personal account owner (mutually exclusive with groupId). */
  userId?: string;
  /** VSLA group account (mutually exclusive with userId). */
  groupId?: string;
  balanceKobo: number;
  updatedAt: string;
}

export interface CreditSavingsTransaction {
  id: string;
  accountId: string;
  direction: SavingsDirection;
  amountKobo: number;
  balanceAfterKobo: number;
  /** Idempotency key — unique per transaction. */
  ref: string;
  createdAt: string;
}

/* ---------------------------------------------------------- portfolio -- */

/**
 * Portfolio-at-risk report. PAR-N = outstanding kobo on loans with any
 * repayment overdue ≥ N days ÷ total outstanding kobo. Ratios are returned
 * as integer basis points (0–10000) to keep the API float-free.
 */
export interface CreditPortfolioReport {
  generatedAt: string;
  totalLoans: number;
  activeLoans: number;
  defaultedLoans: number;
  /** Sum of unpaid repayment amounts across active loans. */
  outstandingKobo: number;
  /** Sum of unpaid repayment amounts across defaulted loans. */
  defaultedKobo: number;
  par30Kobo: number;
  par60Kobo: number;
  par90Kobo: number;
  par30Bps: number;
  par60Bps: number;
  par90Bps: number;
}
