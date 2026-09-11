import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EvidenceCaseType, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  EVIDENCE_CASE_TYPES,
  EvidenceService,
  type ConfirmItemInput,
  type InitiateUploadInput
} from './evidence.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

function parseCaseType(raw: string): EvidenceCaseType {
  if ((EVIDENCE_CASE_TYPES as readonly string[]).includes(raw)) {
    return raw as EvidenceCaseType;
  }
  throw new BadRequestException(
    `caseType must be one of: ${EVIDENCE_CASE_TYPES.join(', ')}`
  );
}

/**
 * Evidence Locker (Stage 27 Innovation 13): hash-chained dispute evidence
 * packs. Flag-gated behind `evidence-locker` (fail-closed 404 when off).
 *
 * Upload flow is presigned (the API never buffers evidence bytes):
 *   POST :caseType/:caseId/uploads  -> presigned PUT + server-issued key
 *   (client PUTs the blob to object storage)
 *   POST :caseType/:caseId/items    -> blob provenance verified, then the
 *                                      hash-chained row is appended
 * The spec's "multipart -> presigned upload -> hash record in one flow" is
 * delivered as this two-call presigned flow so the fail-closed rule "no
 * metadata-without-blob rows" holds without trusting client claims.
 *
 * Case types: escrow | vsla | insurance | pool (pool fails closed until the
 * pool-settlement registry lands). Uploads require case party membership;
 * chain reads allow parties + admin; seal/expunge are admin-only.
 */
@ApiTags('evidence')
@Controller('evidence')
@RequiresFeature('evidence-locker')
@UseGuards(RolesGuard, FeatureFlagGuard)
export class EvidenceController {
  constructor(private readonly service: EvidenceService) {}

  @Post(':caseType/:caseId/uploads')
  @Authenticated()
  @ApiOperation({
    summary:
      'Initiate an evidence upload (case parties only): returns a presigned PUT URL with ' +
      'the declared sha256 pinned as signed metadata. Stub storage answers 503 — no row exists yet.'
  })
  async initiateUpload(
    @Param('caseType') caseType: string,
    @Param('caseId') caseId: string,
    @Body() body: InitiateUploadInput,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.service.initiateUpload(
        requireActor(actor),
        parseCaseType(caseType),
        caseId,
        body
      )
    };
  }

  @Post(':caseType/:caseId/items')
  @Authenticated()
  @ApiOperation({
    summary:
      'Confirm an uploaded blob and append its hash-chained evidence row (case parties only). ' +
      'The blob must exist with the declared size and pinned sha256 — no metadata-without-blob rows.'
  })
  async confirmItem(
    @Param('caseType') caseType: string,
    @Param('caseId') caseId: string,
    @Body() body: ConfirmItemInput,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.service.confirmItem(
        requireActor(actor),
        parseCaseType(caseType),
        caseId,
        body
      )
    };
  }

  @Get('items/:itemId/download-url')
  @Authenticated()
  @ApiOperation({
    summary:
      'Presigned download URL for one evidence item (case parties + admin), gated on ' +
      'hash-chain integrity: a tampered item is flagged and never served (409); an expunged one is 410.'
  })
  async downloadUrl(@Param('itemId') itemId: string, @CurrentUser() actor: User | null) {
    return { data: await this.service.downloadUrl(requireActor(actor), itemId) };
  }

  @Get(':caseType/:caseId/chain')
  @Authenticated()
  @ApiOperation({
    summary:
      'Ordered evidence items for a case plus the chain continuity proof (recomputed on ' +
      'every read). Tampered items are flagged integrity=tampered, never served as valid.'
  })
  async getChain(
    @Param('caseType') caseType: string,
    @Param('caseId') caseId: string,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.service.getChain(requireActor(actor), parseCaseType(caseType), caseId)
    };
  }

  @Post(':caseType/:caseId/seal')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Seal a case (admin): freezes the chain head hash into the platform audit chain ' +
      '(migration-047 anchor pattern) and CAS-transitions items to sealed. Broken chains are refused.'
  })
  async sealCase(
    @Param('caseType') caseType: string,
    @Param('caseId') caseId: string,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.service.sealCase(requireActor(actor), parseCaseType(caseType), caseId)
    };
  }

  @Delete(':caseType/:caseId/items/:itemId')
  @Roles('admin')
  @ApiOperation({
    summary:
      'NDPA expunge (admin): deletes the object from storage, then keeps the row as a hash ' +
      'tombstone (status=expunged) so chain continuity is preserved. Blob-first; storage failure leaves status untouched.'
  })
  async expungeItem(
    @Param('caseType') caseType: string,
    @Param('caseId') caseId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.service.expungeItem(
        requireActor(actor),
        parseCaseType(caseType),
        caseId,
        itemId
      )
    };
  }
}
