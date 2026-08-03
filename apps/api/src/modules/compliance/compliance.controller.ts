import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ComplianceRetentionService } from './compliance-retention.service.js';
import { ComplianceService } from './compliance.service.js';

class RecordConsentDto {
  @IsString()
  purpose!: string;

  @IsString()
  policyVersion!: string;

  @IsOptional()
  @IsString()
  source?: string;
}

class RejectDsrDto {
  @IsString()
  note!: string;
}

class RetentionSweepDto {
  /** Default true — pass an explicit false to execute anonymisation/purge. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

class UpsertRetentionPolicyDto {
  @IsString()
  entity!: string;

  @IsInt()
  @Min(1)
  retainDays!: number;

  @IsBoolean()
  anonymizeNotDelete!: boolean;
}

/**
 * NDPA 2023 readiness endpoints (Wave COMP). Consent + DSR routes are
 * self-service for the authenticated data subject; approve/reject/sweep/
 * policy routes are admin-only (RolesGuard + service-level check).
 *
 * TOOLING ONLY — docs/compliance/* are templates awaiting qualified
 * Nigerian legal/DPO review; nothing here is compliance sign-off.
 */
@ApiTags('compliance')
@Controller('compliance')
@UseGuards(RolesGuard)
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly retention: ComplianceRetentionService
  ) {}

  @Post('consents')
  @Authenticated()
  @ApiOperation({ summary: 'Record a consent decision with the policy version agreed to (NDPA)' })
  async recordConsent(@Body() dto: RecordConsentDto, @CurrentUser() actor: User | null) {
    return { data: await this.compliance.recordConsent(actor, dto) };
  }

  @Delete('consents/:purpose')
  @Authenticated()
  @ApiOperation({ summary: 'Revoke the caller\'s active consent for a purpose (audited)' })
  async revokeConsent(@Param('purpose') purpose: string, @CurrentUser() actor: User | null) {
    return { data: await this.compliance.revokeConsent(actor, purpose) };
  }

  @Get('consents/mine')
  @Authenticated()
  @ApiOperation({ summary: 'The caller\'s consent records (grant + revocation history)' })
  async myConsents(@CurrentUser() actor: User | null) {
    return { data: await this.compliance.myConsents(actor) };
  }

  @Post('dsr/export')
  @Authenticated()
  @ApiOperation({
    summary:
      'NDPA s.37 export: creates the request and synchronously returns the caller\'s ' +
      'personal-data bundle (uncovered categories are listed as explicit omissions).'
  })
  async requestExport(@CurrentUser() actor: User | null) {
    return { data: await this.compliance.requestExport(actor) };
  }

  @Post('dsr/erasure')
  @Authenticated()
  @ApiOperation({
    summary:
      'NDPA s.38 erasure: creates a pending request; an admin approval anonymises the ' +
      'identity record (financial/audit rows stay under legal hold).'
  })
  async requestErasure(@CurrentUser() actor: User | null) {
    return { data: await this.compliance.requestErasure(actor) };
  }

  @Get('dsr/mine')
  @Authenticated()
  @ApiOperation({ summary: 'The caller\'s data-subject requests and their status' })
  async myRequests(@CurrentUser() actor: User | null) {
    return { data: await this.compliance.myRequests(actor) };
  }

  @Post('dsr/:id/approve')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin: approve a pending erasure request (executes anonymisation)' })
  async approve(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.compliance.approve(actor, id) };
  }

  @Post('dsr/:id/reject')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin: reject a pending data-subject request with a note' })
  async reject(@Param('id') id: string, @Body() dto: RejectDsrDto, @CurrentUser() actor: User | null) {
    return { data: await this.compliance.reject(actor, id, dto.note) };
  }

  @Get('retention/policies')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin: retention policies consumed by the sweeper' })
  async retentionPolicies() {
    return { data: await this.retention.listPolicies() };
  }

  @Post('retention/policies')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin: upsert a retention policy (audited)' })
  async upsertRetentionPolicy(@Body() dto: UpsertRetentionPolicyDto, @CurrentUser() actor: User | null) {
    return { data: await this.retention.upsertPolicy(actor, dto) };
  }

  @Post('retention/sweep')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Run one retention sweeper pass. DRY-RUN by default; pass { dryRun: false } to ' +
      'execute. An external scheduler should invoke this endpoint (cron documented in ' +
      'docs/compliance/retention-policy.md); the API starts no timers of its own.'
  })
  async sweep(@Body() dto: RetentionSweepDto, @CurrentUser() actor: User | null) {
    return { data: await this.retention.sweep(actor, { dryRun: dto?.dryRun ?? true }) };
  }
}
