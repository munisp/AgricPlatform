import { Module, type OnModuleInit } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { InsuranceController } from './insurance.controller.js';
import { InsuranceService } from './insurance.service.js';
import { InsurerApiController } from './insurer-api.controller.js';

/**
 * Parametric insurance rail (wave-insurance, additive). Plot-level
 * parametric products with deterministic trigger evaluation, graduated
 * payouts through the ledger in STUB execution mode, and a fail-closed
 * weather/flood provider doctrine identical to geo-intel. The catalog seeds
 * through the repository upsert on boot (never migration data).
 */
@Module({
  imports: [GeoModule, FinanceModule, PartnerApiModule],
  controllers: [InsuranceController, InsurerApiController],
  providers: [InsuranceService],
  exports: [InsuranceService]
})
export class InsuranceModule implements OnModuleInit {
  constructor(private readonly insurance: InsuranceService) {}

  async onModuleInit(): Promise<void> {
    await this.insurance.ensureCatalogSeeded();
  }
}
