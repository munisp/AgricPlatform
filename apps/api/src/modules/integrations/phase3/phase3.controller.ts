import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../../common/auth/roles.guard.js';
import { BeneficiaryImportService, type BeneficiaryRowInput } from './beneficiary-import.service.js';
import { ExternalAccountsService } from './external-accounts.service.js';
import { FarmRecordsService } from './farm-records.service.js';
import { LenderIntegrationService } from './lender-integration.service.js';
import { OfnSyndicationService } from './ofn-syndication.service.js';
import { ExtensionAdvisoryService } from './extension-advisory.service.js';
import { ExchangeFeedIngestionService } from './exchange-feed-ingestion.service.js';
import { assertWebhookToken } from './phase3.utils.js';

class LinkAccountDto {
  @IsIn(['farmos', 'litefarm'])
  system!: 'farmos' | 'litefarm';

  @IsString()
  externalId!: string;

  /** ISO-8601 timestamp of the farmer's explicit sharing consent. */
  @IsString()
  consentAt!: string;
}

class VerifyPushDto {
  @IsBoolean()
  verified!: boolean;
}

class CreateBatchDto {
  @IsString()
  sourceSystem!: string;

  @IsString()
  donorSource!: string;

  @IsArray()
  records!: BeneficiaryRowInput[];
}

class PullImportDto {
  @IsString()
  donorSource!: string;
}

class TriggerSyncDto {
  @IsOptional()
  @IsString()
  userId?: string;
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Phase-3 federated integration endpoints (wave P5a). Member routes are
 * ownership-scoped; imports/syndication/pulls are admin-only; webhooks are
 * shared-secret gated (fail closed in production). Routes sit under
 * /integrations/federation so they never collide with the wave-P1
 * /integrations/:provider provider-status routes.
 */
@ApiTags('integrations-federation')
@Controller('integrations/federation')
@UseGuards(RolesGuard)
export class Phase3Controller {
  constructor(
    private readonly accounts: ExternalAccountsService,
    private readonly farmRecords: FarmRecordsService,
    private readonly ofn: OfnSyndicationService,
    private readonly imports: BeneficiaryImportService,
    private readonly lender: LenderIntegrationService,
    private readonly extension: ExtensionAdvisoryService,
    private readonly exchangeFeeds: ExchangeFeedIngestionService
  ) {}

  // ------------------------------------------------------------------
  // External account linking (farmOS / LiteFarm)
  // ------------------------------------------------------------------

  @Post('links')
  @Authenticated()
  @ApiOperation({ summary: 'Link a farmOS/LiteFarm account (consent-gated)' })
  async link(@Body() dto: LinkAccountDto, @CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.accounts.link(user.id, dto) };
  }

