import { Module } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL } from '../../database/persistence.tokens.js';
import {
  createInMemoryVoiceIntentSessionRepository,
  VOICE_INTENT_SESSION_REPOSITORY
} from '../../database/repositories/voice-intent.repository.js';
import { createPgVoiceIntentSessionRepository } from '../../database/repositories/voice-intent.pg-repository.js';
import { FinanceModule } from '../finance/finance.module.js';
import { UsersModule } from '../users/users.module.js';
import { VoiceTellerController } from './voice-teller.controller.js';
import { VoiceTellerService } from './voice-teller.service.js';

/**
 * Voice Teller (Stage 27, Innovation 6) — transactional read-only voice
 * intents (balance.savings | balance.float | loan.next_installment |
 * vsla.position | voucher.status) over the IVR channel, gated behind the
 * `voice-teller` feature flag (default OFF). The IVR module imports this
 * module for the PIN-gated account-menu effect; AppModule imports it for
 * the admin catalog route.
 *
 * The intent-session repository is registered module-locally (pg when the
 * global DatabaseModule pool is present, in-memory otherwise) so the
 * Stage 27 sibling PRs that union-merge persistence.tokens.ts /
 * database.module.ts are untouched by this wave. Cross-cutting deps
 * (feature flags, telemetry, domain-event outbox) come from the global
 * FeatureFlags/Telemetry/Core modules.
 */
@Module({
  imports: [UsersModule, FinanceModule],
  controllers: [VoiceTellerController],
  providers: [
    {
      provide: VOICE_INTENT_SESSION_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool
          ? createPgVoiceIntentSessionRepository(pool)
          : createInMemoryVoiceIntentSessionRepository(),
      inject: [{ token: PG_POOL, optional: true }]
    },
    VoiceTellerService
  ],
  exports: [VoiceTellerService]
})
export class VoiceTellerModule {}
