import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PrivacyService } from './privacy.service.js';

class ConsentDto {
  @IsString()
  userId!: string;

  @IsString()
  purpose!: string;

  @IsBoolean()
  granted!: boolean;

  @IsString()
  source!: string;
}

/**
 * NDPR/NDPA data-subject endpoints. Every per-user record requires the
 * owning user or an admin (ownership enforced per route); the processing
 * register is admin-only.
 */
@ApiTags('privacy')
@Controller('privacy')
@UseGuards(RolesGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('consents')
  @Authenticated()
  @ApiOperation({ summary: 'Record a consent decision (NDPR)' })
  grantConsent(@Body() dto: ConsentDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: this.privacy.grantConsent(dto) };
  }

  @Delete('consents/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Revoke a consent record (audited)' })
  revokeConsent(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const consent = this.privacy.getConsent(id);
    const owner = assertSelfOrAdmin(actor, consent.userId);
    return { data: this.privacy.revokeConsent(id, owner.id) };
  }

  @Get('consents/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Consent records for a user' })
  consents(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: this.privacy.consentsFor(userId) };
  }

  @Get('export/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Full data-subject export (NDPR right of access)' })
  export(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    const owner = assertSelfOrAdmin(actor, userId);
    return { data: this.privacy.exportUser(userId, owner.id) };
  }

  @Post('delete/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Request account deletion (NDPR right to erasure)' })
  requestDeletion(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    const owner = assertSelfOrAdmin(actor, userId);
    return { data: this.privacy.requestDeletion(userId, owner.id) };
  }

  @Post('delete/requests/:id/confirm')
  @Authenticated()
  @ApiOperation({ summary: 'Confirm a deletion request; anonymises the user record' })
  confirmDeletion(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const request = this.privacy.deletionRequest(id);
    const owner = assertSelfOrAdmin(actor, request.userId);
    return { data: this.privacy.confirmDeletion(id, owner.id) };
  }

  @Get('delete/requests/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Deletion request status' })
  deletionRequest(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const request = this.privacy.deletionRequest(id);
    assertSelfOrAdmin(actor, request.userId);
    return { data: request };
  }

  @Get('register')
  @Roles('admin')
  @ApiOperation({ summary: 'NDPR/NDPA processing register (admin only)' })
  register() {
    return { data: this.privacy.processingRegister() };
  }
}
