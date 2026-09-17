import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { KeycloakPhoneTokenService } from './keycloak-phone-token.service.js';
import { PinSessionService } from './pin-session.service.js';
import { PinSessionsController } from './pin-sessions.controller.js';
import { SessionService } from './session.service.js';

@Module({
  // IntegrationsModule supplies the live SMS driver for OTP delivery (V-16).
  // It imports no feature module that depends on AuthModule, so no cycle.
  imports: [IntegrationsModule],
  controllers: [AuthController, PinSessionsController],
  providers: [
    AuthService,
    // Factory registration (driver doctrine): the service takes its env
    // explicitly, so it must NOT be constructor-injected by Nest metadata.
    // Enabled-but-unconfigured aborts boot here with ProviderConfigError.
    {
      provide: KeycloakPhoneTokenService,
      useFactory: () => new KeycloakPhoneTokenService(process.env)
    },
    PinSessionService,
    SessionService
  ],
  exports: [AuthService, KeycloakPhoneTokenService, PinSessionService, SessionService]
})
export class AuthModule {}
