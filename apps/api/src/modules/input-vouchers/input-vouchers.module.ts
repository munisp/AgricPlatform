import { Module } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL, INPUT_VOUCHER_PROGRAMME_FUNDING_REPOSITORY } from '../../database/persistence.tokens.js';
import { createInMemoryProgrammeFundingRepository } from '../../database/repositories/input-vouchers.repository.js';
import { createPgProgrammeFundingRepository } from '../../database/repositories/input-vouchers.pg-repository.js';
import { FinanceModule } from '../finance/finance.module.js';
import { UsersModule } from '../users/users.module.js';
import { InputVouchersController } from './input-vouchers.controller.js';
import { InputVouchersService } from './input-vouchers.service.js';
import { IDENTITY_VERIFICATION_PORT, createIdentityDriver } from './identity.driver.js';

/**
 * Input-subsidy e-vouchers (wave NINVOUCHER): government subsidy programmes
 * with ledger-encumbered budget envelopes, NIN-verified beneficiary
 * enrolment, voucher allocation/distribution/redemption at agro-dealers and
 * settlement reconciliation for regulators/donors. All value movement posts
 * through the finance ledger; the identity channel is a fail-closed driver
 * port (stub default — deterministic and clearly labelled, live env-gated
 * on a NIMC/licensed vendor contract). NINs are never persisted — salted
 * HMAC hash + last-3 mask only.
 */
@Module({
  imports: [FinanceModule, UsersModule],
  controllers: [InputVouchersController],
  providers: [
    InputVouchersService,
    // Stage 23 (audit C3): funded-float backing store. Wired module-locally
    // against the global PG_POOL (pg when DATABASE_URL is set, in-memory
    // otherwise) — same swappable pattern as the DatabaseModule factories.
    {
      provide: INPUT_VOUCHER_PROGRAMME_FUNDING_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgProgrammeFundingRepository(pool) : createInMemoryProgrammeFundingRepository(),
      inject: [PG_POOL]
    },
    { provide: IDENTITY_VERIFICATION_PORT, useFactory: () => createIdentityDriver(process.env) }
  ],
  exports: [InputVouchersService, IDENTITY_VERIFICATION_PORT, INPUT_VOUCHER_PROGRAMME_FUNDING_REPOSITORY]
})
export class InputVouchersModule {}
