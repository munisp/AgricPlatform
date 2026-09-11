import { Module } from '@nestjs/common';
import { InputVouchersModule } from '../input-vouchers/input-vouchers.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { EscrowExpirySweeperService } from './escrow-expiry-sweeper.service.js';
import { SweeperSchedulerService } from './sweeper-scheduler.service.js';
import { VoucherStuckSweeperService } from './voucher-stuck-sweeper.service.js';

/**
 * WP-G12 money-state sweepers. Periodic, idempotent, CAS-guarded passes over
 * money-bearing pending states:
 *   - EscrowExpirySweeperService: auto-refunds held escrows past their
 *     heldUntil deadline and resumes stuck release/refund drives through the
 *     existing escrow service semantics (recorded payout rail, never raw
 *     ledger inserts);
 *   - VoucherStuckSweeperService: expires due vouchers and recovers stuck
 *     VOIDING/REDEEMING claims through the existing voucher service
 *     (balanced, idempotency-keyed postings only).
 *
 * Drivers: the k8s CronJob fleet (infra/k8s/cronjobs/) calling the admin
 * sweep endpoints, and/or the in-process SweeperSchedulerService behind
 * SWEEPERS_ENABLED=true. Both are safe to run concurrently.
 */
@Module({
  imports: [MarketplaceModule, InputVouchersModule],
  providers: [EscrowExpirySweeperService, VoucherStuckSweeperService, SweeperSchedulerService],
  exports: [EscrowExpirySweeperService, VoucherStuckSweeperService, SweeperSchedulerService]
})
export class SweepersModule {}
