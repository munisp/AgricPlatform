import { Module } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module.js';
import {
  WAREHOUSE_CERTIFICATION_FEED,
  createCertificationFeed
} from './certification.driver.js';
import {
  COLLATERAL_REGISTRY,
  createCollateralRegistry
} from './collateral-registry.driver.js';
import { WarehouseController } from './warehouse.controller.js';
import { WarehouseService } from './warehouse.service.js';

/**
 * Wave WAREHOUSE (Innovation #5, migration 034): electronic warehouse
 * receipts (e-WHR). Warehouse H3 cells come from the geo module (no
 * PostGIS); receipts are HMAC-signed server-side; pledge liens mirror the
 * livestock-trade lien precedent. Money stays in the finance ledger — these
 * are operational records only. Both external ports (warehouse-operator
 * certification feed, collateral registry) are STUB-first and fail closed
 * in live mode (see docs/warehouse-receipts.md for the external gates).
 */
@Module({
  imports: [GeoModule],
  controllers: [WarehouseController],
  providers: [
    WarehouseService,
    { provide: WAREHOUSE_CERTIFICATION_FEED, useFactory: () => createCertificationFeed(process.env) },
    { provide: COLLATERAL_REGISTRY, useFactory: () => createCollateralRegistry(process.env) }
  ],
  exports: [WarehouseService]
})
export class WarehouseModule {}
