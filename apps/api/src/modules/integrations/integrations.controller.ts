import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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
  @ApiOperation({ summary: 'Status of all provider adapters (stub/sandbox/production)' })
  list() {
    return { data: this.integrations.list() };
  }

  @Get(':provider')
  @ApiOperation({ summary: 'Provider adapter detail and driver metadata' })
  get(@Param('provider') provider: string) {
    return { data: this.integrations.status(provider) };
  }

  @Get(':provider/health')
  @ApiOperation({ summary: 'Provider adapter health check' })
  health(@Param('provider') provider: string) {
    return { data: this.integrations.health(provider) };
  }

  @Post('webhooks/:provider')
  @ApiOperation({ summary: 'Receive a provider webhook (payload recorded, no external calls)' })
  webhook(@Param('provider') provider: string, @Body() payload: unknown, @ActorId() actorId: string) {
    const result = this.integrations.recordWebhook(provider, payload);
    this.audit.record({
      actorId,
      action: 'integration.webhook_received',
      entityType: 'integration',
      entityId: provider
    });
    this.events.publish('integration.webhook.received', { provider }, actorId);
    return { data: result };
  }
}
