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
import { LedgerService } from './ledger.service.js';
import { LoanController } from './loan.controller.js';
import { LoanService } from './loan.service.js';

@Module({
  imports: [LearningModule],
  controllers: [FinanceController, LedgerController, CreditController, LoanController],
  providers: [
    FinanceService,
    LedgerService,
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
  exports: [FinanceService, LedgerService, CreditService, LoanService, LEDGER_BACKEND]
})
export class FinanceModule {}
