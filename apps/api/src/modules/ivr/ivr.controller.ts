import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Ip,
  NotFoundException,
  Post,
  Query
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString } from 'class-validator';
import { assertAtCallbackIp, assertAtCallbackToken } from '../../common/auth/at-callback.utils.js';
import { IvrService } from './ivr.service.js';

/** Africa's Talking Voice form-encoded callback payload (application/x-www-form-urlencoded). */
class IvrCallbackDto {
  @IsString()
  sessionId!: string;

  @IsString()
  callerNumber!: string;

  /** Latest DTMF input; absent on the opening ring or a GetDigits timeout. */
  @IsOptional()
  @IsString()
  dtmfDigits?: string;

  /** '1' while the call is live, '0' on the final hangup notification. */
  @IsOptional()
  @IsString()
  isActive?: string;
}

/**
 * IVR voice channel endpoint (wave P6a). Africa's Talking POSTs form-encoded
 * call turns here; responses are Voice XML documents
 * (`<Response><Say>`, `<GetDigits>`, `<Enqueue/>`, `<Reject/>`).
 * The endpoint is fail-closed: it stays 404 unless IVR_DRIVER is
 * live|sandbox AND the AT credentials are configured (ivr.service.ts).
 * AT does not sign callbacks, so authenticity rides on the shared
 * AT_CALLBACK_TOKEN secret (query param on the configured callback URL or
 * x-at-callback-token header, audit C2-3) plus the optional
 * AT_CALLBACK_IP_ALLOWLIST.
 */
@ApiTags('ivr')
@Controller('ivr')
export class IvrController {
  constructor(private readonly ivr: IvrService) {}

  @Post('callback')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Africa's Talking Voice callback. Responds Voice XML actions. " +
      'Disabled unless IVR_DRIVER=live|sandbox with AT_API_KEY/AT_USERNAME. ' +
      'Requires the AT_CALLBACK_TOKEN secret (?token= or x-at-callback-token) once configured.'
  })
  async callback(
    @Body() dto: IvrCallbackDto,
    @Query('token') token?: string,
    @Headers('x-at-callback-token') headerToken?: string,
    @Ip() ip?: string
  ): Promise<string> {
    if (!this.ivr.driverConfig.enabled) {
      throw new NotFoundException(
        'IVR callback is disabled. Set IVR_DRIVER=live|sandbox with AT_API_KEY and AT_USERNAME.'
      );
    }
    assertAtCallbackToken(token ?? headerToken);
    assertAtCallbackIp(ip);
    return this.ivr.handleCallback({
      sessionId: dto.sessionId,
      callerNumber: dto.callerNumber,
      dtmfDigits: dto.dtmfDigits,
      isActive: dto.isActive
    });
  }
}
