import { Module } from '@nestjs/common';
import type pg from 'pg';
import { HARVEST_FORWARD_CONTRACT_REPOSITORY, PG_POOL } from '../../database/persistence.tokens.js';
import { createPgOfftakeContractRepository } from '../../database/repositories/offtake.pg-repository.js';
import { createInMemoryOfftakeContractRepository } from '../../database/repositories/offtake.repository.js';
import { FinanceModule } from '../finance/finance.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { MarketplaceModule } from './marketplace.module.js';
import { OfftakeCollateralController, OfftakeController } from './offtake.controller.js';
import { OfftakeService } from './offtake.service.js';

/**
 * Harvest Forward Contracts module (Stage 27 Batch 3, Innovation 18) —
 * additive composition module so the shared marketplace module file stays
 * untouched (overlap with in-flight marketplace PRs). Imports
 * MarketplaceModule (order/invoice/escrow rails), FinanceModule (ledger
 * postings) and ProfilesModule (honest listing locations); the
 * traceability lot is verified through the global COMMODITY_LOT_REPOSITORY
 * token, so no traceability import (and no import cycle) is needed.
 */
@Module({
  imports: [MarketplaceModule, FinanceModule, ProfilesModule],
  controllers: [OfftakeController, OfftakeCollateralController],
  providers: [
    OfftakeService,
    {
      provide: HARVEST_FORWARD_CONTRACT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgOfftakeContractRepository(pool) : createInMemoryOfftakeContractRepository(),
      inject: [PG_POOL]
    }
  ],
  exports: [OfftakeService]
})
export class OfftakeModule {}
