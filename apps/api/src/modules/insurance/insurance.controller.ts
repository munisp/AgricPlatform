import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { InsuranceService, type QuoteInput } from './insurance.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Parametric insurance rail (wave-insurance). Farmer-facing catalog, quote,
 * policy and payout views plus the admin/cron-style trigger evaluation.
 * Payout execution is STUB only — real disbursement is externally gated.
 */
@ApiTags('insurance')
@Controller('insurance')
export class InsuranceController {
  constructor(private readonly insurance: InsuranceService) {}

  @Get('products')
  @ApiOperation({ summary: 'Parametric product catalog (seeded, deterministic).' })
  async products() {
    return { data: await this.insurance.listProducts() };
  }

  @Post('quotes')
  @ApiOperation({
    summary: 'Quote + persist a QUOTED policy (deterministic rate card; fail-closed pricing inputs).'
  })
  async quote(@Body() body: QuoteInput, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.quote(requireActor(actor), body) };
  }

  @Post('policies/:id/issue')
  @ApiOperation({ summary: 'Issue a quoted policy (QUOTED → ACTIVE, owner only; 409 on illegal transition).' })
  async issue(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.issue(requireActor(actor), id) };
  }

  @Post('policies/:id/expire')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Expire an active policy (admin; 409 on illegal transition).' })
  async expire(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.expire(requireActor(actor), id) };
  }

  @Get('policies/mine')
  @ApiOperation({ summary: 'My insurance policies.' })
  async myPolicies(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.myPolicies(requireActor(actor)) };
  }

  @Get('policies/:id')
  @ApiOperation({ summary: 'Policy detail (owner or admin).' })
  async getPolicy(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    const policy = await this.insurance.getPolicy(id);
    if (policy.farmerUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the policy holder or an admin may view this policy');
    }
    return { data: policy };
  }

  @Post('evaluate-triggers')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Deterministic batch trigger evaluation over ACTIVE policies (admin/cron). Fail-closed: 503 when a configured live provider is unreachable.'
  })
  async evaluate(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.evaluateTriggers(requireActor(actor)) };
  }

  @Get('trigger-events')
  @ApiOperation({ summary: 'My trigger events with evidence payloads and basis flags.' })
  async myTriggerEvents(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.myTriggerEvents(requireActor(actor)) };
  }

  @Get('trigger-events/all')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'All trigger events (admin).' })
  async allTriggerEvents(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.listTriggerEvents(requireActor(actor)) };
  }

  @Get('payouts')
  @ApiOperation({ summary: 'My payout ledger (stub execution).' })
  async myPayouts(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.myPayouts(requireActor(actor)) };
  }

  @Get('payouts/all')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'All payouts (admin).' })
  async allPayouts(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.listPayouts(requireActor(actor)) };
  }

  @Post('payouts/:id/confirm')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Confirm a proposed payout as PAID (stub execution — no real disbursement; 409 on illegal transition).'
  })
  async confirmPayout(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.confirmPayout(requireActor(actor), id) };
  }
}