  @Get('links')
  @Authenticated()
  @ApiOperation({ summary: 'List the caller\'s external account links' })
  async links(@CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.accounts.listFor(user.id) };
  }

  @Delete('links/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Unlink (soft-revoke) an external account' })
  async unlink(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.accounts.unlink(user.id, id) };
  }

  // ------------------------------------------------------------------
  // Farm records
  // ------------------------------------------------------------------

  @Get('farm-records')
  @Authenticated()
  @ApiOperation({ summary: 'Normalised farm records for the caller\'s links' })
  async myFarmRecords(@CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.farmRecords.recordsFor(user.id) };
  }

  @Post('farm-records/sync')
  @Authenticated()
  @ApiOperation({ summary: 'Trigger a farm-record sync (own links; admins may pass userId)' })
  async sync(@Body() dto: TriggerSyncDto, @CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    if (dto.userId) {
      assertSelfOrAdmin(user, dto.userId);
    }
    return { data: await this.farmRecords.syncAll(dto.userId ?? user.id) };
  }

  @Post('farm-records/:linkId/verification')
  @Roles('admin')
  @ApiOperation({ summary: 'Push member verification status to the linked system (admin)' })
  async pushVerification(@Param('linkId') linkId: string, @Body() dto: VerifyPushDto) {
    await this.farmRecords.pushVerification(linkId, dto.verified);
    return { data: { pushed: true } };
  }

  // ------------------------------------------------------------------
  // Webhook receivers (shared-secret gated; fail closed in production)
  // ------------------------------------------------------------------

  @Post('webhooks/farmos')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'farmOS record push receiver' })
  async farmosWebhook(@Body() payload: Record<string, unknown>, @Headers() headers: Record<string, string | undefined>) {
    assertWebhookToken('farmos', headers['x-integration-token']);
    return { data: await this.farmRecords.handleWebhook('farmos', payload, headers['x-event-id']) };
  }

  @Post('webhooks/litefarm')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'LiteFarm record push receiver' })
  async litefarmWebhook(@Body() payload: Record<string, unknown>, @Headers() headers: Record<string, string | undefined>) {
    assertWebhookToken('litefarm', headers['x-integration-token']);
    return { data: await this.farmRecords.handleWebhook('litefarm', payload, headers['x-event-id']) };
  }

  @Post('webhooks/ofn')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'OFN order event receiver (mapped to marketplace domain events)' })
  async ofnWebhook(@Body() payload: Record<string, unknown>, @Headers() headers: Record<string, string | undefined>) {
    assertWebhookToken('ofn', headers['x-integration-token']);
    return { data: await this.ofn.handleOrderEvent(payload, headers['x-event-id']) };
  }

  @Post('webhooks/lender')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Lender loan status/repayment event receiver' })
  async lenderWebhook(@Body() payload: Record<string, unknown>, @Headers() headers: Record<string, string | undefined>) {
    assertWebhookToken('lender', headers['x-integration-token']);
    return { data: await this.lender.handleLoanEvent(payload, headers['x-event-id']) };
  }

  // ------------------------------------------------------------------
  // OFN syndication (admin)
  // ------------------------------------------------------------------

  @Post('ofn/syndicate')
  @Roles('admin')
  @ApiOperation({ summary: 'Push active NYFN marketplace listings to OFN (admin)' })
  async syndicate() {
    return { data: await this.ofn.syndicateActiveListings() };
  }

  // ------------------------------------------------------------------
  // Beneficiary import (admin confirm-before-merge)
  // ------------------------------------------------------------------

  @Post('import/batches')
  @Roles('admin')
  @ApiOperation({ summary: 'Stage an ODK/Kobo beneficiary import batch (admin)' })
  async createBatch(@Body() dto: CreateBatchDto, @CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.imports.createBatch(dto, user.id) };
  }

  @Post('import/pull')
  @Roles('admin')
  @ApiOperation({ summary: 'Pull beneficiary submissions from configured field-data sources (admin)' })
  async pullImport(@Body() dto: PullImportDto, @CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: { batchIds: await this.imports.pullFromSources(dto.donorSource, user.id) } };
  }

  @Get('import/batches/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Import batch detail with staged records (admin)' })
  async batchDetail(@Param('id') id: string) {
    return {
      data: {
        batch: await this.imports.getBatch(id),
        records: await this.imports.recordsFor(id)
      }
    };
  }

  @Post('import/batches/:id/confirm')
  @Roles('admin')
  @ApiOperation({ summary: 'Confirm and merge a staged import batch (admin)' })
  async confirmBatch(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.imports.confirmBatch(id, user.id) };
  }

  // ------------------------------------------------------------------
  // Input finance
  // ------------------------------------------------------------------

  @Post('lender/credit-readiness')
  @Authenticated()
  @ApiOperation({ summary: 'Push own anonymised credit-readiness snapshot to the lender (consent-gated)' })
  async creditReadiness(@CurrentUser() actor: User | null) {
    const user = requireUser(actor);
    return { data: await this.lender.pushCreditReadiness(user.id) };
  }

  // ------------------------------------------------------------------
  // Scheduled-pull manual triggers (admin)
  // ------------------------------------------------------------------

  @Post('extension/pull')
  @Roles('admin')
  @ApiOperation({ summary: 'Trigger a NAERLS/FMARD advisory pull now (admin)' })
  async extensionPull() {
    return { data: { inserted: await this.extension.ingestOnce() } };
  }

  @Post('exchange-feeds/pull')
  @Roles('admin')
  @ApiOperation({ summary: 'Trigger an NCX/AFEX price ingestion pass now (admin)' })
  async exchangePull() {
    return { data: { inserted: await this.exchangeFeeds.ingestOnce() } };
  }
}
