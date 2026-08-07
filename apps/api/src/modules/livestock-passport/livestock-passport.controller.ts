import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { LivestockPassportService } from './livestock-passport.service.js';
import type { InitiateTransferInput } from './livestock-passport.service.js';

class InitiateTransferDto implements InitiateTransferInput {
  @IsString()
  toUserId!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class ListTransfersQuery {
  @IsOptional()
  @IsIn(['incoming', 'outgoing'])
  direction?: 'incoming' | 'outgoing';
}

/**
 * Digital livestock passport surface (wave-livestock-passport). All routes
 * require an authenticated platform identity EXCEPT GET /verify/:code, the
 * public QR verification route (HMAC-signed code, redacted view). Ownership
 * and role rules are enforced per record in the service (defence in depth:
 * the guard authenticates, the service authorises). Mutations are covered by
 * the global Idempotency-Key interceptor.
 */
@ApiTags('livestock-passport')
@Controller('livestock-passport')
@UseGuards(RolesGuard)
export class LivestockPassportController {
  constructor(private readonly passports: LivestockPassportService) {}

  /* Literal routes are declared before the `:id` parameter routes so the
     router never captures them as passport ids. */

  @Post('animals/:animalId')
  @Authenticated()
  @ApiOperation({
    summary: 'Issue the digital livestock passport for a registered animal (owner or admin).'
  })
  async issuePassport(@Param('animalId') animalId: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.issuePassport(actor, { animalId }) };
  }

  @Get('mine')
  @Authenticated()
  @ApiOperation({ summary: 'Composite passports for animals the caller currently owns.' })
  async listMine(@CurrentUser() actor: User | null) {
    return { data: await this.passports.listMine(actor) };
  }

  @Get('verify/:code')
  @ApiOperation({
    summary:
      'PUBLIC (unauthenticated) passport verification: HMAC-signed code → redacted view + QR payload. Forged codes answer 404.'
  })
  async verifyPublic(@Param('code') code: string) {
    return { data: await this.passports.verifyPublic(code) };
  }

  @Get('transfers')
  @Authenticated()
  @ApiOperation({
    summary: 'Ownership transfers where the caller is the buyer (incoming) or seller (outgoing).'
  })
  async listTransfers(@Query() query: ListTransfersQuery, @CurrentUser() actor: User | null) {
    return { data: await this.passports.listMyTransfers(actor, query.direction ?? 'incoming') };
  }

  @Post('transfers/:transferId/confirm')
  @Authenticated()
  @ApiOperation({
    summary: 'Buyer confirms a pending transfer — executes the ownership change (both-party audit).'
  })
  async confirmTransfer(@Param('transferId') transferId: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.confirmTransfer(actor, transferId) };
  }

  @Post('transfers/:transferId/cancel')
  @Authenticated()
  @ApiOperation({ summary: 'Seller (or admin) cancels a pending transfer.' })
  async cancelTransfer(@Param('transferId') transferId: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.cancelTransfer(actor, transferId) };
  }

  @Get('export/oversight')
  @Authenticated()
  @ApiOperation({ summary: 'Regulator/admin oversight export: every passport with aggregate flags.' })
  async oversightExport(@CurrentUser() actor: User | null) {
    return { data: await this.passports.oversightExport(actor) };
  }

  @Get('authority/status')
  @Authenticated()
  @ApiOperation({
    summary: 'External animal-ID authority port status (stub by default, honestly labelled).'
  })
  async authorityStatus(@CurrentUser() actor: User | null) {
    return { data: await this.passports.authorityStatus(actor) };
  }

  @Get(':id')
  @Authenticated()
  @ApiOperation({
    summary: 'Full composite passport document (owner, vet/regulator/admin, or pending-transfer buyer).'
  })
  async getPassport(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.getPassport(actor, id) };
  }

  @Get(':id/events')
  @Authenticated()
  @ApiOperation({ summary: 'Hash-chained passport event log with recomputed verification.' })
  async getEvents(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.getEvents(actor, id) };
  }

  @Post(':id/transfers')
  @Authenticated()
  @ApiOperation({
    summary: 'Seller initiates an ownership transfer (blocked while an active lien exists).'
  })
  async initiateTransfer(
    @Param('id') id: string,
    @Body() dto: InitiateTransferDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.passports.initiateTransfer(actor, id, dto) };
  }

  @Post(':id/suspend')
  @Authenticated()
  @ApiOperation({ summary: 'Regulator/admin fraud-hold suspension.' })
  async suspend(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.suspend(actor, id) };
  }

  @Post(':id/reinstate')
  @Authenticated()
  @ApiOperation({ summary: 'Regulator/admin reinstatement of a suspended passport.' })
  async reinstate(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.passports.reinstate(actor, id) };
  }
}
