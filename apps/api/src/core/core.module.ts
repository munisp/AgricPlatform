import { Global, Module } from '@nestjs/common';
import { OidcService } from '../common/auth/oidc.service.js';
import { ErrorTrackingService } from '../common/error-tracking/error-tracking.service.js';
import {
  AUTHORIZATION_CHECK,
  createAuthorizationCheck
} from '../common/auth/authorization-check.driver.js';
import { AuditService } from './audit.service.js';
import { DomainEventsService } from './domain-events.service.js';
import { EventDedupService } from './event-dedup.service.js';
import { OutboxSweeperService } from './outbox-sweeper.service.js';
import { EVENT_BUS, createEventBus } from './events/event-bus.driver.js';
import {
  WORKFLOW_ORCHESTRATOR,
  createWorkflowOrchestrator
} from '../common/orchestration/workflow-orchestrator.driver.js';

/**
 * Cross-cutting platform services (audit, domain event outbox, OIDC token
 * verification, error tracking) available to every module without explicit
 * imports. Wave P adds the outbox sweeper and consumer-side event dedup.
 * Wave FABRIC adds the fail-closed middleware driver ports: event bus
 * (stub | kafka), workflow orchestrator (stub | temporal) and authorization
 * check (stub | permify) — every factory defaults to the current-behaviour
 * stub and throws ProviderConfigError at boot when a live driver is
 * selected without its configuration.
 */
@Global()
@Module({
  providers: [
    AuditService,
    DomainEventsService,
    OidcService,
    ErrorTrackingService,
    EventDedupService,
    OutboxSweeperService,
    { provide: EVENT_BUS, useFactory: () => createEventBus(process.env) },
    {
      provide: WORKFLOW_ORCHESTRATOR,
      useFactory: () => createWorkflowOrchestrator(process.env)
    },
    {
      provide: AUTHORIZATION_CHECK,
      useFactory: () => createAuthorizationCheck(process.env)
    }
  ],
  exports: [
    AuditService,
    DomainEventsService,
    OidcService,
    ErrorTrackingService,
    EventDedupService,
    OutboxSweeperService,
    EVENT_BUS,
    WORKFLOW_ORCHESTRATOR,
    AUTHORIZATION_CHECK
  ]
})
export class CoreModule {}
