import { Module } from '@nestjs/common';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { LearningModule } from '../learning/learning.module.js';
import {
  LEDGER_BACKEND,
  createLedgerBackendDriver
} from '../integrations/drivers/tigerbeetle.driver.js';
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
  controllers: [FinanceController, LedgerController, CreditController, LoanController],
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
    // Wave FABRIC: ledger-backend driver port (stub = Postgres ledger
    // authoritative; tigerbeetle proof-of-port, legal-gated OFF by default,
    // fail-closed when selected without its envs).
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
