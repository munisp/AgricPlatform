import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested
} from 'class-validator';
import { Type } from 'class-transformer';
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
  @MaxLength(500)
  q?: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  preferredLanguage?: LanguageCode;
}

/** OB-04: presence proof attestation for assisted-account onboarding. */
class PresenceProofDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  method!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  ref!: string;
}

/**
 * OB-04: assisted/shared-phone onboarding (V-44). The deep gates (presence,
 * custodian active, XOR custodian kinds, agent role) live in
 * UsersService.createAssisted — this DTO enforces shape only.
 */
class CreateAssistedDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  @IsIn(LANGUAGE_CODES)
  preferredLanguage!: LanguageCode;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(USER_ROLES.length)
  @IsIn(USER_ROLES, { each: true })
  roles?: UserRole[];

  @IsOptional()
  @Matches(/^\+[1-9][0-9]{7,14}$/, { message: 'contactPhone must be in E.164 format' })
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  guardianUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  custodianAgentId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  relationship!: string;

  @ValidateNested()
  @Type(() => PresenceProofDto)
  presenceProof!: PresenceProofDto;
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

  /**
   * OB-04: assisted/shared-phone onboarding (V-44). Field agents and admins
   * onboard phoneless/shared-SIM dependents; the service enforces presence
   * (actor must be the guardian/custodian or an admin), an active custodian
   * account and a presence proof, and commits user row + guardian link
   * atomically.
   */
  @Post('assisted')
  @Roles('agent', 'admin')
  @ApiOperation({
    summary: 'Onboard an assisted (phoneless/shared-SIM) account via a guardian or custodian agent'
  })
  async createAssisted(@Body() dto: CreateAssistedDto, @CurrentUser() actor: User | null) {
    const result = await this.users.createAssisted(dto, actor);
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'user.assisted_created',
      entityType: 'user',
      entityId: result.user.id,
      metadata: { linkId: result.link.id, kind: result.link.kind }
    });
    return { data: result };
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
