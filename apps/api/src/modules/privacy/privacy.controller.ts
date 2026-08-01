import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString } from 'class-validator';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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

@ApiTags('privacy')
@Controller('privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('consents')
  @ApiOperation({ summary: 'Record a consent decision (NDPR)' })
  grantConsent(@Body() dto: ConsentDto) {
    return { data: this.privacy.grantConsent(dto) };
  }

  @Delete('consents/:id')
  @ApiOperation({ summary: 'Revoke a consent record (audited)' })
  revokeConsent(@Param('id') id: string, @ActorId() actorId: string) {
    return { data: this.privacy.revokeConsent(id, actorId) };
  }

  @Get('consents/:userId')
  @ApiOperation({ summary: 'Consent records for a user' })
  consents(@Param('userId') userId: string) {
    return { data: this.privacy.consentsFor(userId) };
  }

  @Get('export/:userId')
  @ApiOperation({ summary: 'Full data-subject export (NDPR right of access)' })
  export(@Param('userId') userId: string, @ActorId() actorId: string) {
    return { data: this.privacy.exportUser(userId, actorId) };
  }

  @Post('delete/:userId')
  @ApiOperation({ summary: 'Request account deletion (NDPR right to erasure)' })
  requestDeletion(@Param('userId') userId: string, @ActorId() actorId: string) {
    return { data: this.privacy.requestDeletion(userId, actorId) };
  }

  @Post('delete/requests/:id/confirm')
  @ApiOperation({ summary: 'Confirm a deletion request; anonymises the user record' })
  confirmDeletion(@Param('id') id: string, @ActorId() actorId: string) {
    return { data: this.privacy.confirmDeletion(id, actorId) };
  }

  @Get('delete/requests/:id')
  @ApiOperation({ summary: 'Deletion request status' })
  deletionRequest(@Param('id') id: string) {
    return { data: this.privacy.deletionRequest(id) };
  }

  @Get('register')
  @ApiOperation({ summary: 'NDPR/NDPA processing register' })
  register() {
    return { data: this.privacy.processingRegister() };
  }
}
