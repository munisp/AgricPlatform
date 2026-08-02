import { Global, Module } from '@nestjs/common';
import { OidcService } from '../common/auth/oidc.service.js';
import { ErrorTrackingService } from '../common/error-tracking/error-tracking.service.js';
import { AuditService } from './audit.service.js';
import { DomainEventsService } from './domain-events.service.js';

/**
 * Cross-cutting platform services (audit, domain event outbox, OIDC token
 * verification, error tracking) available to every module without explicit
 * imports.
 */
@Global()
@Module({
  providers: [AuditService, DomainEventsService, OidcService, ErrorTrackingService],
  exports: [AuditService, DomainEventsService, OidcService, ErrorTrackingService]
})
export class CoreModule {}
