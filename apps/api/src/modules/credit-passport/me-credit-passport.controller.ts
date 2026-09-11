import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  CreditPassportService,
  DISCLOSURE_MAX_HOURS,
  DISCLOSURE_MIN_HOURS,
  type SharePassportInput
} from './credit-passport.service.js';

class SharePassportDto implements SharePassportInput {
  /** Partner organisation / client id to disclose the credential to. */
  @IsString()
  partnerId!: string;

  @IsOptional()
  @IsInt()
  @Min(DISCLOSURE_MIN_HOURS)
  @Max(DISCLOSURE_MAX_HOURS)
  expiresInHours?: number;
}

/**
 * Farmer-facing credit passport surface (Stage 27, Innovation 7). All routes
 * require an authenticated platform identity and are flag-gated behind
 * `credit-passport` (fail-closed 404 when off). Ownership rules are enforced
 * per record in the service; mutations are covered by the global
 * Idempotency-Key interceptor.
 */
@ApiTags('me-credit-passport')
@Controller('me/credit-passport')
@RequiresFeature('credit-passport')
@UseGuards(RolesGuard, FeatureFlagGuard)
export class MeCreditPassportController {
  constructor(private readonly passports: CreditPassportService) {}

  @Get()
  @Authenticated()
  @ApiOperation({
    summary:
      'The caller\'s credit passport. Auto-issues version 1 on first read; appends a new hash-chain version on material change.'
  })
  async getMine(@CurrentUser() actor: User | null) {
    return { data: await this.passports.getMine(actor) };
  }

  @Post('share')
  @Authenticated()
  @ApiOperation({
    summary:
      'Consent-scoped, expiring disclosure of the caller\'s passport to a named partner (NDPA consent recorded).'
  })
  async share(@Body() dto: SharePassportDto, @CurrentUser() actor: User | null) {
    return { data: await this.passports.share(actor, dto) };
  }

  @Get('disclosures')
  @Authenticated()
  @ApiOperation({ summary: 'Disclosures the caller has granted (most recent first).' })
  async listDisclosures(@CurrentUser() actor: User | null) {
    return { data: await this.passports.listMyDisclosures(actor) };
  }

  @Post('revoke')
  @Authenticated()
  @ApiOperation({
    summary: 'Revoke the caller\'s active credit passport (terminal; verification fails closed).'
  })
  async revoke(@CurrentUser() actor: User | null) {
    return { data: await this.passports.revoke(actor) };
  }
}
