import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { SELF_REGISTRATION_ROLES, USER_ROLES, type User, type UserRole } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { AuditService } from '../../core/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { UsersService } from '../users/users.service.js';

class AdminUsersQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lga?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: UserRole;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  search?: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  email?: string;

  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lga?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;
}

class RolesDto {
  @ArrayNotEmpty()
  @IsIn(USER_ROLES, { each: true })
  roles!: UserRole[];
}

class TierDto {
  @IsIn(['tier_0', 'tier_1', 'tier_2', 'tier_3'])
  tier!: 'tier_0' | 'tier_1' | 'tier_2' | 'tier_3';
}

class StatusDto {
  @IsIn(['active', 'suspended', 'deceased'])
  status!: 'active' | 'suspended' | 'deceased';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  /** Required when status = 'deceased' (GAP-H04). */
  @IsOptional()
  @IsISO8601()
  dateOfDeath?: string;
}

class CreateUserDto {
  @IsString()
  @MaxLength(100)
  phone!: string;

  @IsString()
  @MaxLength(500)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  email?: string;

  @IsArray()
  @IsIn(USER_ROLES, { each: true })
  roles!: UserRole[];

  @IsOptional()
  @IsString()
  @Length(2, 5)
  preferredLanguage?: string;
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly chapters: ChaptersService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService
  ) {}

  @Get('users')
  @ApiOperation({ summary: 'List users with filters (admin)' })
  async listUsers(@Query() query: AdminUsersQuery) {
    return this.users.list(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'User detail (admin)' })
  async getUser(@Param('id') id: string) {
    return { data: await this.users.getById(id) };
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Update profile fields (admin)' })
  async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: User | null) {
    const updated = await this.users.update(id, dto);
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'user.admin_updated',
      entityType: 'user',
      entityId: id,
      metadata: { fields: Object.keys(dto) }
    });
    return { data: updated };
  }

  @Patch('users/:id/roles')
  @ApiOperation({ summary: 'Replace user roles (admin; cannot demote the last admin)' })
  async setRoles(@Param('id') id: string, @Body() dto: RolesDto, @CurrentUser() actor: User | null) {
    const updated = await this.users.setRoles(id, dto.roles, actor!.id);
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'user.roles_changed',
      entityType: 'user',
      entityId: id,
      metadata: { roles: dto.roles }
    });
    return { data: updated };
  }

  @Patch('users/:id/tier')
  @ApiOperation({ summary: 'Set KYC tier (admin)' })
  async setTier(@Param('id') id: string, @Body() dto: TierDto, @CurrentUser() actor: User | null) {
    const updated = await this.users.setKycTier(id, dto.tier, actor!.id);
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'user.kyc_tier_changed',
      entityType: 'user',
      entityId: id,
      metadata: { tier: dto.tier }
    });
    return { data: updated };
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend/reactivate/freeze (deceased) an account (admin; audited)' })
  async setStatus(@Param('id') id: string, @Body() dto: StatusDto, @CurrentUser() actor: User | null) {
    const updated = await this.users.setStatus(id, dto.status, actor!.id, {
      dateOfDeath: dto.dateOfDeath,
      reason: dto.reason
    });
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: `user.status_${dto.status}`,
      entityType: 'user',
      entityId: id,
      metadata: { reason: dto.reason, dateOfDeath: dto.dateOfDeath }
    });
    return { data: updated };
  }

  @Post('users')
  @ApiOperation({ summary: 'Create a user account (admin provisioning)' })
  async createUser(@Body() dto: CreateUserDto, @CurrentUser() actor: User | null) {
    // Admin provisioning may grant privileged roles — that is the explicit
    // admin path that self-registration (auth.controller.ts) rejects.
    const created = await this.users.create({
      phone: dto.phone,
      fullName: dto.fullName,
      email: dto.email,
      roles: dto.roles.length > 0 ? dto.roles : [...SELF_REGISTRATION_ROLES],
      preferredLanguage: (dto.preferredLanguage as User['preferredLanguage']) ?? 'en'
    });
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'user.admin_created',
      entityType: 'user',
      entityId: created.id,
      metadata: { roles: created.roles }
    });
    return { data: created };
  }

  @Post('users/:id/sessions/revoke-all')
  @ApiOperation({ summary: 'Revoke every refresh-token session for a user (admin incident response)' })
  async revokeSessions(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const target = await this.users.getById(id);
    const revoked = await this.sessions.revokeAllForUser(id);
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'user.sessions_revoked',
      entityType: 'user',
      entityId: id,
      metadata: { phone: target.phone, revoked }
    });
    return { data: { userId: id, sessionsRevoked: revoked } };
  }

  @Get('chapters/:id/members')
  @ApiOperation({ summary: 'Chapter roster (admin view)' })
  async chapterMembers(@Param('id') id: string) {
    return { data: await this.chapters.listMembers(id) };
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: 'Revoke one refresh-token session by id (admin incident response)' })
  async revokeSession(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const session = await this.sessions.getById(id);
    if (!session) {
      throw new ForbiddenException(`Session '${id}' not found`);
    }
    await this.sessions.revokeById(id);
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'session.revoked',
      entityType: 'refresh_session',
      entityId: id,
      metadata: { userId: session.userId }
    });
    return { data: { revoked: true, sessionId: id } };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List refresh-token sessions, optionally filtered by user (admin)' })
  async listSessions(@Query('userId') userId?: string) {
    const sessions = userId
      ? await this.sessions.listForUser(userId)
      : await this.sessions.listAll();
    return {
      data: sessions.map(({ refreshTokenHash: _hash, ...rest }) => rest)
    };
  }
}
