import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import {
  EXPORT_DOCUMENT_TYPES,
  LIVESTOCK_SPECIES,
  LIVESTOCK_SUBJECT_TYPES,
  OFFTAKE_CONTRACT_STATUSES,
  OFFTAKE_TEMPLATE_STATUSES
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type {
  CreateCertifiedListingInput
} from './certified-listings.service.js';
import { CertifiedListingsService } from './certified-listings.service.js';
import type {
  GenerateExportDocumentInput
} from './export-documents.service.js';
import { ExportDocumentsService } from './export-documents.service.js';
import type {
  CreateOfftakeTemplateInput,
  InstantiateContractInput,
  UpdateOfftakeTemplateInput
} from './offtake.service.js';
import { OfftakeService } from './offtake.service.js';

class CreateListingDto implements CreateCertifiedListingInput {
  @IsIn([...LIVESTOCK_SUBJECT_TYPES])
  subjectType!: CreateCertifiedListingInput['subjectType'];

  @IsString()
  subjectId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  askingPriceKobo?: number;
}

class RevokeListingDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

class CreateTemplateDto implements CreateOfftakeTemplateInput {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn([...LIVESTOCK_SPECIES])
  species!: CreateOfftakeTemplateInput['species'];

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultPricePerUnitKobo?: number;

  @IsInt()
  @Min(1)
  deliveryWindowDays!: number;

  @IsOptional()
  @IsString()
  defaultQualityGrade?: string;
}

class UpdateTemplateDto implements UpdateOfftakeTemplateInput {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultPricePerUnitKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  deliveryWindowDays?: number;

  @IsOptional()
  @IsString()
  defaultQualityGrade?: string;
}

class ListTemplatesQuery {
  @IsOptional()
  @IsIn([...OFFTAKE_TEMPLATE_STATUSES])
  status?: 'active' | 'archived';
}

class InstantiateContractDto implements InstantiateContractInput {
  @IsString()
  farmerUserId!: string;

  @IsString()
  buyerUserId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePerUnitKobo?: number;

  @IsOptional()
  @IsISO8601()
  deliveryWindowStart?: string;

  @IsOptional()
  @IsString()
  qualityGrade?: string;
}

class TransitionContractDto {
  @IsIn([...OFFTAKE_CONTRACT_STATUSES])
  to!: (typeof OFFTAKE_CONTRACT_STATUSES)[number];
}

class GenerateExportDocumentDto implements GenerateExportDocumentInput {
  @IsIn([...EXPORT_DOCUMENT_TYPES])
  documentType!: GenerateExportDocumentInput['documentType'];

  @IsIn([...LIVESTOCK_SUBJECT_TYPES])
  subjectType!: GenerateExportDocumentInput['subjectType'];

  @IsString()
  subjectId!: string;

  @IsOptional()
  @IsString()
  destinationCountry?: string;

  @IsOptional()
  @IsString()
  hsCode?: string;

  @IsOptional()
  @IsString()
  sanitaryCertificateRef?: string;
}

class ListExportDocumentsQuery {
  @IsIn([...LIVESTOCK_SUBJECT_TYPES])
  subjectType!: GenerateExportDocumentInput['subjectType'];

  @IsString()
  subjectId!: string;
}

@ApiTags('livestock-trade')
@Controller('livestock-trade')
@UseGuards(RolesGuard)
export class LivestockTradeController {
  constructor(
    private readonly listings: CertifiedListingsService,
    private readonly offtake: OfftakeService,
    private readonly exportDocuments: ExportDocumentsService
  ) {}

  // -- Certified listings ----------------------------------------------------

  @Post('listings')
  @Authenticated()
  @ApiOperation({
    summary:
      'Certify an owned animal/lot into a listing with a provenance snapshot (owner only; requires livestock_records consent). Idempotency-Key supported.'
  })
  async createListing(@Body() dto: CreateListingDto, @CurrentUser() actor: User | null) {
    return { data: await this.listings.create(actor, dto) };
  }

  @Get('listings/mine')
  @Authenticated()
  @ApiOperation({ summary: "List the caller's certified listings" })
  async listMyListings(@CurrentUser() actor: User | null) {
    return { data: await this.listings.listMine(actor) };
  }

  @Get('listings/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Listing detail (active listings are discoverable; others owner or admin)' })
  async getListing(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.listings.getById(actor, id) };
  }

  @Post('listings/:id/activate')
  @Authenticated()
  @ApiOperation({ summary: 'draft → active (owner or admin)' })
  async activateListing(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.listings.activate(actor, id) };
  }

  @Post('listings/:id/sold')
  @Authenticated()
  @ApiOperation({ summary: 'active → sold (owner or admin)' })
  async markListingSold(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.listings.markSold(actor, id) };
  }

  @Post('listings/:id/withdraw')
  @Authenticated()
  @ApiOperation({ summary: 'draft|active → withdrawn (owner or admin)' })
  async withdrawListing(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.listings.withdraw(actor, id) };
  }

  @Post('listings/:id/revoke')
  @Authenticated()
  @ApiOperation({ summary: 'Admin-only certification revocation (reason required)' })
  async revokeListing(
    @Param('id') id: string,
    @Body() dto: RevokeListingDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.listings.revoke(actor, id, dto.reason) };
  }

  // -- Off-take templates + contracts -----------------------------------------

  @Post('offtake-templates')
  @Authenticated()
  @ApiOperation({ summary: 'Create an off-take contract template (admin/partner)' })
  async createTemplate(@Body() dto: CreateTemplateDto, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.createTemplate(actor, dto) };
  }

  @Get('offtake-templates')
  @Authenticated()
  @ApiOperation({ summary: 'List off-take templates (filter by status)' })
  async listTemplates(@Query() query: ListTemplatesQuery, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.listTemplates(actor, query.status) };
  }

  @Patch('offtake-templates/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Update template variable-slot defaults (admin/partner)' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.offtake.updateTemplate(actor, id, dto) };
  }

  @Post('offtake-templates/:id/archive')
  @Authenticated()
  @ApiOperation({ summary: 'Archive a template (admin/partner)' })
  async archiveTemplate(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.archiveTemplate(actor, id) };
  }

  @Post('offtake-templates/:id/contracts')
  @Authenticated()
  @ApiOperation({
    summary:
      'Instantiate a farmer/buyer contract from a template; variable slots resolve from overrides or defaults. Idempotency-Key supported.'
  })
  async instantiateContract(
    @Param('id') id: string,
    @Body() dto: InstantiateContractDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.offtake.instantiate(actor, id, dto) };
  }

  @Get('offtake-contracts/mine')
  @Authenticated()
  @ApiOperation({ summary: 'Contracts where the caller is farmer or buyer' })
  async listMyContracts(@CurrentUser() actor: User | null) {
    return { data: await this.offtake.listMine(actor) };
  }

  @Get('offtake-contracts/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Contract detail (parties or admin)' })
  async getContract(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.getContract(actor, id) };
  }

  @Post('offtake-contracts/:id/transition')
  @Authenticated()
  @ApiOperation({
    summary:
      'Transition a contract (draft→active→fulfilled/breached, any→terminated); audit-recorded. Parties or admin.'
  })
  async transitionContract(
    @Param('id') id: string,
    @Body() dto: TransitionContractDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.offtake.transition(actor, id, dto.to) };
  }

  // -- AfCFTA export documents -------------------------------------------------

  @Post('export-documents')
  @Authenticated()
  @ApiOperation({
    summary:
      'Generate a DRAFT export document payload (certificate of origin / sanitary certificate ref / consignment note) with version numbering. No authority submission.'
  })
  async generateDocument(@Body() dto: GenerateExportDocumentDto, @CurrentUser() actor: User | null) {
    return { data: await this.exportDocuments.generate(actor, dto) };
  }

  @Get('export-documents')
  @Authenticated()
  @ApiOperation({ summary: 'List export documents for a subject (owner or admin)' })
  async listDocuments(@Query() query: ListExportDocumentsQuery, @CurrentUser() actor: User | null) {
    return { data: await this.exportDocuments.listForSubject(actor, query.subjectType, query.subjectId) };
  }

  @Get('export-documents/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Export document detail (creator or admin)' })
  async getDocument(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.exportDocuments.getById(actor, id) };
  }
}
