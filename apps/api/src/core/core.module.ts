import { Global, Module } from '@nestjs/common';
import { OidcService } from '../common/auth/oidc.service.js';
import { ErrorTrackingService } from '../common/error-tracking/error-tracking.service.js';
import { AuditService } from './audit.service.js';
import { DomainEventsService } from './domain-events.service.js';
import { EventDedupService } from './event-dedup.service.js';
import { OutboxSweeperService } from './outbox-sweeper.service.js';

/**
 * Cross-cutting platform services (audit, domain event outbox, OIDC token
 * verification, error tracking) available to every module without explicit
 * imports. Wave P adds the outbox sweeper and consumer-side event dedup.
 */
@Global()
@Module({
  providers: [
    AuditService,
    DomainEventsService,
    OidcService,
    ErrorTrackingService,
    EventDedupService,
    OutboxSweeperService
  ],
  exports: [
    AuditService,
    DomainEventsService,
    OidcService,
    ErrorTrackingService,
    EventDedupService,
    OutboxSweeperService
  ]
})
export class CoreModule {}
