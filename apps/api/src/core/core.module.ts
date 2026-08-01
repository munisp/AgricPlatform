import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { DomainEventsService } from './domain-events.service.js';

/**
 * Cross-cutting platform services (audit + domain event outbox) available
 * to every module without explicit imports.
 */
@Global()
@Module({
  providers: [AuditService, DomainEventsService],
  exports: [AuditService, DomainEventsService]
})
export class CoreModule {}
