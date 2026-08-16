import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { DashboardService } from './dashboard.service.js';

/**
 * Role-aware dashboards aggregate a member's own data — restricted to the
 * owning user or an admin.
 */
@ApiTags('dashboard')
@Controller('dashboard')
@UseGuards(RolesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get(':userId')
  @Authenticated()
  @ApiOperation({ summary: 'Role-aware dashboard for a user (own dashboard or admin)' })
  async get(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.dashboard.dashboardFor(userId) };
  }
}
