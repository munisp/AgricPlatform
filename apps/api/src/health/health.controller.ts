import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IntegrationsService } from '../modules/integrations/integrations.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @ApiOperation({ summary: 'Overall API health' })
  health() {
    return {
      status: 'ok',
      service: '@agric-platform/api',
      version: '0.1.0',
      timestamp: new Date().toISOString()
    };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe including integration adapter status' })
  ready() {
    const statuses = this.integrations.list();
    return {
      status: statuses.every((s) => s.healthy) ? 'ok' : 'degraded',
      integrations: statuses
    };
  }
}
