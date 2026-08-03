import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { GeoModule } from '../geo/geo.module.js';
import { GeoIntelModule } from '../geo-intel/geo-intel.module.js';
import { MechanizationController } from './mechanization.controller.js';
import { MechanizationService } from './mechanization.service.js';

/**
 * Wave MECHANIZATION (Innovation #10, migration 033): equipment hire
 * marketplace. H3 service areas come from the geo module (no PostGIS);
 * payment holds/releases post through the finance ledger in stub execution
 * mode (no real charges); the geo-intel flood port is an advisory-only hook
 * whose basis label always travels with the flag.
 */
@Module({
  imports: [GeoModule, GeoIntelModule, FinanceModule],
  controllers: [MechanizationController],
  providers: [MechanizationService],
  exports: [MechanizationService]
})
export class MechanizationModule {}
