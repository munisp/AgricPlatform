import { Module, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL } from '../../database/persistence.tokens.js';
import {
  createInMemoryRegenDiscountRateCardRepository,
  createInMemoryRegenDiscountRepository
} from '../../database/repositories/insurance.repository.js';
import {
  createPgRegenDiscountRateCardRepository,
  createPgRegenDiscountRepository
} from '../../database/repositories/insurance.pg-repository.js';
import {
  REGEN_DISCOUNT_RATE_CARD_REPOSITORY,
  REGEN_DISCOUNT_REPOSITORY
} from '../../database/persistence.tokens.js';
import { GeoModule } from '../geo/geo.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { InsuranceController } from './insurance.controller.js';
import { InsuranceService } from './insurance.service.js';
import { InsurerApiController } from './insurer-api.controller.js';
import { RegenDiscountController } from './regen-discount.controller.js';
import { RegenDiscountService } from './regen-discount.service.js';

/**
 * Parametric insurance rail (wave-insurance, additive). Plot-level
 * parametric products with deterministic trigger evaluation, graduated
 * payouts through the ledger in STUB execution mode, and a fail-closed
 * weather/flood provider doctrine identical to geo-intel. The catalog seeds
 * through the repository upsert on boot (never migration data).
 *
 * Stage 27 (Regen Discount): carbon-MRV-verified premium discount — a
 * bounded, versioned admin rate card plus exactly-once-per-policy discount
 * rows whose eligibility requires a recorded vsla-carbon seasonal
 * attestation (never a fabricated satellite score). Ships behind the
 * `regen-discount` flag (default OFF); adds no payout execution path. The
 * two new repositories are provided module-locally (PG_POOL rides the
 * global DatabaseModule export) so this wave adds ZERO edits to the shared
 * database.module.ts and stays cleanly mergeable with in-flight insurance
 * PRs.
 */
@Module({
  imports: [GeoModule, FinanceModule, PartnerApiModule],
  controllers: [InsuranceController, InsurerApiController, RegenDiscountController],
  providers: [
    InsuranceService,
    RegenDiscountService,
    {
      provide: REGEN_DISCOUNT_RATE_CARD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRegenDiscountRateCardRepository(pool) : createInMemoryRegenDiscountRateCardRepository(),
      inject: [PG_POOL]
    },
    {
      provide: REGEN_DISCOUNT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgRegenDiscountRepository(pool) : createInMemoryRegenDiscountRepository(),
      inject: [PG_POOL]
    }
  ],
  exports: [InsuranceService, RegenDiscountService]
})
export class InsuranceModule implements OnModuleInit {
  constructor(private readonly insurance: InsuranceService) {}

  async onModuleInit(): Promise<void> {
    await this.insurance.ensureCatalogSeeded();
  }
}
