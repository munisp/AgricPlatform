import {
  Controller,
  Get,
  Header,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ComplianceService } from './compliance.service.js';

class ComplianceExportQuery {
  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

@ApiTags('livestock-compliance')
@Controller('livestock-compliance')
@UseGuards(RolesGuard)
export class LivestockComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('export.csv')
  @Authenticated()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary:
      'Regulator compliance export (F6): sectioned CSV of animals + ownership transfers, with placeholder health/movement sections. Regulator or admin role; filter by state and ISO date range.'
  })
  async exportCsv(@Query() query: ComplianceExportQuery, @CurrentUser() actor: User | null) {
    return this.compliance.exportCsv(actor, {
      state: query.state,
      from: query.from,
      to: query.to
    });
  }
}
