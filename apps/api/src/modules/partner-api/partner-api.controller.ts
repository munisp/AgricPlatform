import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { PartnerApiService } from './partner-api.service.js';
import {
  PartnerAuthGuard,
  assertPartnerTenant,
  partnerIdentity,
  type PartnerRequestIdentity
} from './partner-auth.guard.js';
import { PartnerScopes } from './partner-scopes.decorator.js';
import { PARTNER_EVENT_TYPES } from './webhook-dispatch.service.js';
import { Public } from '../../common/auth/roles.decorator.js';

/**
 * Resolves the effective tenant for a write (Stage 24, audit A2-2): the
 * TOKEN's bound partnerId always wins. A caller-supplied partnerId that
 * disagrees is a 400 (likely client bug); an unbound credential is a 403
 * (fail closed — money events are never recorded under an arbitrary slug).
 */
function writeTenantFor(identity: PartnerRequestIdentity, supplied?: string): string {
  if (!identity.partnerId) {
    throw new ForbiddenException(
      'This credential is not bound to a partner organisation; partner writes require a bound client-credentials token'
    );
  }
  if (supplied && supplied !== identity.partnerId) {
    throw new BadRequestException(
      `partnerId mismatch: this client is bound to '${identity.partnerId}'; omit partnerId or send the bound value`
    );
  }
  return identity.partnerId;
}

class RecordDisbursementDto {
  /** Optional — the token's bound partnerId is authoritative (400 on mismatch). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  partnerId?: string;

  @IsString()
  @MaxLength(100)
  userId!: string;

  @IsNumber()
  @IsPositive()
  amountNgn!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  programmeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;
}

class RecordEnrolmentDto {
  /** Optional — the token's bound partnerId is authoritative (400 on mismatch). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  partnerId?: string;

  @IsString()
  @MaxLength(100)
  userId!: string;

  @IsString()
  @MaxLength(100)
  programmeId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cohortLabel?: string;
}

class FarmDataPushDto {
  @IsString()
  @MaxLength(100)
  userId!: string;

  /** farmOS-compatible asset/log payload (validated for shape only). */
  @IsOptional()
  assets?: unknown[];

  @IsOptional()
  logs?: unknown[];
}

class CreateWebhookSubscriptionDto {
  @IsArray()
  @IsIn(PARTNER_EVENT_TYPES, { each: true })
  eventTypes!: string[];

  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  targetUrl!: string;

  @IsString()
  @MaxLength(100)
  @MinLength(16)
  secret!: string;
}

/** GAP-M23 rotation request; empty body takes the default 24h grace. */
class RotateWebhookSecretDto {
  /** Dual-accept grace in hours (default 24, max 168 = 7d). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  graceHours?: number;
}

/**
 * Scoped partner API surface (wave P5d). All routes require a partner
 * access token (client-credentials grant) or developer API key, enforce
 * per-route scopes and the per-client rate bucket.
 */
@ApiTags('partner-api')
// @Public: platform bearer not required — PartnerAuthGuard authenticates every route (HMAC partner token).
@Public()
@Controller('partner')
@UseGuards(PartnerAuthGuard)
export class PartnerApiController {
  constructor(private readonly partnerApi: PartnerApiService) {}

  @Get('participation/:partnerId')
  @PartnerScopes('programmes:read')
  @ApiOperation({ summary: 'Programme participation (consented members only)' })
  async participation(@Param('partnerId') partnerId: string, @Req() request: Request) {
    assertPartnerTenant(partnerIdentity(request), partnerId);
    return { data: await this.partnerApi.consentedParticipation(partnerId) };
  }

  @Get('impact/:partnerId')
  @PartnerScopes('impact:read')
  @ApiOperation({ summary: 'Aggregate impact metrics (counts only, no PII)' })
  async impact(@Param('partnerId') partnerId: string, @Req() request: Request) {
    assertPartnerTenant(partnerIdentity(request), partnerId);
    return { data: await this.partnerApi.impactAggregate(partnerId) };
  }

  @Get('applications/count/:partnerId')
  @PartnerScopes('applications:read')
  @ApiOperation({ summary: 'Application count for a partner (aggregate)' })
  async applicationCount(@Param('partnerId') partnerId: string, @Req() request: Request) {
    assertPartnerTenant(partnerIdentity(request), partnerId);
    return { data: await this.partnerApi.applicationCount(partnerId) };
  }

  /**
   * Consented member profile lookup (Stage 27, WP-G4 — V3 middleware audit).
   * The requested member must be bound to the caller's bound partner
   * organisation (at least one application to one of its programmes);
   * unbound ids return 404, identical to an unknown user, so membership
   * cannot be enumerated. Unbound credentials fail closed (403), matching
   * assertPartnerTenant.
   */
  @Get('members/:userId/profile')
  @PartnerScopes('profile:read')
  @ApiOperation({ summary: 'Consented member profile lookup (bound members only)' })
  async memberProfile(@Param('userId') userId: string, @Req() request: Request) {
    const identity = partnerIdentity(request);
    if (!identity.partnerId) {
      throw new ForbiddenException(
        'This credential is not bound to a partner organisation; member profile reads require a bound client-credentials token'
      );
    }
    return {
      data: await this.partnerApi.consentedMemberProfile(
        userId,
        identity.partnerId,
        identity.clientId
      )
    };
  }

