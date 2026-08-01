import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import type { VaultDocument } from '@agric-platform/shared';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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
  creditProfile(@Param('userId') userId: string) {
    return { data: this.finance.creditProfile(userId) };
  }

  @Get('kyc/:userId')
  @ApiOperation({ summary: 'KYC tier and requirements for the next tier' })
  kyc(@Param('userId') userId: string) {
    return { data: this.finance.kycStatus(userId) };
  }

  @Get('lender-matches/:userId')
  @ApiOperation({ summary: 'Lender matches for a credit profile (stub lenders)' })
  lenderMatches(@Param('userId') userId: string) {
    return { data: this.finance.lenderMatches(userId) };
  }

  @Get('documents')
  @ApiOperation({ summary: 'List document vault entries' })
  documents(@Query('userId') userId?: string, @Query('status') status?: VaultDocument['status']) {
    return { data: this.finance.listDocuments(userId, status) };
  }

  @Post('documents')
  @ApiOperation({ summary: 'Register an uploaded vault document' })
  upload(@Body() dto: UploadDocumentDto) {
    return { data: this.finance.uploadDocument(dto) };
  }

  @Patch('documents/:id/status')
  @ApiOperation({ summary: 'Verify or reject a vault document (review workflow)' })
  setDocumentStatus(
    @Param('id') id: string,
    @Body() dto: DocumentStatusDto,
    @ActorId() actorId: string
  ) {
    const document = this.finance.setDocumentStatus(id, dto.status, actorId);
    this.audit.record({
      actorId,
      action: 'document.reviewed',
      entityType: 'vault_document',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: document };
  }
}
