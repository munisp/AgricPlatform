import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ActorId } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type { RawBodyRequest } from '../../bootstrap.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { IntegrationsService } from './integrations.service.js';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService
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
      'Receive a provider webhook. HMAC-SHA256 signature over the raw body is required unless ' +
      'the provider runs the stub driver outside production.'
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
    const result = this.integrations.recordWebhook(provider, payload, digest);
    if (!result.duplicate) {
      await this.audit.record({
        actorId,
        action: 'integration.webhook_received',
        entityType: 'integration',
        entityId: provider
      });
      await this.events.publish('integration.webhook.received', { provider }, actorId);
    }
    return { data: result };
  }
}
