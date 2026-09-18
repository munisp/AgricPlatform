import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { GeoModule } from '../geo/geo.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import {
  WAREHOUSE_CERTIFICATION_FEED,
  createCertificationFeed
} from './certification.driver.js';
import {
  COLLATERAL_REGISTRY,
  createCollateralRegistry
} from './collateral-registry.driver.js';
import { WarehouseCollateralClaimService } from './collateral-claim.service.js';
import { LtvGuardianController } from './ltv-guardian.controller.js';
import { LtvGuardianService } from './ltv-guardian.service.js';
import { WarehouseBondService } from './warehouse-bond.service.js';
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
 *
 * Stage 27 / Innovation 8 (migration 066): the Receipt LTV Guardian
 * (LtvGuardianService + LtvGuardianController) monitors pledged receipts as
 * live collateral positions. It reads outstanding balances from the finance
 * ledger (FinanceModule) and prices through the fail-closed commodity-price
 * provider port (IntegrationsModule); the whole surface is behind the
 * `whr-ltv-guardian` feature flag (default OFF).
 */
@Module({
  imports: [GeoModule, FinanceModule, IntegrationsModule],
  controllers: [WarehouseController, LtvGuardianController],
  providers: [
    WarehouseService,
    LtvGuardianService,
    // V-39: operator bond ledger (fraud remedy) — E-08 external gate noted
    // in the service doc-comment.
    WarehouseBondService,
    // V-31 (warehouse half): credit.collateral.claimed subscription driving
    // pledge release + balanced settlement legs.
    WarehouseCollateralClaimService,
    { provide: WAREHOUSE_CERTIFICATION_FEED, useFactory: () => createCertificationFeed(process.env) },
    { provide: COLLATERAL_REGISTRY, useFactory: () => createCollateralRegistry(process.env) }
  ],
  exports: [WarehouseService, LtvGuardianService]
})
export class WarehouseModule {}
