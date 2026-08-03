import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { CreditService } from './credit.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/** Credit portfolio reporting (PAR30/60/90, outstanding, defaults). */
@ApiTags('credit')
@Controller('credit')
export class CreditPortfolioController {
  constructor(private readonly credit: CreditService) {}

  @Get('portfolio')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Portfolio-at-risk report (admin|lender)' })
  async portfolio(@CurrentUser() actor: User | null) {
    return { data: await this.credit.portfolio(requireActor(actor)) };
  }

  @Get('score/:userId')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Deterministic score preview (own, or admin|lender)' })
  async scorePreview(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    if (
      user.id !== userId &&
      !user.roles.includes('admin') &&
      !user.roles.includes('lender')
    ) {
      throw new ForbiddenException('You may only preview your own score');
    }
    return { data: await this.credit.assessApplicant(userId) };
  }
}
