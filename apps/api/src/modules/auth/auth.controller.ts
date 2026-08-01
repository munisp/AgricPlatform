import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { LANGUAGE_CODES, USER_ROLES, type LanguageCode, type UserRole } from '@agric-platform/shared';
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
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @ApiOperation({ summary: 'Request a phone OTP challenge (stub driver returns devCode)' })
  requestOtp(@Body() dto: RequestOtpDto) {
    return { data: this.auth.requestOtp(dto.phone) };
  }

  @Post('otp/verify')
  @ApiOperation({ summary: 'Verify an OTP challenge and receive a session token' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return { data: this.auth.verifyOtp(dto.requestId, dto.code) };
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new member account' })
  register(@Body() dto: RegisterDto) {
    return { data: this.auth.register(dto) };
  }

  @Get('session')
  @ApiOperation({ summary: 'Resolve the current session from the x-user-id header' })
  session(@Headers('x-user-id') userId?: string) {
    if (!userId) {
      throw new UnauthorizedException('x-user-id header required (OIDC bearer token in production)');
    }
    return { data: this.auth.session(userId) };
  }
}
