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
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PARTNER_API_SCOPES } from './partner-scopes.decorator.js';
import { PartnerAuthService } from './partner-auth.service.js';

class IssueApiKeyDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];
}

/**
 * Developer API keys (wave P5d, developer portal sandbox flow). Plaintext is
 * returned exactly once and only the salted sha256 hash persists.
 *
 * OB-08 hardening: only `admin` and `partner` roles may issue keys (a
 * self-service key for a plain member role would mint partner-API
 * capability from nothing), and requested scopes are whitelisted against
 * PARTNER_API_SCOPES — the scopes actually consumed by @PartnerScopes
 * routes — so a self-declared unknown scope is a 400, not a persisted
 * dead/over-broad grant.
 */
@ApiTags('developer-keys')
@Controller('partner/developer-keys')
@UseGuards(RolesGuard)
@Roles('admin', 'partner')
export class DeveloperKeysController {
  constructor(private readonly auth: PartnerAuthService) {}

  @Post()
  @ApiOperation({ summary: 'Issue an API key (plaintext shown once)' })
  async issue(@CurrentUser() user: User | null, @Body() dto: IssueApiKeyDto) {
    if (!user) throw new UnauthorizedException('Authenticated user required');
    const unknown = dto.scopes.filter(
      (scope) => !(PARTNER_API_SCOPES as readonly string[]).includes(scope)
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown partner API scope(s): ${unknown.join(', ')}. Issuable scopes: ${PARTNER_API_SCOPES.join(', ')}`
      );
    }
    const { apiKey, plaintext } = await this.auth.issueApiKey({
      ownerUserId: user.id,
      scopes: dto.scopes
    });
    return {
      data: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        scopes: apiKey.scopes,
        sandbox: apiKey.sandbox,
        createdAt: apiKey.createdAt,
        // Shown once; never persisted or returned again.
        key: plaintext
      }
    };
  }

  @Get()
  @ApiOperation({ summary: 'List own API keys (hashes never exposed)' })
  async list(@CurrentUser() user: User | null) {
    if (!user) throw new UnauthorizedException('Authenticated user required');
    const keys = await this.auth.apiKeysFor(user.id);
    return {
      data: keys.map((key) => ({
        id: key.id,
        prefix: key.prefix,
        scopes: key.scopes,
        sandbox: key.sandbox,
        revokedAt: key.revokedAt,
        createdAt: key.createdAt
      }))
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke an own API key' })
  async revoke(@CurrentUser() user: User | null, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException('Authenticated user required');
    const revoked = await this.auth.revokeApiKey(id, user.id);
    return { data: { id: revoked.id, revokedAt: revoked.revokedAt } };
  }
}
