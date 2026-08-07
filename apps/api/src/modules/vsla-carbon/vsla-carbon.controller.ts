import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type { ProgrammeMrvReport } from './vsla-carbon.service.js';
import {
  VslaCarbonService,
  type AddMemberInput,
  type ContributionInput,
  type CreateGroupInput,
  type IssueLoanInput,
  type RegisterPlotInput,
  type RepaymentInput,
  type SubmitEvidenceInput
} from './vsla-carbon.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV of the programme MRV report (one row per group + total). */
export function programmeMrvCsv(report: ProgrammeMrvReport): string {
  const header =
    'group_id,group_name,plot_count,hectares_under_practice,mean_survival_rate_pct,' +
    'estimated_co2e_tonnes,estimate_count,evidence_count,ndvi_linked_evidence_count,basis_flags';
  const rows = report.groups.map((row) =>
    [
      row.groupId,
      row.groupName,
      row.plotCount,
      row.hectaresUnderPractice,
      row.meanSurvivalRatePct ?? '',
      row.estimatedCo2eTonnes,
      row.estimateCount,
      row.evidenceCount,
      row.ndviLinkedEvidenceCount,
      row.basisFlags.join('|')
    ]
      .map(csvEscape)
      .join(',')
  );
  rows.push(
    [
      'TOTAL',
      `${report.groupCount} groups`,
      report.plotCount,
      report.hectaresUnderPractice,
      report.meanSurvivalRatePct ?? '',
      report.estimatedCo2eTonnes,
      report.estimateCount,
      report.evidenceCount,
      report.ndviLinkedEvidenceCount,
      report.basisFlags.join('|')
    ]
      .map(csvEscape)
      .join(',')
  );
  return [header, ...rows].join('\n');
}

/**
 * VSLA groups + carbon MRV (wave VSLACARBON). Group registry (optionally
 * chapter-linked), savings cycles with ledger-backed contributions and
 * deterministic share-outs, small internal loans with simple interest, and
 * carbon MRV plots/evidence/estimates. Every carbon figure is an ESTIMATE —
 * credit issuance/trading is OUT OF SCOPE (external gates; see
 * docs/vsla-carbon-mrv.md).
 */
@ApiTags('vsla-carbon')
@Controller('vsla-carbon')
export class VslaCarbonController {
  constructor(private readonly service: VslaCarbonService) {}

  // --------------------------------------------------------------- groups

  @Post('groups')
  @UseGuards(RolesGuard)
  @Roles('chapter_lead', 'admin')
  @ApiOperation({ summary: 'Register a VSLA group (optionally chapter-linked); provisions ledger sub-accounts.' })
  async createGroup(@Body() body: CreateGroupInput, @CurrentUser() actor: User | null) {
    return { data: await this.service.createGroup(requireActor(actor), body) };
  }

  @Get('groups')
  @ApiOperation({ summary: 'List VSLA groups (privileged roles see all; members see their own).' })
  async listGroups(@CurrentUser() actor: User | null) {
    return { data: await this.service.listGroups(requireActor(actor)) };
  }

