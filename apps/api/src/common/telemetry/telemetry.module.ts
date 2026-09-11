import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantAttributionInterceptor } from './tenant-context.js';
import { TelemetryService } from './telemetry.service.js';

/**
 * Telemetry wiring (integration map §3/§7). Global so any module can inject
 * TelemetryService without importing anything. The SDK itself is started
 * earlier, via the `telemetry.boot.ts` import at the top of `main.ts`.
 *
 * The tenant interceptor is registered through APP_INTERCEPTOR so it is
 * DI-managed; guards (RolesGuard / PartnerAuthGuard) run first and populate
 * `request.user` / `request.partner` for it to read.
 */
@Global()
@Module({
  providers: [
    TelemetryService,
    { provide: APP_INTERCEPTOR, useClass: TenantAttributionInterceptor }
  ],
  exports: [TelemetryService]
})
export class TelemetryModule {}
