import { Module } from '@nestjs/common';
import { LEDGER_BACKEND } from '../integrations/drivers/tigerbeetle.driver.js';
import { createLedgerBackendDriver } from '../integrations/drivers/tigerbeetle.driver.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { LearningModule } from '../learning/learning.module.js';
import { AgentFloatService } from './agent-float.service.js';
import { CreditController } from './credit.controller.js';
import { CreditService } from './credit.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerReconciliationService } from './ledger-reconciliation.service.js';
import { LedgerService } from './ledger.service.js';
import { LoanController } from './loan.controller.js';
import { LoanService } from './loan.service.js';
import { TbConsistencyChecker } from './tb-consistency.checker.js';

@Module({
  imports: [LearningModule],
  controllers: [FinanceController, CreditController, LoanController, LedgerController],
  providers: [
    FinanceService,
    LedgerService,
    // Stage 27 (WP-G13 ledger hardening): balance-invariant + escrow↔ledger
    // reconciliation, and the pg↔TigerBeetle consistency checker (inert
    // unless LEDGER_DRIVER=tigerbeetle).
    LedgerReconciliationService,
    TbConsistencyChecker,
    CreditService,
    LoanService,
    AgentFloatService,
    // Wave FABRIC: selected ledger-backend driver (default stub — legal gate
    // OFF; tigerbeetle requires TIGERBEETLE_ADDRESSES + TIGERBEETLE_CLUSTER_ID
    // and fails closed otherwise). Telemetry flows into the driver's spans,
    // duration histograms and error counters (Stage 25.2).
    {
      provide: LEDGER_BACKEND,
      useFactory: (telemetry: TelemetryService) =>
        createLedgerBackendDriver(process.env, telemetry),
      inject: [TelemetryService]
    }
  ],
  exports: [
    FinanceService,
    LedgerService,
    LedgerReconciliationService,
    TbConsistencyChecker,
    CreditService,
    LoanService,
    LEDGER_BACKEND
  ]
})
export class FinanceModule {}