  @Post('disbursements')
  @PartnerScopes('disbursements:write')
  @ApiOperation({ summary: 'Record a disbursement event (webhook fanned out)' })
  async recordDisbursement(@Body() dto: RecordDisbursementDto, @Req() request: Request) {
    const identity = partnerIdentity(request);
    const partnerId = writeTenantFor(identity, dto.partnerId);
    return {
      data: await this.partnerApi.recordDisbursement(partnerId, dto, identity.clientId)
    };
  }

  @Post('enrolments')
  @PartnerScopes('enrolments:write')
  @ApiOperation({ summary: 'Record a partner programme enrolment' })
  async recordEnrolment(@Body() dto: RecordEnrolmentDto, @Req() request: Request) {
    const identity = partnerIdentity(request);
    const partnerId = writeTenantFor(identity, dto.partnerId);
    return {
      data: await this.partnerApi.recordEnrolment(partnerId, dto, identity.clientId)
    };
  }

  /**
   * farmOS-compatible farm data push (Stage 27, WP-G22): the credential
   * must be bound to a partner organisation (403 otherwise, fail closed —
   * same convention as writeTenantFor) and the subject farmer must be in
   * the partner's scope (service-enforced, 404 when unbound).
   */
  @Post('farm-data')
  @HttpCode(202)
  @PartnerScopes('farm_data:write')
  @ApiOperation({ summary: 'farmOS-compatible farm data push (bound members only)' })
  async farmDataPush(@Body() dto: FarmDataPushDto, @Req() request: Request) {
    const identity = partnerIdentity(request);
    const partnerId = writeTenantFor(identity);
    return {
      data: await this.partnerApi.recordFarmDataPush(
        partnerId,
        dto.userId,
        dto as unknown as Record<string, unknown>,
        identity.clientId
      )
    };
  }

  @Post('webhooks')
  @PartnerScopes('webhooks:manage')
  @ApiOperation({ summary: 'Create a webhook subscription (HMAC-signed deliveries)' })
  async createWebhook(@Body() dto: CreateWebhookSubscriptionDto, @Req() request: Request) {
    const identity = partnerIdentity(request);
    if (identity.ownerUserId) {
      // webhook_subscriptions.client_id references partner_clients; M2M only.
      throw new BadRequestException(
        'Webhook subscriptions require a client-credentials access token'
      );
    }
    // The token's bound partnerId scopes the subscription (Stage 27 WP-G3);
    // unbound credentials create platform-level subscriptions.
    const subscription = await this.partnerApi.createWebhookSubscription(
      identity.clientId,
      dto,
      identity.partnerId
    );
    // Secret is returned once at creation for verification testing.
    return { data: subscription };
  }

  @Get('webhooks')
  @PartnerScopes('webhooks:manage')
  @ApiOperation({ summary: 'List the client webhook subscriptions (secrets omitted)' })
  async listWebhooks(@Req() request: Request) {
    const identity = partnerIdentity(request);
    return { data: await this.partnerApi.webhookSubscriptionsFor(identity.clientId) };
  }

  @Delete('webhooks/:id')
  @PartnerScopes('webhooks:manage')
  @ApiOperation({ summary: 'Delete a webhook subscription' })
  async deleteWebhook(@Param('id') id: string, @Req() request: Request) {
    const identity = partnerIdentity(request);
    const removed = await this.partnerApi.removeWebhookSubscription(id, identity.clientId);
    return { data: { removed } };
  }

  /**
   * GAP-M23 — documented rotation endpoint (docs/security/key-rotation.md).
   * Server-generates a fresh HMAC secret; the outgoing secret stays accepted
   * as a SECOND signature (x-agric-signature-previous) for the grace window
   * (default 24h, ≤7d) so partners cut over without dropped deliveries.
   * Audited (partner.webhook.secret_rotated); secrets are never logged and
   * the new secret is returned exactly once.
   */
  @Post('webhooks/:id/rotate-secret')
  @PartnerScopes('webhooks:manage')
  @ApiOperation({
    summary:
      'Rotate a webhook subscription secret (dual-signature grace: default 24h, max 7d; new secret returned once)'
  })
  async rotateWebhookSecret(
    @Param('id') id: string,
    @Body() dto: RotateWebhookSecretDto,
    @Req() request: Request
  ) {
    const identity = partnerIdentity(request);
    const rotation = await this.partnerApi.rotateWebhookSecret(
      id,
      identity.clientId,
      dto?.graceHours
    );
    return { data: rotation };
  }
}
