/**
 * Temporal workflow definition for the credit loan disbursement pipeline
 * (wave FABRIC). This file is loaded by the Temporal worker bootstrap
 * (src/workers/temporal.worker.ts) — it must stay deterministic-sandbox
 * safe: imports are limited to @temporalio/workflow plus the pure,
 * dependency-free pipeline executor in loan-disbursement.activities.ts.
 * The API itself never imports this file; the stub orchestrator runs the
 * same executor with local activities, so business logic cannot drift
 * between drivers.
 */
import { proxyActivities } from '@temporalio/workflow';
import {
  runLoanDisbursementPipeline,
  type LoanDisbursementActivities,
  type LoanDisbursementInput,
  type LoanDisbursementResult
} from './loan-disbursement.activities.js';

const activities = proxyActivities<LoanDisbursementActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 }
});

/** score-check → ledger-record → notification (decline short-circuits). */
export async function loanDisbursementWorkflow(
  input: LoanDisbursementInput
): Promise<LoanDisbursementResult> {
  return runLoanDisbursementPipeline(activities, input);
}
