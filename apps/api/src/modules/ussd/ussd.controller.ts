import {
  Body,
  Controller,
  Header,
  HttpCode,
  NotFoundException,
  Post
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString } from 'class-validator';
import { UssdService } from './ussd.service.js';

/** Africa's Talking form-encoded callback payload (application/x-www-form-urlencoded). */
class UssdCallbackDto {
  @IsString()
  sessionId!: string;

  @IsString()
  phoneNumber!: string;

  /** Cumulative `*` separated inputs; empty on the opening dial. */
  @IsOptional()
  @IsString()
  text?: string;
}

/**
 * USSD channel endpoint (wave P5b). Africa's Talking POSTs form-encoded
 * session turns here; responses are plain text with the CON/END prefix.
 * The endpoint is fail-closed: it stays 404 unless USSD_DRIVER is
 * live|sandbox AND the AT credentials are configured (ussd.service.ts).
 */
@ApiTags('ussd')
@Controller('ussd')
export class UssdController {
  constructor(private readonly ussd: UssdService) {}

  @Post('callback')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Africa's Talking USSD callback. Responds 'CON '/'END ' plain text (≤182 chars). " +
      'Disabled unless USSD_DRIVER=live|sandbox with AT_API_KEY/AT_USERNAME.'
  })
  async callback(@Body() dto: UssdCallbackDto): Promise<string> {
    if (!this.ussd.driverConfig.enabled) {
      throw new NotFoundException(
        'USSD callback is disabled. Set USSD_DRIVER=live|sandbox with AT_API_KEY and AT_USERNAME.'
      );
    }
    return this.ussd.handleCallback({
      sessionId: dto.sessionId,
      phoneNumber: dto.phoneNumber,
      text: dto.text ?? ''
    });
  }
}
