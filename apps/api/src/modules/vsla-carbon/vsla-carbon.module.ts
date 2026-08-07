import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { GeoModule } from '../geo/geo.module.js';
import { VslaCarbonController } from './vsla-carbon.controller.js';
import { VslaCarbonService } from './vsla-carbon.service.js';
import { createNdviProvider, NDVI_PROVIDER_TOKEN } from './ndvi.provider.js';

/**
 * VSLA groups + carbon MRV (wave VSLACARBON, additive). Village savings &
 * loan association groups with ledger-backed savings cycles, deterministic
 * pro-rata share-outs and simple-interest internal loans — plus carbon MRV
 * plots (H3 res-9, no PostGIS), seasonal evidence with an optional
 * fail-closed NDVI linkage (crop-ml contract, stub default) and
 * clearly-labelled ESTIMATE carbon figures. Credit issuance/trading is out
 * of scope behind external gates (docs/vsla-carbon-mrv.md). Repository
 * tokens resolve via the global DatabaseModule (vsla_carbon schema,
 * migration 037).
 */
@Module({
  imports: [FinanceModule, GeoModule],
  controllers: [VslaCarbonController],
  providers: [
    VslaCarbonService,
    { provide: NDVI_PROVIDER_TOKEN, useFactory: () => createNdviProvider(process.env) }
  ],
  exports: [VslaCarbonService, NDVI_PROVIDER_TOKEN]
})
export class VslaCarbonModule {}
