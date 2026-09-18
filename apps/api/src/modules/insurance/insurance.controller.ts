import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  InsuranceService,
  type CorrectedEvidenceInput,
  type ExGratiaPayoutInput,
  type QuoteInput
} from './insurance.service.js';

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
@UseGuards(RolesGuard)
export class InsuranceController {
  constructor(private readonly insurance: InsuranceService) {}

  @Get('products')
  @ApiOperation({ summary: 'Parametric product catalog (seeded, deterministic).' })
  async products() {
    return { data: await this.insurance.listProducts() };
  }

  @Post('quotes')
  @Authenticated()
  @ApiOperation({
    summary: 'Quote + persist a QUOTED policy (deterministic rate card; fail-closed pricing inputs).'
  })
  async quote(@Body() body: QuoteInput, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.quote(requireActor(actor), body) };
  }

  @Post('policies/:id/issue')
  @Authenticated()
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
  @Authenticated()
  @ApiOperation({ summary: 'My insurance policies.' })
  async myPolicies(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.myPolicies(requireActor(actor)) };
  }

  @Get('policies/:id')
  @Authenticated()
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
  @Authenticated()
  @ApiOperation({ summary: 'My trigger events with evidence payloads and basis flags.' })
  async myTriggerEvents(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.myTriggerEvents(requireActor(actor)) };
  }

  @Get('trigger-events/all')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'All trigger events, paginated (admin).' })
  async allTriggerEvents(@CurrentUser() actor: User | null, @Query() query: ListQueryDto) {
    return {
      data: await this.insurance.listTriggerEvents(requireActor(actor), query.page, query.pageSize)
    };
  }

  @Get('payouts')
  @Authenticated()
  @ApiOperation({ summary: 'My payout ledger (stub execution).' })
  async myPayouts(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.myPayouts(requireActor(actor)) };
  }

  @Get('payouts/all')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'All payouts, paginated (admin).' })
  async allPayouts(@CurrentUser() actor: User | null, @Query() query: ListQueryDto) {
    return {
      data: await this.insurance.listPayouts(requireActor(actor), query.page, query.pageSize)
    };
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

  /* ------------------------- V-42: dispute / appeal ------------------------- */

  @Post('payouts/:id/dispute')
  @Authenticated()
  @ApiOperation({
    summary: 'Dispute a proposed payout (policy holder, within the appeal window; freezes confirmation).'
  })
  async disputePayout(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.insurance.disputePayout(requireActor(actor), id, body.reason) };
  }

  @Post('payouts/:id/reject')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Reject an erroneous proposed/disputed payout (admin; auditable, appealable).'
  })
  async rejectPayout(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.insurance.rejectPayout(requireActor(actor), id, body.reason) };
  }

  @Post('payouts/:id/appeal')
  @Authenticated()
  @ApiOperation({
    summary: 'Appeal a rejected payout (policy holder, within the appeal window).'
  })
  async appealPayout(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.insurance.appealPayout(requireActor(actor), id, body.reason) };
  }

  @Post('payouts/:id/reevaluate')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Re-evaluate a disputed/appealed payout with corrected evidence (admin; deterministic re-run of the product trigger; balanced correcting leg on amount change).'
  })
  async reevaluatePayout(
    @Param('id') id: string,
    @Body() body: CorrectedEvidenceInput,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.insurance.reevaluatePayout(requireActor(actor), id, body) };
  }

  @Post('payouts/ex-gratia')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Propose an ex-gratia payout (admin; basis-risk safety valve for losses the parametric trigger missed; bounded by the sum insured).'
  })
  async proposeExGratia(@Body() body: ExGratiaPayoutInput, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.proposeExGratiaPayout(requireActor(actor), body) };
  }

  /* ------------------ V-43: settlement confirmation rail ------------------ */

  @Post('payouts/:id/settle')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Mark a PAID payout SETTLED on insurer rail confirmation (fail-closed 503 in production while the rail is stub-only).'
  })
  async confirmSettlement(
    @Param('id') id: string,
    @Body() body: { railReference: string },
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.insurance.confirmSettlement(requireActor(actor), id, body.railReference)
    };
  }

  @Post('payouts/:id/settlement-failure')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Record a rail settlement failure: reverses the settlement leg and re-queues the payout to PROPOSED.'
  })
  async recordSettlementFailure(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.insurance.recordSettlementFailure(requireActor(actor), id, body.reason)
    };
  }
}
