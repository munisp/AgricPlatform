import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsBoolean, IsIn } from 'class-validator';
import { USER_ROLES, type UserRole } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type { User } from '@agric-platform/shared';
import { AdminService, type AccountStatus } from './admin.service.js';

class UpdateRolesDto {
  @ArrayNotEmpty()
  @IsIn(USER_ROLES, { each: true })
  roles!: UserRole[];
}

class UpdateStatusDto {
  @IsIn(['active', 'suspended'])
  status!: AccountStatus;
}

class UpdateVerificationDto {
  @IsBoolean()
  isVerified!: boolean;
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @ApiOperation({ summary: 'List users with account status overlay' })
  async users(@Query('role') role?: UserRole) {
    return { data: await this.admin.listUsers(role) };
  }

  @Patch('users/:id/roles')
  @ApiOperation({ summary: 'Set a user\'s roles (audited)' })
  async setRoles(@Param('id') id: string, @Body() dto: UpdateRolesDto, @CurrentUser() actor: User | null) {
    return { data: await this.admin.setRoles(id, dto.roles, actor?.id ?? 'admin') };
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Activate or suspend a user account (audited)' })
  async setStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.admin.setStatus(id, dto.status, actor?.id ?? 'admin') };
  }

  @Patch('users/:id/verification')
  @ApiOperation({ summary: 'Set a user\'s verification state (audited)' })
  async setVerification(
    @Param('id') id: string,
    @Body() dto: UpdateVerificationDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.admin.setVerified(id, dto.isVerified, actor?.id ?? 'admin') };
  }

  @Get('review-queue')
  @ApiOperation({ summary: 'Moderation/review queue: flagged topics, documents, applications' })
  async reviewQueue() {
    return { data: await this.admin.reviewQueue() };
  }

  @Get('kpis')
  @ApiOperation({ summary: 'Platform KPIs (seed metrics + live counts)' })
  async kpis() {
    return { data: await this.admin.kpis() };
  }

  @Get('audit')
  @ApiOperation({ summary: 'Audit event log' })
  async auditLog(@Query('actorId') actorId?: string, @Query('entityType') entityType?: string) {
    return { data: await this.admin.auditLog(actorId, entityType) };
  }

  @Get('audit-log/verify')
  @ApiOperation({
    summary: 'Verify the tamper-evident audit hash chain ({valid, brokenAt?})'
  })
  async verifyAuditLog() {
    return { data: await this.admin.verifyAuditLog() };
  }

  @Get('events')
  @ApiOperation({ summary: 'Domain event outbox ({domain}.{entity}.{verb} taxonomy)' })
  async events() {
    return { data: await this.admin.eventOutbox() };
  }
}
