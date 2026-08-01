import { Global, Module } from '@nestjs/common';
import { OidcService } from '../common/auth/oidc.service.js';
import { AuditService } from './audit.service.js';
import { DomainEventsService } from './domain-events.service.js';

/**
 * Cross-cutting platform services (audit, domain event outbox, OIDC token
 * verification) available to every module without explicit imports.
 */
@Global()
@Module({
  providers: [AuditService, DomainEventsService, OidcService],
  exports: [AuditService, DomainEventsService, OidcService]
})
export class CoreModule {}
