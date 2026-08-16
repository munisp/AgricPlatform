import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LANGUAGE_CODES, USER_ROLES, type LanguageCode, type User, type UserRole } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { AuditService } from '../../core/audit.service.js';
import { UsersService } from './users.service.js';

class ListUsersQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @IsOptional()
  @IsString()
  q?: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  preferredLanguage?: LanguageCode;
}

/**
 * User directory endpoints. User records are personal data: listing is
 * admin-only, and per-user reads/updates require the owning user or an
 * admin (same ownership rule as the privacy module).
 */
@ApiTags('users')
@Controller('users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService
  ) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List users with role/search filters (admin only)' })
  list(@Query() query: ListUsersQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @Authenticated()
  @ApiOperation({ summary: 'Get a user by id (own record or admin)' })
  async get(@Param('id') id: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, id);
    return { data: await this.users.getById(id) };
  }

  @Patch(':id')
  @Authenticated()
  @ApiOperation({ summary: 'Update own user record (or admin)' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: User | null) {
    const owner = assertSelfOrAdmin(actor, id);
    const user = await this.users.update(id, dto);
    await this.audit.record({ actorId: owner.id, action: 'user.updated', entityType: 'user', entityId: id });
    return { data: user };
  }
}
