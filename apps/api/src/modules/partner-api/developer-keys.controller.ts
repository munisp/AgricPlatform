import {
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
import { USER_ROLES, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PartnerAuthService } from './partner-auth.service.js';

class IssueApiKeyDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];
}

/**
 * Developer API keys (wave P5d, developer portal sandbox flow). Authenticated
 * platform users issue sandbox keys; plaintext is returned exactly once and
 * only the salted sha256 hash persists.
 */
@ApiTags('developer-keys')
@Controller('partner/developer-keys')
@UseGuards(RolesGuard)
@Roles(...USER_ROLES)
export class DeveloperKeysController {
  constructor(private readonly auth: PartnerAuthService) {}

  @Post()
  @ApiOperation({ summary: 'Issue an API key (plaintext shown once)' })
  async issue(@CurrentUser() user: User | null, @Body() dto: IssueApiKeyDto) {
    if (!user) throw new UnauthorizedException('Authenticated user required');
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
