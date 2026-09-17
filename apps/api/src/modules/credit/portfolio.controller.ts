import {
  Controller,
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
  @ApiOperation({
    summary:
      'Deterministic score preview (own, admin, or a lender with an active application linkage to the user)'
  })
  async scorePreview(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    // V-61: lender reads are bound to an application linkage, not the role alone.
    await this.credit.assertScoreReadAccess(user, userId);
    return { data: await this.credit.assessApplicant(userId) };
  }
}
