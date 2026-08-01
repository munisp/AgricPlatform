import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service.js';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get(':userId')
  @ApiOperation({ summary: 'Role-aware dashboard for a user' })
  get(@Param('userId') userId: string) {
    return { data: this.dashboard.dashboardFor(userId) };
  }
}