  @Get('groups/:id')
  @ApiOperation({ summary: 'VSLA group detail.' })
  async getGroup(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.getGroup(id) };
  }

  @Get('groups/:id/members')
  @ApiOperation({ summary: 'Group membership roster.' })
  async listMembers(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listMembers(id) };
  }

  @Post('groups/:id/members')
  @UseGuards(RolesGuard)
  @Roles('chapter_lead', 'admin')
  @ApiOperation({ summary: 'Add a member (idempotent re-join); provisions the member savings liability account.' })
  async addMember(
    @Param('id') id: string,
    @Body() body: AddMemberInput,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.service.addMember(requireActor(actor), id, body) };
  }

  // --------------------------------------------------------------- cycles

  @Post('groups/:id/cycles')
  @UseGuards(RolesGuard)
  @Roles('chapter_lead', 'admin')
  @ApiOperation({ summary: 'Open a savings cycle (at most one OPEN per group; 409 otherwise).' })
  async openCycle(
    @Param('id') id: string,
    @Body() body: { label: string },
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.service.openCycle(requireActor(actor), id, body?.label) };
  }

  @Get('groups/:id/cycles')
  @ApiOperation({ summary: 'List savings cycles for a group.' })
  async listCycles(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listCycles(id) };
  }

  @Post('cycles/:id/contributions')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'chapter_lead', 'enumerator', 'admin')
  @ApiOperation({
    summary: 'Record a member contribution into an OPEN cycle (double-entry; idempotent by key).'
  })
  async contribute(
    @Param('id') id: string,
    @Body() body: ContributionInput,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.service.contribute(requireActor(actor), id, body) };
  }

  @Get('cycles/:id/contributions')
  @ApiOperation({ summary: 'Contributions recorded in a cycle.' })
  async listContributions(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listContributions(id) };
  }

  @Post('cycles/:id/close')
  @UseGuards(RolesGuard)
  @Roles('chapter_lead', 'admin')
  @ApiOperation({
    summary: 'Close a cycle and run the deterministic pro-rata share-out (idempotent replay).'
  })
  async closeCycle(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.service.closeCycle(requireActor(actor), id) };
  }

  @Get('cycles/:id/share-out')
  @ApiOperation({ summary: 'Share-out payout rows recorded at cycle close.' })
  async getShareOut(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.getShareOut(id) };
  }

  // ---------------------------------------------------------------- loans

  @Post('groups/:id/loans')
  @UseGuards(RolesGuard)
  @Roles('chapter_lead', 'admin')
  @ApiOperation({
    summary: 'Issue a small internal loan from the pool (simple interest; pool solvency guarded).'
  })
  async issueLoan(
    @Param('id') id: string,
    @Body() body: IssueLoanInput,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.service.issueLoan(requireActor(actor), id, body) };
  }

  @Get('groups/:id/loans')
  @ApiOperation({ summary: 'Internal loans issued by the group.' })
  async listLoans(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listLoans(id) };
  }

  @Post('loans/:id/repayments')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'chapter_lead', 'admin')
  @ApiOperation({ summary: 'Record a loan repayment (idempotent by key; overpay clamps to outstanding).' })
  async repayLoan(
    @Param('id') id: string,
    @Body() body: RepaymentInput,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.service.repayLoan(requireActor(actor), id, body) };
  }

  @Get('loans/:id/repayments')
  @ApiOperation({ summary: 'Repayments recorded against a loan.' })
  async listRepayments(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listRepayments(id) };
  }

  // ---------------------------------------------------------------- plots

  @Post('plots')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'chapter_lead', 'enumerator', 'admin')
  @ApiOperation({
    summary: 'Register a practice-adoption plot (H3 res-9 index computed in the app layer — no PostGIS).'
  })
  async registerPlot(@Body() body: RegisterPlotInput, @CurrentUser() actor: User | null) {
    return { data: await this.service.registerPlot(requireActor(actor), body) };
  }

  @Get('plots')
  @ApiOperation({ summary: 'List carbon plots (optionally filtered by groupId).' })
  async listPlots(@Query('groupId') groupId: string | undefined, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listPlots(groupId) };
  }

  @Get('plots/:id')
  @ApiOperation({ summary: 'Carbon plot detail.' })
  async getPlot(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.getPlot(id) };
  }

  // -------------------------------------------------------------- evidence

  @Post('plots/:id/evidence')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'enumerator', 'admin')
  @ApiOperation({
    summary:
      'Submit seasonal evidence (farmer/enumerator attestation; optional Sentinel-2 NDVI linkage — fail-closed 503 when the live provider is unreachable).'
  })
  async submitEvidence(
    @Param('id') id: string,
    @Body() body: SubmitEvidenceInput,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.service.submitEvidence(requireActor(actor), id, body) };
  }

  @Get('plots/:id/evidence')
  @ApiOperation({ summary: 'Seasonal evidence for a plot (basis flags stored verbatim).' })
  async listEvidence(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listEvidence(id) };
  }

  // ------------------------------------------------------------- estimates

  @Post('plots/:id/estimate')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'chapter_lead', 'enumerator', 'admin')
  @ApiOperation({
    summary:
      "Compute + persist a deterministic carbon ESTIMATE for a plot/season (versioned coefficient table; idempotent). Labelled 'estimate — not verification-grade'."
  })
  async estimatePlot(
    @Param('id') id: string,
    @Body() body: { season: string },
    @CurrentUser() actor: User | null
  ) {
    if (!body?.season) {
      throw new BadRequestException('season is required');
    }
    return { data: await this.service.estimatePlot(requireActor(actor), id, body.season) };
  }

  @Get('plots/:id/estimates')
  @ApiOperation({ summary: 'Persisted carbon estimates for a plot (basis: estimate).' })
  async listEstimates(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.listEstimates(id) };
  }

  @Get('coefficients')
  @ApiOperation({
    summary: 'Versioned carbon ESTIMATE coefficient table with citations (not a carbon standard methodology).'
  })
  async coefficients(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: this.service.listCoefficients() };
  }

  @Get('ndvi/status')
  @ApiOperation({ summary: 'NDVI provider status (stub default; live crop-ml sidecar when configured).' })
  async ndviStatus(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.ndviStatus() };
  }

  // -------------------------------------------------------------- reports

  @Get('reports/group/:id')
  @UseGuards(RolesGuard)
  @Roles('chapter_lead', 'donor', 'regulator', 'admin')
  @ApiOperation({
    summary: 'Group MRV report: hectares under practice, survival, estimated CO2e, evidence counts (basis-flagged).'
  })
  async groupReport(@Param('id') id: string, @CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.groupMrvReport(id) };
  }

  @Get('reports/programme')
  @UseGuards(RolesGuard)
  @Roles('donor', 'regulator', 'admin')
  @ApiOperation({ summary: 'Programme-level MRV aggregate across all VSLA groups (donor/regulator/admin).' })
  async programmeReport(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.service.programmeMrvReport() };
  }

  @Get('reports/export')
  @UseGuards(RolesGuard)
  @Roles('donor', 'regulator', 'admin')
  @ApiOperation({
    summary:
      'Programme MRV export. format=json (default) returns the aggregate; format=csv streams an RFC 4180 CSV. Donor/regulator/admin.'
  })
  async exportReport(
    @Query('format') format: string | undefined,
    @CurrentUser() actor: User | null,
    @Res({ passthrough: true }) response: Response
  ) {
    requireActor(actor);
    const report = await this.service.programmeMrvReport();
    if ((format ?? 'json') === 'csv') {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="vsla-carbon-mrv.csv"');
      return programmeMrvCsv(report);
    }
    if ((format ?? 'json') !== 'json') {
      throw new BadRequestException("format must be 'json' or 'csv'");
    }
    return { data: report };
  }
}
