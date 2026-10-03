import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsDefined, IsISO8601, IsNotEmpty, IsString } from 'class-validator';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { IntegrationsService, type EventGwEnvelope } from './integrations.service.js';
import { Public } from '../../common/auth/roles.decorator.js';

/**
 * event-gw fanout envelope (GAP-C03/GAP-H01; mirrors the Go Envelope in
 * services/event-gw/internal/gateway/fanout.go). The global ValidationPipe
 * runs whitelist + forbidNonWhitelisted, so any extra top-level field —
 * including a smuggled provider-native signature field — is a 400.
 */
export class EventGwEnvelopeDto implements EventGwEnvelope {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsString()
  @IsNotEmpty()
  eventId!: string;

  /** RFC3339 UTC timestamp assigned by the sidecar when the event arrived. */
  @IsISO8601()
  receivedAt!: string;

  /** Raw provider event body, forwarded unmodified. */
  @IsDefined()
  payload!: unknown;
}

/** Audit/event attribution for machine-to-machine sidecar deliveries. */
const EVENT_GW_ACTOR = 'event-gw';

/**
 * Dedicated internal ingress for the event-gw sidecar:
 * POST /api/v1/internal/events (the global prefix supplies /api/v1).
 *
 * GAP-C03: without this route every verified webhook fanned out by
 * event-gw 404'd and was spooled forever while providers were told 202.
 * GAP-H01: this path is authenticated ONLY by the X-Internal-Token shared
 * credential (InternalTokenGuard, fail-closed) — provider-native signature
 * headers are stripped by the sidecar and are neither required nor trusted
 * here, and the public provider webhook route's signature semantics are
 * untouched. The envelope's provider/eventId/receivedAt provenance and the
 * raw payload are recorded through the same durable dedupe store, audit
 * trail and domain-event bus as the public webhook path.
 */
@ApiTags('internal')
@Controller('internal')
export class InternalEventsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    private readonly metrics: MetricsService
  ) {}

  @Post('events')
  @Public()
  @UseGuards(InternalTokenGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Receive a verified event envelope from the event-gw sidecar. Requires the ' +
      'X-Internal-Token shared credential (401 missing/invalid, 503 when the API ' +
      'has no EVENTGW_INTERNAL_TOKEN configured). Provider-native signatures are ' +
      'NOT trusted on this path — the sidecar verified them at the edge. Exact ' +
      'envelope replays are idempotent (duplicate: true); a replay whose first ' +
      'delivery never completed processing is re-driven (reprocess: true).'
  })
  async receive(@Body() envelope: EventGwEnvelopeDto) {
    const result = await this.integrations.recordInternalEvent(envelope);
    // Same crash-recovery contract as the public webhook route (audit C2):
    // a duplicate whose processing never completed is RE-DRIVEN below and a
    // failure answers 5xx so the sidecar keeps retrying instead of the
    // verified event being lost.
    const needsProcessing = !result.duplicate || result.reprocess === true;
    // Payment events drive the payments lifecycle metric (parity with the
    // public webhook route). The sidecar's provider namespace is broader
    // than the adapter registry, so this is a non-throwing lookup.
    if (this.integrations.find(envelope.provider)?.status().capability === 'payments') {
      this.metrics.paymentEvent(
        result.duplicate && !result.reprocess ? 'webhook_duplicate' : 'webhook_received'
      );
    }
    if (needsProcessing) {
      await this.audit.record({
        actorId: EVENT_GW_ACTOR,
        action: 'integration.internal_event_received',
        entityType: 'integration',
        entityId: envelope.provider,
        metadata: {
          source: 'event-gw',
          eventId: envelope.eventId,
          receivedAt: envelope.receivedAt
        }
      });
      // Consumers receive the RAW provider payload on the same domain event
      // as the public webhook route; the envelope wrapper stays in the
      // dedupe/audit records only.
      await this.events.publish(
        'integration.webhook.received',
        { provider: envelope.provider, payload: envelope.payload },
        EVENT_GW_ACTOR
      );
      await this.integrations.markInternalEventProcessed(envelope);
    }
    return { data: result };
  }
}
