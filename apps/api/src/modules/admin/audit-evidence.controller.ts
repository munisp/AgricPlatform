import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AuditEvidenceService } from './audit-evidence.service.js';

/**
 * Audit evidence export for regulators/auditors (Wave COMP). Extends the
 * existing audit surface (admin audit log + hash-chain verify) with a
 * self-contained, re-hashable evidence pack. Admin-only.
 */
@ApiTags('audit')
@Controller('audit')
@UseGuards(RolesGuard)
@Roles('admin')
export class AuditEvidenceController {
  constructor(private readonly evidence: AuditEvidenceService) {}

  @Get('evidence')
  @ApiOperation({
    summary:
      'Signed audit evidence pack: ISO-8601 createdAt-bounded event slice + hash-chain ' +
      'verification verdict + sha256 of the canonical payload (for regulators/auditors).'
  })
  async pack(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.evidence.evidencePack(from, to) };
  }
}
