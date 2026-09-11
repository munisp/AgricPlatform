import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { CreditPassportController } from './credit-passport.controller.js';
import { CreditPassportPartnerController } from './credit-passport-partner.controller.js';
import { CreditPassportService } from './credit-passport.service.js';
import { MeCreditPassportController } from './me-credit-passport.controller.js';

/**
 * Credit Passport (Stage 27, Innovation 7; migration 065, schema
 * `credit_passport`): a portable, verifiable farmer credit credential.
 * Composes the credit suite, vsla-carbon, learning and credit
 * geo-verification repositories into a signed, hash-chained credential with
 * per-section honesty basis badges (geo factor SHADOW + non-decisional).
 * Surfaces: farmer read/share/revoke (`/me/credit-passport`, flag
 * `credit-passport`), an unauthenticated redacted QR verification endpoint
 * (`/credit-passport/verify/:code`, flag `credit-passport-public`) and a
 * consent-scoped partner read (`/partner/credit-passports/:userId`, scope
 * `credit-passport:read`). Repository tokens resolve through the global
 * DatabaseModule; audit/events through the global CoreModule; UsersService
 * and TelemetryService are global. PartnerApiModule supplies the partner
 * auth guard reused by the partner controller (traceability pattern — no
 * partner-api files modified).
 */
@Module({
  imports: [CoreModule, PartnerApiModule],
  controllers: [
    MeCreditPassportController,
    CreditPassportController,
    CreditPassportPartnerController
  ],
  providers: [CreditPassportService],
  exports: [CreditPassportService]
})
export class CreditPassportModule {}
