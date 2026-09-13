import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { DEALER_QR_PAY_FLAG, DealerQrService, type ActorRef } from './dealer-qr.service.js';

class IssueQrDto {
  @IsString()
  @IsNotEmpty()
  label!: string;
}

class PayDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  /** Payer's wallet alias/MSISDN presented to the switch (never persisted plaintext). */
  @IsString()
  @IsNotEmpty()
  payerAlias!: string;

  /** Optional agent_banking offline voucher applied as co-pay tender. */
  @IsOptional()
  @IsString()
  voucherId?: string;

  /** Mandatory client idempotency key — retries replay the original payment. */
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}

class MojaloopWebhookDto {
  @IsString()
  @IsNotEmpty()
  transferId!: string;

  @IsOptional()
  @IsString()
  transferState?: string;

  @IsOptional()
  @IsString()
  fulfilment?: string;

  @IsOptional()
  @IsString()
  completedTimestamp?: string;
}

function actorOf(user: User | null): ActorRef {
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return { id: user.id, roles: user.roles };
}

/**
 * Dealer QR Pay surface (Stage 27, Innovation 16) — Mojaloop merchant
 * payments at agro-dealers with signed-voucher co-pay. The whole surface is
 * flag-gated behind `dealer-qr-pay` (fail-closed 404 when off). Money
 * movement posts through the finance ledger; the Mojaloop leg rides the
 * fail-closed MOJALOOP_ADAPTER port (stub default, 503 in production).
 */
@ApiTags('agent-banking')
@Controller('agent-banking')
@UseGuards(RolesGuard, FeatureFlagGuard)
@RequiresFeature(DEALER_QR_PAY_FLAG)
export class DealerQrController {
  constructor(private readonly dealerQr: DealerQrService) {}

  @Post('merchants/:id/qr')
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Issue a signed merchant QR code (dealer themself or admin)' })
  async issueQr(@Param('id') id: string, @Body() dto: IssueQrDto, @CurrentUser() actor: User | null) {
    return { data: await this.dealerQr.issueQrCode(id, dto, actorOf(actor)) };
  }

  @Get('merchants/:id/qr')
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'List QR codes issued by a merchant (dealer themself or admin)' })
  async listQr(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.dealerQr.listQrCodes(id, actorOf(actor)) };
  }

  @Post('qr/:code/pay')
  @Roles('farmer', 'agent', 'admin')
  @ApiOperation({
    summary:
      'Pay a merchant QR code: Mojaloop quote→transfer wallet tender plus optional signed-voucher ' +
      'co-pay (idempotency-keyed; completes only off a switch-confirmed transfer or full voucher tender)'
  })
  async pay(@Param('code') code: string, @Body() dto: PayDto, @CurrentUser() actor: User | null) {
    return { data: await this.dealerQr.pay(code, dto, actorOf(actor)) };
  }

  @Get('merchant-payments/:id')
  @Roles('farmer', 'agent', 'admin')
  @ApiOperation({ summary: 'Merchant payment status (payer, dealer or admin)' })
  async payment(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.dealerQr.getPayment(id, actorOf(actor)) };
  }

  @Post('merchant-payments/:id/confirm')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Confirmation poller entry point (admin/scheduler): queries the live driver transfer status ' +
      'and settles or fails the payment (replay-safe no-op once resolved)'
  })
  async confirm(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.dealerQr.confirmPayment(id, actorOf(actor).id) };
  }
}

/**
 * Mojaloop FSPIOP transfer callback (PUT /transfers/{id} fulfil/abort) for
 * Dealer QR Pay. Not a user-authenticated route: authenticity rides on the
 * MOJALOOP_WEBHOOK_TOKEN shared secret (x-mojaloop-webhook-token header)
 * plus the live driver's own ILP fulfilment verification. Fail-closed: the
 * route answers 404 unless the token is configured, and the service
 * additionally requires the live driver. Redelivered confirmations are
 * replay-safe no-ops (UNIQUE mojaloop_transfer_id + quoted→completed CAS).
 */
@ApiTags('agent-banking')
@Controller('agent-banking/qr-webhooks')
@UseGuards(FeatureFlagGuard)
@RequiresFeature(DEALER_QR_PAY_FLAG)
export class DealerQrWebhookController {
  constructor(private readonly dealerQr: DealerQrService) {}

  @Post('mojaloop')
  @ApiOperation({
    summary:
      'Mojaloop transfer fulfil/abort callback (switch → platform). Requires MOJALOOP_WEBHOOK_TOKEN; ' +
      'live-driver fulfilment verification; replay-safe.'
  })
  async mojaloopCallback(
    @Body() dto: MojaloopWebhookDto,
    @Headers('x-mojaloop-webhook-token') token?: string
  ) {
    const expected = process.env.MOJALOOP_WEBHOOK_TOKEN?.trim();
    if (!expected) {
      throw new NotFoundException(
        'Mojaloop QR webhook is disabled. Set MOJALOOP_WEBHOOK_TOKEN (and MOJALOOP_DRIVER=live) to enable it.'
      );
    }
    if (token !== expected) {
      throw new UnauthorizedException('Invalid Mojaloop webhook token');
    }
    return { data: await this.dealerQr.handleMojaloopWebhook(dto) };
  }
}
