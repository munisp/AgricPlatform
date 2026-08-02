import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { PartnerAuthService } from './partner-auth.service.js';

class ClientCredentialsGrantDto {
  @IsIn(['client_credentials'])
  grant_type!: 'client_credentials';

  @IsString()
  client_id!: string;

  @IsString()
  client_secret!: string;
}

/**
 * OAuth2 client-credentials token endpoint for partner M2M integrations
 * (wave P5d). Issues short-lived JWTs with `partner` audience and scope
 * claims. Unauthenticated by design — the client secret IS the credential.
 */
@ApiTags('partner-api')
@Controller('partner/oauth')
export class PartnerOAuthController {
  constructor(private readonly auth: PartnerAuthService) {}

  @Post('token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Client-credentials grant (partner access token)' })
  async token(@Body() dto: ClientCredentialsGrantDto) {
    const issued = await this.auth.issueToken(dto.client_id, dto.client_secret).catch((error) => {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid client credentials');
    });
    return {
      access_token: issued.accessToken,
      token_type: issued.tokenType,
      expires_in: issued.expiresIn,
      scope: issued.scope,
      sandbox: issued.sandbox
    };
  }
}
