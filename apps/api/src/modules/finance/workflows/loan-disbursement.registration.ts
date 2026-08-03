/**
 * DI wiring for the credit loan disbursement workflow (wave FABRIC). Maps
 * the real CreditService / LedgerService / NotificationsService onto the
 * narrow LoanDisbursementDeps surface and, when the stub orchestrator is
 * selected (the default), registers the local handler so the port is
 * exercised end-to-end in-process. Under WORKFLOW_DRIVER=temporal nothing
 * is registered locally — the Temporal worker (src/workers/) hosts the
 * activities instead. Registration is additive: no endpoint invokes the
 * workflow automatically and default request behaviour is unchanged.
 */
import {
  StubWorkflowOrchestrator,
  type WorkflowOrchestrator
} from '../../../common/orchestration/workflow-orchestrator.driver.js';
import { CreditService } from '../credit.service.js';
import { LedgerService } from '../ledger.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import {
  LOAN_DISBURSEMENT_WORKFLOW,
  createLoanDisbursementActivities,
  runLoanDisbursementPipeline,
  type LoanDisbursementDeps,
  type LoanDisbursementInput
} from './loan-disbursement.activities.js';

/** Provider token marking that the workflow registration ran. */
export const LOAN_DISBURSEMENT_REGISTRATION = Symbol('LOAN_DISBURSEMENT_REGISTRATION');

/** Maps the real finance/notification services onto the activity deps. */
export function buildLoanDisbursementDeps(
  credit: CreditService,
  ledger: LedgerService,
  notifications: NotificationsService
): LoanDisbursementDeps {
  return {
    async scoreForUser(userId) {
      const result = await credit.scoreForUser(userId);
      return { score: result.score };
    },
    async postDisbursementEntry(input) {
      const entry = await ledger.postEntry(
        {
          idempotencyKey: `loan-disbursement:${input.loanId}`,
          referenceType: 'credit_loan',
          referenceId: input.loanId,
          description: `Credit loan disbursement (workflow ${LOAN_DISBURSEMENT_WORKFLOW})`,
          postings: [
            {
              accountCode: input.lenderAccountCode,
              direction: 'debit',
              amountKobo: input.amountKobo
            },
            {
              accountCode: input.borrowerAccountCode,
              direction: 'credit',
              amountKobo: input.amountKobo
            }
          ],
          requireSolventAccounts: [input.lenderAccountCode]
        },
        input.actorId
      );
      return { entryId: entry.id };
    },
    async notify(userId, title, body) {
      const message = await notifications.send({ userId, channel: 'in_app', title, body });
      return { notificationId: message.id };
    }
  };
}

/**
 * Registers the local handler on the stub orchestrator. Returns true when
 * registered, false when a non-stub orchestrator is selected (Temporal
 * hosts the workflow on the worker side instead).
 */
export function registerLoanDisbursementWorkflow(
  orchestrator: WorkflowOrchestrator,
  deps: LoanDisbursementDeps
): boolean {
  if (orchestrator instanceof StubWorkflowOrchestrator) {
    const activities = createLoanDisbursementActivities(deps);
    orchestrator.registerLocalWorkflow(LOAN_DISBURSEMENT_WORKFLOW, (input) =>
      runLoanDisbursementPipeline(activities, input as LoanDisbursementInput)
    );
    return true;
  }
  return false;
}
