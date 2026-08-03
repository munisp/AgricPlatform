/**
 * Credit loan disbursement pipeline (wave FABRIC) — the ONE real workflow
 * proving the WorkflowOrchestrator port. Steps: score-check → ledger-record
 * → notification. This file is deliberately dependency-free (types + pure
 * orchestration only) so the SAME pipeline executor runs unchanged in both
 * drivers: the stub orchestrator invokes it in-process via
 * runLoanDisbursementPipeline, and the Temporal workflow
 * (loan-disbursement.workflow.ts) replays it with proxied activities.
 *
 * Money movement note: the ledger-record step posts through the EXISTING
 * LedgerService double-entry invariants (same as POST /loans/:id/disburse);
 * this workflow orchestrates that posting, it does not bypass it. The
 * pipeline is only invoked by explicit callers — nothing auto-disburses.
 */

/** Workflow name registered on the orchestrator port and the Temporal worker. */
export const LOAN_DISBURSEMENT_WORKFLOW = 'credit.loan_disbursement';

export interface LoanDisbursementInput {
  loanId: string;
  applicantId: string;
  /** Whole-kobo disbursement amount (integer; no floats anywhere). */
  amountKobo: number;
  /** Ledger account codes (lender pool pays out, borrower receives). */
  lenderAccountCode: string;
  borrowerAccountCode: string;
  /** Actor recorded on the ledger entry (admin acting for the lender). */
  actorId: string;
  /** Minimum credit score required to disburse. */
  minScore: number;
}

export interface ScoreCheckOutput {
  score: number;
  decision: 'approve' | 'decline';
}

export interface LedgerRecordOutput {
  entryId: string;
}

export interface NotificationOutput {
  notificationId: string;
}

/**
 * The three pipeline steps. In the stub driver these run as plain local
 * calls; under Temporal the same functions are registered as activities on
 * the worker (src/workers/temporal.worker.ts).
 */
export interface LoanDisbursementActivities {
  scoreCheck(input: LoanDisbursementInput): Promise<ScoreCheckOutput>;
  ledgerRecord(input: LoanDisbursementInput, score: ScoreCheckOutput): Promise<LedgerRecordOutput>;
  sendNotification(
    input: LoanDisbursementInput,
    outcome: { score: ScoreCheckOutput; ledgerEntryId?: string }
  ): Promise<NotificationOutput>;
}

export interface LoanDisbursementResult {
  loanId: string;
  score: number;
  decision: 'approve' | 'decline';
  /** Present only when the disbursement was approved and posted. */
  ledgerEntryId?: string;
  notificationId: string;
  /** Step names in execution order (observability + test assertions). */
  steps: string[];
}

/**
 * Sequential pipeline: score-check gates the money movement; a decline
 * short-circuits BEFORE any ledger posting and still notifies the
 * applicant. Shared verbatim by the stub orchestrator and the Temporal
 * workflow so both drivers execute identical business logic.
 */
export async function runLoanDisbursementPipeline(
  activities: LoanDisbursementActivities,
  input: LoanDisbursementInput
): Promise<LoanDisbursementResult> {
  const steps: string[] = [];

  const score = await activities.scoreCheck(input);
  steps.push('score-check');

  if (score.decision === 'decline') {
    const declineNotice = await activities.sendNotification(input, { score });
    steps.push('notification');
    return {
      loanId: input.loanId,
      score: score.score,
      decision: 'decline',
      notificationId: declineNotice.notificationId,
      steps
    };
  }

  const ledger = await activities.ledgerRecord(input, score);
  steps.push('ledger-record');

  const notification = await activities.sendNotification(input, {
    score,
    ledgerEntryId: ledger.entryId
  });
  steps.push('notification');

  return {
    loanId: input.loanId,
    score: score.score,
    decision: 'approve',
    ledgerEntryId: ledger.entryId,
    notificationId: notification.notificationId,
    steps
  };
}

/**
 * Narrow service surface the activities need. The DI registration
 * (loan-disbursement.registration.ts) and the Temporal worker bootstrap
 * both map the real CreditService / LedgerService / NotificationsService
 * onto this interface; tests map fakes.
 */
export interface LoanDisbursementDeps {
  scoreForUser(userId: string): Promise<{ score: number }>;
  postDisbursementEntry(input: LoanDisbursementInput): Promise<{ entryId: string }>;
  notify(
    userId: string,
    title: string,
    body: string
  ): Promise<{ notificationId: string }>;
}

/** Builds the three activities from the mapped service dependencies. */
export function createLoanDisbursementActivities(
  deps: LoanDisbursementDeps
): LoanDisbursementActivities {
  return {
    async scoreCheck(input) {
      const { score } = await deps.scoreForUser(input.applicantId);
      return { score, decision: score >= input.minScore ? 'approve' : 'decline' };
    },
    async ledgerRecord(input) {
      return deps.postDisbursementEntry(input);
    },
    async sendNotification(input, outcome) {
      const approved = outcome.score.decision === 'approve';
      const title = approved
        ? `Loan ${input.loanId} disbursed`
        : `Loan ${input.loanId} disbursement declined`;
      const body = approved
        ? `Your loan disbursement of ${input.amountKobo} kobo was posted (ledger entry ${outcome.ledgerEntryId}).`
        : `Your credit score ${outcome.score.score} is below the required ${input.minScore}; the disbursement was not posted.`;
      return deps.notify(input.applicantId, title, body);
    }
  };
}
