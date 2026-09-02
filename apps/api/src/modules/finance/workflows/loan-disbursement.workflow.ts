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
// @opentelemetry/api is workflow-sandbox safe (the interceptors-opentelemetry
// workflow module itself imports it, and it resolves to a no-op API when no
// span is active). Used ONLY to stamp business attributes on the span the
// worker's OTel interceptors create — never to start spans here.
import { trace } from '@opentelemetry/api';
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

/**
 * Stamps tenant.id + loan.id on the active workflow span (created by the
 * worker's @temporalio/interceptors-opentelemetry workflow interceptors).
 * tenant.id uses the `user:<id>` convention from common/telemetry/
 * tenant-context.ts (no platform tenant model exists yet). No-op when no
 * span is active; never throws — telemetry must not break the workflow.
 */
function stampWorkflowSpan(input: LoanDisbursementInput): void {
  try {
    const span = trace.getActiveSpan();
    span?.setAttribute('tenant.id', `user:${input.applicantId}`);
    span?.setAttribute('loan.id', input.loanId);
  } catch {
    // swallow: telemetry is observability, never a workflow failure mode
  }
}

/** score-check → ledger-record → notification (decline short-circuits). */
export async function loanDisbursementWorkflow(
  input: LoanDisbursementInput
): Promise<LoanDisbursementResult> {
  stampWorkflowSpan(input);
  return runLoanDisbursementPipeline(activities, input);
}
