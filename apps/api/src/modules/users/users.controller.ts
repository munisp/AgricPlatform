import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { LANGUAGE_CODES, USER_ROLES, type LanguageCode, type UserRole } from '@agric-platform/shared';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService
  ) {}

  @Get()
  @ApiOperation({ summary: 'List users with role/search filters' })
  list(@Query() query: ListUsersQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id' })
  async get(@Param('id') id: string) {
    return { data: await this.users.getById(id) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update own user record' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @ActorId() actorId: string) {
    const user = await this.users.update(id, dto);
    await this.audit.record({ actorId, action: 'user.updated', entityType: 'user', entityId: id });
    return { data: user };
  }
}
