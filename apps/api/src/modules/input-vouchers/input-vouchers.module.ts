import { Module } from '@nestjs/common';
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
    { provide: IDENTITY_VERIFICATION_PORT, useFactory: () => createIdentityDriver(process.env) }
  ],
  exports: [InputVouchersService, IDENTITY_VERIFICATION_PORT]
})
export class InputVouchersModule {}
