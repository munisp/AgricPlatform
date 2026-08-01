import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import type { User, VaultDocument } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AuditService } from '../../core/audit.service.js';
import { FinanceService, type UploadDocumentInput } from './finance.service.js';

const DOCUMENT_KINDS = [
  'national_id',
  'land_title',
  'farm_photo',
  'certificate',
  'business_plan',
  'utility_bill'
] as const;

class UploadDocumentDto implements UploadDocumentInput {
  @IsString()
  userId!: string;

  @IsIn(DOCUMENT_KINDS)
  kind!: VaultDocument['kind'];

  @IsString()
  fileName!: string;
}

class DocumentStatusDto {
  @IsIn(['uploaded', 'verified', 'rejected'])
  status!: VaultDocument['status'];
}

@ApiTags('finance')
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly audit: AuditService
  ) {}

  @Get('credit-profile/:userId')
  @ApiOperation({ summary: 'Credit readiness profile recomputed from live signals' })
  async creditProfile(@Param('userId') userId: string) {
    return { data: await this.finance.creditProfile(userId) };
  }

  @Get('kyc/:userId')
  @ApiOperation({ summary: 'KYC tier and requirements for the next tier' })
  async kyc(@Param('userId') userId: string) {
    return { data: await this.finance.kycStatus(userId) };
  }

  @Get('lender-matches/:userId')
  @ApiOperation({ summary: 'Lender matches for a credit profile (stub lenders)' })
  async lenderMatches(@Param('userId') userId: string) {
    return { data: await this.finance.lenderMatches(userId) };
  }

  @Get('documents')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List document vault entries (own records or admin)' })
  async documents(
    @CurrentUser() actor: User | null,
    @Query('userId') userId?: string,
    @Query('status') status?: VaultDocument['status']
  ) {
    if (userId) {
      assertSelfOrAdmin(actor, userId);
    } else if (!actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing the document vault across users requires the admin role');
    }
    return { data: await this.finance.listDocuments(userId, status) };
  }

  @Post('documents')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Register an uploaded vault document (own vault or admin)' })
  async upload(@Body() dto: UploadDocumentDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.finance.uploadDocument(dto) };
  }

  @Patch('documents/:id/status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Verify or reject a vault document (admin review workflow)' })
  async setDocumentStatus(
    @Param('id') id: string,
    @Body() dto: DocumentStatusDto,
    @CurrentUser() actor: User | null
  ) {
    const actorId = actor?.id ?? 'anonymous';
    const document = await this.finance.setDocumentStatus(id, dto.status, actorId);
    await this.audit.record({
      actorId,
      action: 'document.reviewed',
      entityType: 'vault_document',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: document };
  }
}
