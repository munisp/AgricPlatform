import { Module } from '@nestjs/common';
import {
  WORKFLOW_ORCHESTRATOR,
  type WorkflowOrchestrator
} from '../../../common/orchestration/workflow-orchestrator.driver.js';
import { NotificationsModule } from '../../notifications/notifications.module.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { CreditService } from '../credit.service.js';
import { FinanceModule } from '../finance.module.js';
import { LedgerService } from '../ledger.service.js';
import {
  LOAN_DISBURSEMENT_REGISTRATION,
  buildLoanDisbursementDeps,
  registerLoanDisbursementWorkflow
} from './loan-disbursement.registration.js';

/**
 * Wave FABRIC: workflow registrations. Kept in its own module (instead of
 * FinanceModule) because the registration needs FinanceModule AND
 * NotificationsModule, while NotificationsModule already (transitively)
 * imports FinanceModule — importing NotificationsModule from FinanceModule
 * would create a module cycle. Nothing imports WorkflowsModule except
 * AppModule, so the graph stays acyclic. Registration only ADDS a local
 * handler to the stub orchestrator; default request behaviour is unchanged.
 */
@Module({
  imports: [FinanceModule, NotificationsModule],
  providers: [
    {
      provide: LOAN_DISBURSEMENT_REGISTRATION,
      useFactory: (
        orchestrator: WorkflowOrchestrator,
        credit: CreditService,
        ledger: LedgerService,
        notifications: NotificationsService
      ) =>
        registerLoanDisbursementWorkflow(
          orchestrator,
          buildLoanDisbursementDeps(credit, ledger, notifications)
        ),
      inject: [WORKFLOW_ORCHESTRATOR, CreditService, LedgerService, NotificationsService]
    }
  ]
})
export class WorkflowsModule {}
