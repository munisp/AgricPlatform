import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import {
  ANIMAL_SEXES,
  ANIMAL_STATUSES,
  LIVESTOCK_SPECIES,
  NIGERIAN_STATES,
  OWNERSHIP_TRANSFER_TYPES
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type {
  CreateLotInput,
  PastoralistProfileInput,
  RegisterAnimalInput,
  TransferAnimalInput,
  UpdateAnimalInput
} from './livestock.service.js';
import { LivestockService } from './livestock.service.js';

class EnrolDto {
  @IsString()
  userId!: string;
}

class RegisterAnimalDto implements RegisterAnimalInput {
  @IsIn([...LIVESTOCK_SPECIES])
  species!: RegisterAnimalInput['species'];

  @IsString()
  breed!: string;

  @IsIn([...ANIMAL_SEXES])
  sex!: RegisterAnimalInput['sex'];

  @IsOptional()
  @IsISO8601()
  birthDate?: string;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @IsString()
  eid?: string;

  /** Nigerian state name (e.g. 'Kaduna'); the ID embeds the two-letter code. */
  @IsIn([...NIGERIAN_STATES])
  state!: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsString()
  sireId?: string;

  @IsOptional()
  @IsString()
  damId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class ListAnimalsQuery {
  @IsOptional()
  @IsIn([...LIVESTOCK_SPECIES])
  species?: RegisterAnimalInput['species'];

  @IsOptional()
  @IsIn([...ANIMAL_STATUSES])
  status?: UpdateAnimalInput['status'];

  @IsOptional()
  @IsString()
  state?: string;
}

class UpdateAnimalDto implements UpdateAnimalInput {
  @IsOptional()
  @IsString()
  breed?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  eid?: string;

  @IsOptional()
  @IsIn([...ANIMAL_STATUSES])
  status?: UpdateAnimalInput['status'];
}

class TransferAnimalDto implements TransferAnimalInput {
  @IsString()
  toUserId!: string;

  @IsIn([...OWNERSHIP_TRANSFER_TYPES])
  transferType!: TransferAnimalInput['transferType'];

  @IsOptional()
  @IsISO8601()
  effectiveAt?: string;
}

class CreateLotDto implements CreateLotInput {
  @IsIn([...LIVESTOCK_SPECIES])
  species!: CreateLotInput['species'];

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsIn([...NIGERIAN_STATES])
  state!: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsString()
  formationRule?: string;
}

class SetLotAnimalsDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  add?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  remove?: string[];
}

class PastoralistProfileDto implements PastoralistProfileInput {
  @IsOptional()
  @IsString()
  grazingZoneId?: string;

  @IsOptional()
  @IsString()
  migrationPattern?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn([...LIVESTOCK_SPECIES], { each: true })
  primarySpecies!: PastoralistProfileInput['primarySpecies'];
}

@ApiTags('livestock')
@Controller('livestock')
@UseGuards(RolesGuard)
export class LivestockController {
  constructor(private readonly livestock: LivestockService) {}

  @Post('enrol')
  @Authenticated()
  @ApiOperation({
    summary:
      'Enrol into the livestock domain: binds the farmer role marker and captures livestock_records consent (idempotent; retries with the same Idempotency-Key replay)'
  })
  async enrol(@Body() dto: EnrolDto, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.enrol(actor, dto.userId) };
  }

  @Post('animals')
  @Authenticated()
  @ApiOperation({
    summary:
      'Register an animal and issue its national ID (NG-{SPECIES}-{STATE}-{serial}). Idempotency-Key supported.'
  })
  async registerAnimal(@Body() dto: RegisterAnimalDto, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.registerAnimal(actor, dto) };
  }

  @Get('animals/mine')
  @Authenticated()
  @ApiOperation({ summary: "List the caller's animals (filter by species/status/state)" })
  async listMyAnimals(@Query() query: ListAnimalsQuery, @CurrentUser() actor: User | null) {
    return {
      data: await this.livestock.listMyAnimals(actor, {
        species: query.species,
        status: query.status,
        state: query.state
      })
    };
  }

  @Get('animals/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Animal detail (owner or admin)' })
  async getAnimal(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.getAnimal(actor, id) };
  }

  @Patch('animals/:id')
  @Authenticated()
  @ApiOperation({
    summary:
      'Update breed/notes/eid or transition status (mortality, theft, sale). dead is terminal. Owner or admin.'
  })
  async updateAnimal(
    @Param('id') id: string,
    @Body() dto: UpdateAnimalDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.livestock.updateAnimal(actor, id, dto) };
  }

  @Post('animals/:id/transfer')
  @Authenticated()
  @ApiOperation({
    summary:
      'Transfer ownership (owner only). Records the transfer ledger row and updates the owner atomically.'
  })
  async transferAnimal(
    @Param('id') id: string,
    @Body() dto: TransferAnimalDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.livestock.transferAnimal(actor, id, dto) };
  }

  @Get('animals/:id/transfers')
  @Authenticated()
  @ApiOperation({ summary: 'Ownership transfer history for an animal (owner or admin)' })
  async transferHistory(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.transferHistory(actor, id) };
  }

  @Post('lots')
  @Authenticated()
  @ApiOperation({ summary: 'Create a group lot (flock/pen/herd). Idempotency-Key supported.' })
  async createLot(@Body() dto: CreateLotDto, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.createLot(actor, dto) };
  }

  @Get('lots/mine')
  @Authenticated()
  @ApiOperation({ summary: "List the caller's lots" })
  async listMyLots(@CurrentUser() actor: User | null) {
    return { data: await this.livestock.listMyLots(actor) };
  }

  @Get('lots/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Lot detail including member animal IDs (owner or admin)' })
  async getLot(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.getLot(actor, id) };
  }

  @Put('lots/:id/animals')
  @Authenticated()
  @ApiOperation({
    summary:
      'Add/remove lot members. Caller must own the lot and every animal added; species must match the lot.'
  })
  async setLotAnimals(
    @Param('id') id: string,
    @Body() dto: SetLotAnimalsDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.livestock.updateLotAnimals(actor, id, { add: dto.add, remove: dto.remove }) };
  }

  @Get('pastoralist-profile')
  @Authenticated()
  @ApiOperation({ summary: "Caller's pastoralist profile (grazing zone, migration pattern, species)" })
  async myPastoralistProfile(@CurrentUser() actor: User | null) {
    return { data: await this.livestock.getPastoralistProfile(actor, actor?.id ?? '') };
  }

  @Put('pastoralist-profile')
  @Authenticated()
  @ApiOperation({ summary: "Create or update the caller's pastoralist profile" })
  async upsertPastoralistProfile(
    @Body() dto: PastoralistProfileDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.livestock.upsertPastoralistProfile(actor, actor?.id ?? '', dto) };
  }

  @Get('pastoralist-profile/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Pastoralist profile for a user (self or admin)' })
  async pastoralistProfile(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    return { data: await this.livestock.getPastoralistProfile(actor, userId) };
  }
}
