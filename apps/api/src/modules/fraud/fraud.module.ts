import { Module } from '@nestjs/common';
import { FraudCasesController } from './cases.controller.js';
import { FraudSentinelService } from './sentinel.service.js';

/**
 * Float Sentinel (Stage 27) — deterministic fraud/liquidity anomaly engine
 * over the single-ledger outbox stream. Detective control only: read-only on
 * the ledger, never blocks money movement; rule firings land in the fraud.*
 * alert/case queue (migration 059). Gated behind the `float-sentinel`
 * feature flag (default OFF).
 *
 * Cross-cutting deps (outbox/dedup/audit/events/telemetry) come from the
 * global CoreModule; persistence tokens from the global DatabaseModule;
 * feature flags from the global FeatureFlagsModule — no imports needed.
 */
@Module({
  controllers: [FraudCasesController],
  providers: [FraudSentinelService],
  exports: [FraudSentinelService]
})
export class FraudModule {}
