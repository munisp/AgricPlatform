import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ActorId } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type { RawBodyRequest } from '../../bootstrap.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { IntegrationsService } from './integrations.service.js';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    private readonly metrics: MetricsService
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Status of all provider adapters (stub/sandbox/production)' })
  list() {
    return { data: this.integrations.list() };
  }

  @Get(':provider')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Provider adapter detail and driver metadata' })
  get(@Param('provider') provider: string) {
    return { data: this.integrations.status(provider) };
  }

  @Get(':provider/health')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Provider adapter health check' })
  health(@Param('provider') provider: string) {
    return { data: this.integrations.health(provider) };
  }

  @Post('webhooks/:provider')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Receive a provider webhook. The provider-native signature scheme is required ' +
      '(Paystack: HMAC-SHA512 in x-paystack-signature; Flutterwave: static verif-hash; ' +
      'others: HMAC-SHA256 over the raw body) unless the provider runs the stub driver ' +
      'outside production.'
  })
  async webhook(
    @Param('provider') provider: string,
    @Body() payload: unknown,
    @Req() request: RawBodyRequest,
    @ActorId() actorId: string
  ) {
    const digest = this.integrations.verifyWebhookSignature(
      provider,
      request.rawBody,
      request.headers
    );
    const result = await this.integrations.recordWebhook(provider, payload, digest);
    // Audit C2: a duplicate whose processing never completed (transient
    // failure after the dedupe insert) is RE-DRIVEN below — a bare
    // duplicate 200 would permanently lose the verified event because the
    // provider stops retrying. Side effects are idempotent (audit is
    // append-only; consumers dedupe by payload — see
    // InboundConversationsService). A failure here answers 5xx so the
    // provider keeps retrying and the record stays unprocessed.
    const needsProcessing = !result.duplicate || result.reprocess === true;
    // Payment webhooks drive the payments lifecycle metric (plan §A.3).
    if (this.integrations.status(provider).capability === 'payments') {
      this.metrics.paymentEvent(
        result.duplicate && !result.reprocess ? 'webhook_duplicate' : 'webhook_received'
      );
    }
    if (needsProcessing) {
      await this.audit.record({
        actorId,
        action: 'integration.webhook_received',
        entityType: 'integration',
        entityId: provider
      });
      // The verified payload rides the event so inbound-conversation
      // consumers (wave P5b WhatsApp workflows) can process it without the
      // integrations module depending back on them.
      await this.events.publish('integration.webhook.received', { provider, payload }, actorId);
      await this.integrations.markWebhookProcessed(provider, payload, digest);
    }
    return { data: result };
  }
}
