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
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import {
  DISEASE_FLAG_STATUSES,
  HEALTH_RECORD_TYPES,
  LIVESTOCK_SPECIES,
  MOVEMENT_PURPOSES,
  MOVEMENT_TRANSPORT_MODES,
  NIGERIAN_STATES,
  RECALL_STATUSES
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type {
  InitiateRecallInput,
  IssuePermitInput,
  RecordHealthInput,
  ReportDiseaseFlagInput,
  StartMovementInput
} from './livestock-health.service.js';
import { LivestockHealthService } from './livestock-health.service.js';

class RecordHealthDto implements RecordHealthInput {
  @IsString()
  animalId!: string;

  @IsIn([...HEALTH_RECORD_TYPES])
  recordType!: RecordHealthInput['recordType'];

  @IsString()
  product!: string;

  @IsString()
  batchNumber!: string;

  @IsString()
  dose!: string;

  @IsISO8601()
  administeredAt!: string;

  @IsOptional()
  @IsISO8601()
  withdrawalUntil?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class ReverseHealthDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

class StartMovementDto implements StartMovementInput {
  @IsOptional()
  @IsString()
  animalId?: string;

  @IsOptional()
  @IsString()
  lotId?: string;

  @IsIn([...NIGERIAN_STATES])
  fromState!: string;

  @IsOptional()
  @IsString()
  fromLga?: string;

  @IsIn([...NIGERIAN_STATES])
  toState!: string;

  @IsOptional()
  @IsString()
  toLga?: string;

  @IsOptional()
  @IsISO8601()
  departedAt?: string;

  @IsIn([...MOVEMENT_TRANSPORT_MODES])
  transportMode!: StartMovementInput['transportMode'];

  @IsIn([...MOVEMENT_PURPOSES])
  purpose!: StartMovementInput['purpose'];

  @IsOptional()
  @IsString()
  permitId?: string;
}

class ArrivalDto {
  @IsOptional()
  @IsISO8601()
  arrivedAt?: string;
}

class IssuePermitDto implements IssuePermitInput {
  @IsOptional()
  @IsString({ each: true })
  animalIds?: string[];

  @IsOptional()
  @IsString({ each: true })
  lotIds?: string[];

  @IsIn([...NIGERIAN_STATES])
  fromState!: string;

  @IsIn([...NIGERIAN_STATES])
  toState!: string;

  @IsISO8601()
  validFrom!: string;

  @IsISO8601()
  validUntil!: string;
}

class RevokePermitDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

class InitiateRecallDto implements InitiateRecallInput {
  @IsOptional()
  @IsString()
  animalId?: string;

  @IsOptional()
  @IsString()
  lotId?: string;

  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @IsOptional()
  @IsIn([...NIGERIAN_STATES])
  state?: string;

  @IsOptional()
  @IsISO8601()
  fromDate?: string;

  @IsOptional()
  @IsISO8601()
  toDate?: string;

  @IsOptional()
  @IsString()
  batchNumber?: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

class ListRecallsQuery {
  @IsOptional()
  @IsIn([...RECALL_STATUSES])
  status?: (typeof RECALL_STATUSES)[number];
}

class ReportDiseaseFlagDto implements ReportDiseaseFlagInput {
  @IsString()
  @IsNotEmpty()
  disease!: string;

  @IsIn([...NIGERIAN_STATES])
  state!: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsIn([...LIVESTOCK_SPECIES])
  suspectedSpecies?: ReportDiseaseFlagInput['suspectedSpecies'];
}

class RetractDiseaseFlagDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

class ListDiseaseFlagsQuery {
  @IsOptional()
  @IsIn([...DISEASE_FLAG_STATUSES])
  status?: (typeof DISEASE_FLAG_STATUSES)[number];

  @IsOptional()
  @IsString()
  state?: string;
}

class DiseaseMapQuery {
  @IsOptional()
  @IsIn([...NIGERIAN_STATES])
  state?: string;
}

@ApiTags('livestock-health')
@Controller('livestock-health')
@UseGuards(RolesGuard)
export class LivestockHealthController {
  constructor(private readonly health: LivestockHealthService) {}

  // --- Vet-signed health ledger -------------------------------------------

  @Post('records')
  @Authenticated()
  @ApiOperation({
    summary:
      'Append a vet-signed vaccination/treatment record (vet role; admins for programme tooling). Append-only ledger — corrections use the reverse endpoint.'
  })
  async recordHealth(@Body() dto: RecordHealthDto, @CurrentUser() actor: User | null) {
    return { data: await this.health.recordHealth(actor, dto) };
  }

  @Post('records/:id/reverse')
  @Authenticated()
  @ApiOperation({
    summary: 'Append a reversing entry that annuls a health record (vet). The original is never mutated.'
  })
  async reverseHealthRecord(
    @Param('id') id: string,
    @Body() dto: ReverseHealthDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.health.reverseHealthRecord(actor, id, dto.notes) };
  }

  @Get('records/:id/verify')
  @Authenticated()
  @ApiOperation({
    summary: 'Recompute the HMAC signature over a health record (tamper detection) and report reversal status.'
  })
  async verifyHealthRecord(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.verifyHealthRecord(actor, id) };
  }

  @Get('animals/:animalId/records')
  @Authenticated()
  @ApiOperation({ summary: 'Health ledger for an animal (owner, admin, vet or regulator)' })
  async listHealthRecords(@Param('animalId') animalId: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.listHealthRecords(actor, animalId) };
  }

  // --- Movement log --------------------------------------------------------

  @Post('movements')
  @Authenticated()
  @ApiOperation({
    summary:
      'Start a chain-of-custody movement for an animal or lot (owner). Blocked while another movement is open; an optional permit is validated.'
  })
  async startMovement(@Body() dto: StartMovementDto, @CurrentUser() actor: User | null) {
    return { data: await this.health.startMovement(actor, dto) };
  }

  @Post('movements/:id/arrive')
  @Authenticated()
  @ApiOperation({ summary: 'Close an open movement by recording its arrival (owner or admin)' })
  async recordArrival(
    @Param('id') id: string,
    @Body() dto: ArrivalDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.health.recordArrival(actor, id, dto.arrivedAt) };
  }

  @Get('animals/:animalId/movements')
  @Authenticated()
  @ApiOperation({ summary: 'Movement history for an animal (owner, admin, vet or regulator)' })
  async listAnimalMovements(@Param('animalId') animalId: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.listAnimalMovements(actor, animalId) };
  }

  @Get('lots/:lotId/movements')
  @Authenticated()
  @ApiOperation({ summary: 'Movement history for a lot (owner, admin, vet or regulator)' })
  async listLotMovements(@Param('lotId') lotId: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.listLotMovements(actor, lotId) };
  }

  // --- Movement permits ----------------------------------------------------

  @Post('permits')
  @Authenticated()
  @ApiOperation({ summary: 'Issue a state movement permit covering animals and/or lots (vet or regulator)' })
  async issuePermit(@Body() dto: IssuePermitDto, @CurrentUser() actor: User | null) {
    return { data: await this.health.issuePermit(actor, dto) };
  }

  @Get('permits/:idOrNumber/verify')
  @Authenticated()
  @ApiOperation({
    summary: 'Verify a permit by id or permit number; returns the permit, its subjects and status (valid/revoked/expired).'
  })
  async verifyPermit(@Param('idOrNumber') idOrNumber: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.verifyPermit(actor, idOrNumber) };
  }

  @Post('permits/:id/revoke')
  @Authenticated()
  @ApiOperation({ summary: 'Revoke a movement permit with a mandatory reason (vet or regulator)' })
  async revokePermit(
    @Param('id') id: string,
    @Body() dto: RevokePermitDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.health.revokePermit(actor, id, dto.reason) };
  }

  // --- Recall --------------------------------------------------------------

  @Post('recalls')
  @Authenticated()
  @ApiOperation({
    summary:
      'Initiate a recall scoped by animal, lot, owner or state+date range (regulator/admin). Affected animals are computed from health records (batch match), movements and lot membership; owners are notified via the recall listener.'
  })
  async initiateRecall(@Body() dto: InitiateRecallDto, @CurrentUser() actor: User | null) {
    return { data: await this.health.initiateRecall(actor, dto) };
  }

  @Get('recalls')
  @Authenticated()
  @ApiOperation({ summary: 'List recall cases (regulator/admin)' })
  async listRecalls(@Query() query: ListRecallsQuery, @CurrentUser() actor: User | null) {
    return { data: await this.health.listRecalls(actor, { status: query.status }) };
  }

  @Get('recalls/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Recall detail with materialised animals (regulator/admin or an affected owner)' })
  async getRecall(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.getRecall(actor, id) };
  }

  @Post('recalls/:id/resolve')
  @Authenticated()
  @ApiOperation({ summary: 'Resolve a notified recall (regulator/admin)' })
  async resolveRecall(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.resolveRecall(actor, id) };
  }

  // --- Disease surveillance -------------------------------------------------

  @Post('disease-flags')
  @Authenticated()
  @ApiOperation({ summary: 'Report a suspected disease outbreak flag (any authenticated user)' })
  async reportDiseaseFlag(@Body() dto: ReportDiseaseFlagDto, @CurrentUser() actor: User | null) {
    return { data: await this.health.reportDiseaseFlag(actor, dto) };
  }

  @Post('disease-flags/:id/confirm')
  @Authenticated()
  @ApiOperation({
    summary: 'Confirm a reported flag (vet/regulator/admin); feeds the disease map and the government notification adapter.'
  })
  async confirmDiseaseFlag(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.confirmDiseaseFlag(actor, id) };
  }

  @Post('disease-flags/:id/retract')
  @Authenticated()
  @ApiOperation({
    summary: 'Retract a flag as a false positive with a mandatory reason (reporter, regulator or admin).'
  })
  async retractDiseaseFlag(
    @Param('id') id: string,
    @Body() dto: RetractDiseaseFlagDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.health.retractDiseaseFlag(actor, id, dto.reason) };
  }

  @Get('disease-flags')
  @Authenticated()
  @ApiOperation({ summary: 'List disease flags (filter by status/state)' })
  async listDiseaseFlags(@Query() query: ListDiseaseFlagsQuery, @CurrentUser() actor: User | null) {
    return {
      data: await this.health.listDiseaseFlags(actor, { status: query.status, state: query.state })
    };
  }

  @Get('disease-map')
  @Authenticated()
  @ApiOperation({ summary: 'State-level disease map: confirmed flags grouped by state and disease (dashboard feed)' })
  async diseaseMap(@Query() query: DiseaseMapQuery, @CurrentUser() actor: User | null) {
    return { data: await this.health.diseaseMap(actor, query.state) };
  }

  // --- Trust grade -----------------------------------------------------------

  @Get('animals/:animalId/grade')
  @Authenticated()
  @ApiOperation({
    summary: 'Deterministic trust grade (A–D) from vaccination coverage, treatment recency, movement count and age (owner, admin, vet or regulator).'
  })
  async gradeAnimal(@Param('animalId') animalId: string, @CurrentUser() actor: User | null) {
    return { data: await this.health.gradeAnimal(actor, animalId) };
  }
}
