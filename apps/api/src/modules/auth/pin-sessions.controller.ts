import { Body, Controller, Get, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length, Matches } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PinSessionService } from './pin-session.service.js';

class AddPinProfileDto {
  @IsString()
  @Length(8, 128)
  deviceToken!: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin!: string;
}

class SwitchPinProfileDto {
  @IsString()
  @Length(8, 128)
  deviceToken!: string;

  @IsString()
  userId!: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin!: string;
}

/**
 * Shared-device PIN sessions (wave P5b): profile setup is auth-guarded (the
 * signed-in user pins their own account onto the device); the swap endpoint
 * is unauthenticated but rate-limited and attempt-limited.
 */
@ApiTags('auth')
@Controller('auth')
export class PinSessionsController {
  constructor(private readonly pins: PinSessionService) {}

  @Post('pin-profiles')
  @UseGuards(RolesGuard)
  @Authenticated()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Pin the authenticated profile onto a shared device (max 5 per device)' })
  async addProfile(@CurrentUser() user: User | null, @Body() dto: AddPinProfileDto) {
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }
    return { data: await this.pins.addProfile(user.id, dto.deviceToken, dto.pin) };
  }

  @Get('pin-profiles/:deviceToken')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List the profiles pinned to a shared device (no hashes)' })
  async listProfiles(@Param('deviceToken') deviceToken: string) {
    return { data: await this.pins.listProfiles(deviceToken) };
  }

  @Post('pin-sessions/switch')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Swap to a pinned profile with its 4-digit PIN (5 attempts, then 15-minute lockout)'
  })
  async switchProfile(@Body() dto: SwitchPinProfileDto) {
    return { data: await this.pins.switchProfile(dto.deviceToken, dto.userId, dto.pin) };
  }
}
