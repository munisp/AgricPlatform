import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ArrayNotEmpty, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { LANGUAGE_CODES, USER_ROLES, type LanguageCode, type UserRole } from '@agric-platform/shared';
import { devHeaderAuthAllowed } from '../../common/auth/auth.config.js';
import { OidcService } from '../../common/auth/oidc.service.js';
import { AuthService } from './auth.service.js';

class RequestOtpDto {
  @IsString()
  phone!: string;
}

class VerifyOtpDto {
  @IsString()
  requestId!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

class RegisterDto {
  @IsString()
  phone!: string;

  @IsString()
  fullName!: string;

  @IsOptional()
  @IsString()
  email?: string;

  @ArrayNotEmpty()
  @IsIn(USER_ROLES, { each: true })
  roles!: UserRole[];

  @IsIn(LANGUAGE_CODES)
  preferredLanguage!: LanguageCode;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly oidc: OidcService
  ) {}

  @Post('otp/request')
  // Stricter limits on credential endpoints (docs/security-compliance.md §7).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a phone OTP challenge (stub driver returns devCode outside production)' })
  async requestOtp(@Body() dto: RequestOtpDto) {
    return { data: await this.auth.requestOtp(dto.phone) };
  }

  @Post('otp/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify an OTP challenge and receive a session token' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return { data: await this.auth.verifyOtp(dto.requestId, dto.code) };
  }

  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new member account' })
  async register(@Body() dto: RegisterDto) {
    return { data: await this.auth.register(dto) };
  }

  @Get('session')
  @ApiOperation({
    summary:
      'Resolve the current session. Bearer token (OIDC) is preferred; the x-user-id header works ' +
      'only outside production or with ALLOW_DEV_HEADER_AUTH=true.'
  })
  async session(
    @Headers('x-user-id') userId?: string,
    @Headers('authorization') authorization?: string
  ) {
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
    if (bearer) {
      try {
        const identity = await this.oidc.verify(bearer);
        return { data: await this.auth.session(identity.subject) };
      } catch (error) {
        throw new UnauthorizedException(
          `Invalid bearer token: ${error instanceof Error ? error.message : 'verification failed'}`
        );
      }
    }
    if (!devHeaderAuthAllowed()) {
      throw new UnauthorizedException('Authorization: Bearer token required');
    }
    if (!userId) {
      throw new UnauthorizedException('x-user-id header required (OIDC bearer token in production)');
    }
    return { data: await this.auth.session(userId) };
  }
}
