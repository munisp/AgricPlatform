import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min
} from 'class-validator';
import { LANGUAGE_CODES, USER_ROLES, type LanguageCode, type UserRole } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import type { User } from '@agric-platform/shared';
import { E164_PATTERN } from '../auth/auth.controller.js';
import { AdminService, type AccountStatus } from './admin.service.js';

class UpdateRolesDto {
  @ArrayNotEmpty()
  @ArrayMaxSize(USER_ROLES.length)
  @IsIn(USER_ROLES, { each: true })
  roles!: UserRole[];
}

/** Admin user-directory query: validated role filter + real pagination (L-15/V-72). */
class AdminUsersQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;
}

class UpdateStatusDto {
  @IsIn(['active', 'suspended'])
  status!: AccountStatus;
}

class UpdateVerificationDto {
  @IsBoolean()
  isVerified!: boolean;
}

/**
 * OB-17a: admin-provisioned account. The account is created UNVERIFIED and
 * must complete OTP verification on first login (same flow as self-service
 * registration, OB-01).
 */
class AdminCreateUserDto {
  @Matches(E164_PATTERN, { message: 'phone must be in E.164 format (e.g. +2348012345678)' })
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  @ArrayNotEmpty()
  @ArrayMaxSize(USER_ROLES.length)
  @IsIn(USER_ROLES, { each: true })
  roles!: UserRole[];

  @IsIn(LANGUAGE_CODES)
  preferredLanguage!: LanguageCode;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;
}

