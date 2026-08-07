import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module.js';
import {
  ANIMAL_ID_AUTHORITY_PROVIDER,
  createAnimalIdAuthorityProvider
} from './animal-id-authority.provider.js';
import { LivestockPassportController } from './livestock-passport.controller.js';
import { LivestockPassportService } from './livestock-passport.service.js';

/**
 * Digital livestock passport (wave-livestock-passport, innovation #9,
 * migration 036, schema `livestock_passport`). Aggregates the existing
 * livestock domain (identity, vet-signed health records, movement permits,
 * liens, animal insurance) into one verifiable document per animal with a
 * hash-chained event log, a two-party ownership-transfer handshake and a
 * public HMAC-verified QR endpoint. Repository tokens resolve through the
 * global DatabaseModule; audit/events through the global CoreModule;
 * UsersService is global. The external animal-ID authority port is stubbed
 * deterministically by default and fails closed when a live driver is
 * configured without full configuration (boot abort) or unreachable (503).
 */
@Module({
  imports: [CoreModule],
  controllers: [LivestockPassportController],
  providers: [
    LivestockPassportService,
    {
      provide: ANIMAL_ID_AUTHORITY_PROVIDER,
      useFactory: () => createAnimalIdAuthorityProvider()
    }
  ],
  exports: [LivestockPassportService, ANIMAL_ID_AUTHORITY_PROVIDER]
})
export class LivestockPassportModule {}
