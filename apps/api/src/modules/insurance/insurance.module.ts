import { Module, type OnModuleInit } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { InsuranceController } from './insurance.controller.js';
import { InsuranceService } from './insurance.service.js';
import { InsurerApiController } from './insurer-api.controller.js';
import { VoucherCoversController, VoucherRiderController } from './voucher-covers.controller.js';
import { VoucherCoversService } from './voucher-covers.service.js';

/**
 * Parametric insurance rail (wave-insurance, additive). Plot-level
 * parametric products with deterministic trigger evaluation, graduated
 * payouts through the ledger in STUB execution mode, and a fail-closed
 * weather/flood provider doctrine identical to geo-intel. The catalog seeds
 * through the repository upsert on boot (never migration data).
 *
 * Stage 27 (Insurance-in-the-Bag): voucher-bundled micro-cover — sponsor
 * riders on subsidy programmes (premium debited atomically from the
 * voucher's funded envelope at redemption) plus the cover lifecycle
 * projector. The payout leg stays externally gated; this module adds no
 * payout execution path of its own.
 */
@Module({
  imports: [GeoModule, FinanceModule, PartnerApiModule],
  controllers: [InsuranceController, InsurerApiController, VoucherRiderController, VoucherCoversController],
  providers: [InsuranceService, VoucherCoversService],
  exports: [InsuranceService, VoucherCoversService]
})
export class InsuranceModule implements OnModuleInit {
  constructor(private readonly insurance: InsuranceService) {}

  async onModuleInit(): Promise<void> {
    await this.insurance.ensureCatalogSeeded();
  }
}