/** OB-17b: partner-organisation client provisioning (tenant-bound). */
class AdminRegisterPartnerClientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  partnerId!: string;

  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  scopes!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  rateLimitPerMin?: number;
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @ApiOperation({ summary: 'List users with account status overlay (paginated)' })
  async users(@Query() query: AdminUsersQueryDto) {
    return { data: await this.admin.listUsers(query.role, query.page, query.pageSize) };
  }

  @Post('users')
  @ApiOperation({
    summary:
      'Provision a user account directly (audited). Created unverified: the user completes OTP verification on first login.'
  })
  async createUser(@Body() dto: AdminCreateUserDto, @CurrentUser() actor: User | null) {
    return { data: await this.admin.createUser(dto, actor?.id ?? 'admin') };
  }

  @Post('partner-clients')
  @ApiOperation({
    summary:
      'Register a partner-organisation API client (audited; tenant-bound). The plaintext secret is returned exactly once.'
  })
  async registerPartnerClient(
    @Body() dto: AdminRegisterPartnerClientDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.admin.registerPartnerClient(dto, actor?.id ?? 'admin') };
  }

  @Patch('users/:id/roles')
  @ApiOperation({ summary: "Set a user's roles (audited)" })
  async setRoles(@Param('id') id: string, @Body() dto: UpdateRolesDto, @CurrentUser() actor: User | null) {
    return { data: await this.admin.setRoles(id, dto.roles, actor?.id ?? 'admin') };
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Activate or suspend a user account (audited)' })
  async setStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.admin.setStatus(id, dto.status, actor?.id ?? 'admin') };
  }

  @Patch('users/:id/verification')
  @ApiOperation({ summary: "Set a user's verification state (audited)" })
  async setVerification(
    @Param('id') id: string,
    @Body() dto: UpdateVerificationDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.admin.setVerified(id, dto.isVerified, actor?.id ?? 'admin') };
  }

  @Put('users/:id/partner-memberships/:partnerId')
  @ApiOperation({
    summary:
      'Bind a user to a partner organisation (tenant binding for /partner/:partnerId/*; audited, idempotent)'
  })
  async bindPartnerMember(
    @Param('id') id: string,
    @Param('partnerId') partnerId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.admin.bindPartnerMember(id, partnerId, actor?.id ?? 'admin') };
  }

  @Delete('users/:id/partner-memberships/:partnerId')
  @ApiOperation({ summary: 'Revoke a partner-organisation binding (audited)' })
  async unbindPartnerMember(
    @Param('id') id: string,
    @Param('partnerId') partnerId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.admin.unbindPartnerMember(id, partnerId, actor?.id ?? 'admin') };
  }

  @Get('partner-memberships')
  @ApiOperation({ summary: 'List partner tenant bindings (optionally filtered by userId)' })
  async partnerMemberships(@Query('userId') userId?: string) {
    return { data: await this.admin.partnerMemberships(userId) };
  }

  @Get('review-queue')
  @ApiOperation({ summary: 'Moderation/review queue: flagged topics, documents, applications' })
  async reviewQueue() {
    return { data: await this.admin.reviewQueue() };
  }

  @Get('kpis')
  @ApiOperation({ summary: 'Platform KPIs (repository-computed, live basis; seed refused in production)' })
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
    summary:
      'Verify the tamper-evident audit hash chain ({valid, brokenAt?, checked, anchors?}). ' +
      'Optional fromId/toId bound the walk to a contiguous range (regulator spot-checks). ' +
      'The anchors section verifies the Stage 23 anchoring checkpoints and reports ' +
      'anchor-chain breaks (brokenAnchorAt) and tail-truncation gaps (gap).'
  })
  async verifyAuditLog(@Query('fromId') fromId?: string, @Query('toId') toId?: string) {
    return { data: await this.admin.verifyAuditLog({ fromId, toId }) };
  }

  @Post('audit-log/anchors')
  @ApiOperation({
    summary:
      'Create an anchoring checkpoint over the current audit chain tip (Stage 23). ' +
      'Notarizes tip event id + tip hash + event count into the tamper-evident anchor ' +
      'chain (and the configured off-box sink). An external scheduler should invoke ' +
      'this periodically, or set AUDIT_ANCHOR_INTERVAL_MS for an in-process timer.'
  })
  async createAuditAnchor() {
    return { data: await this.admin.createAuditAnchor() };
  }

  @Get('audit-log/anchors')
  @ApiOperation({
    summary: 'List anchoring checkpoints in anchor-chain order (Stage 23, admin only)'
  })
  async auditAnchors() {
    return { data: await this.admin.listAuditAnchors() };
  }

  @Get('events')
  @ApiOperation({ summary: 'Domain event outbox ({domain}.{entity}.{verb} taxonomy)' })
  async events() {
    return { data: await this.admin.eventOutbox() };
  }

  @Post('outbox/sweep')
  @ApiOperation({
    summary:
      'Run one outbox sweeper pass: retries stalled unpublished rows with backoff and ' +
      'dead-letters exhausted rows. An external scheduler should invoke this endpoint ' +
      'periodically; the API starts no timers of its own.'
  })
  async sweepOutbox() {
    return { data: await this.admin.sweepOutbox() };
  }

  @Post('webhooks/reprocess')
  @ApiOperation({
    summary:
      'Run one webhook crash-recovery pass: re-drives recorded provider webhooks whose ' +
      'processing never completed (dedupe insert succeeded, side effects failed). An ' +
      'external scheduler should invoke this endpoint periodically; the API starts no ' +
      'timers of its own.'
  })
  async reprocessWebhooks() {
    return { data: await this.admin.reprocessWebhooks() };
  }

  @Get('outbox/dead-letters')
  @ApiOperation({ summary: 'Dead-lettered outbox rows (admin only)' })
  async outboxDeadLetters() {
    return { data: await this.admin.outboxDeadLetters() };
  }

  @Post('outbox/dead-letters/:id/redrive')
  @ApiOperation({
    summary:
      'Redrive a dead-lettered outbox row (admin only, audited): clears dead_lettered_at and ' +
      'the attempt counter so the next sweep re-delivers it. 404 when the row is not dead-lettered.'
  })
  async redriveOutboxDeadLetter(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.admin.redriveOutboxDeadLetter(actor?.id ?? 'admin', id) };
  }

  @Post('sweeps/escrow-expiry')
  @ApiOperation({
    summary:
      'Run one escrow-expiry sweeper pass (WP-G12): auto-refunds held escrows past their ' +
      'heldUntil deadline and resumes stuck release/refund drives, all through the guarded ' +
      'escrow service semantics. Idempotent — an external scheduler (k8s CronJob) invokes ' +
      'this endpoint periodically.'
  })
  async sweepEscrowExpiry() {
    return { data: await this.admin.sweepEscrowExpiry() };
  }

  @Post('sweeps/voucher-stuck')
  @ApiOperation({
    summary:
      'Run one stuck-voucher sweeper pass (WP-G12): expires due vouchers and recovers stuck ' +
      'VOIDING/REDEEMING claims (TTL-doubled with a crash-silent marker). Idempotent — an ' +
      'external scheduler (k8s CronJob) invokes this endpoint periodically.'
  })
  async sweepVoucherStuck() {
    return { data: await this.admin.sweepVoucherStuck() };
  }
}
