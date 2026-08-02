import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested
} from 'class-validator';
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_DIRECTIONS,
  type LedgerAccountType,
  type LedgerDirection,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { LedgerService, type PostEntryInput } from './ledger.service.js';

class CreateLedgerAccountDto {
  @IsString()
  @Matches(/^[a-z0-9:_-]+$/i)
  code!: string;

  @IsIn(LEDGER_ACCOUNT_TYPES)
  type!: LedgerAccountType;

  @IsOptional()
  @IsString()
  ownerId?: string;
}

class PostingDto {
  @IsString()
  accountCode!: string;

  @IsIn(LEDGER_DIRECTIONS)
  direction!: LedgerDirection;

  @IsInt()
  @Min(1)
  amountKobo!: number;
}

class PostEntryDto implements PostEntryInput {
  @IsString()
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  referenceType?: string;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @ValidateNested({ each: true })
  @Type(() => PostingDto)
  @ArrayMinSize(2)
  postings!: PostingDto[];
}

function actorIdOf(actor: User | null): string {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor.id;
}

/** Double-entry ledger administration (wave P2a). Writes are admin-only. */
@ApiTags('finance')
@Controller('finance/ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('accounts')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List ledger accounts (admin)' })
  async accounts() {
    return { data: await this.ledger.listAccounts() };
  }

  @Post('accounts')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Open a ledger account (admin)' })
  async createAccount(@Body() dto: CreateLedgerAccountDto) {
    return { data: await this.ledger.createAccount(dto) };
  }

  @Get('accounts/:code/balance')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Debit/credit totals and signed balance for an account (admin)' })
  async balance(@Param('code') code: string) {
    return { data: await this.ledger.balance(code) };
  }

  @Get('accounts/:code/entries')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Journal entries touching an account (admin)' })
  async entriesForAccount(@Param('code') code: string) {
    return { data: await this.ledger.entriesForAccount(code) };
  }

  @Get('entries')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List journal entries by reference (admin)' })
  async entries(
    @Query('referenceType') referenceType?: string,
    @Query('referenceId') referenceId?: string
  ) {
    return { data: await this.ledger.listEntries({ referenceType, referenceId }) };
  }

  @Post('entries')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Post a balanced journal entry (admin; idempotent by key)' })
  async postEntry(@Body() dto: PostEntryDto, @CurrentUser() actor: User | null) {
    return { data: await this.ledger.postEntry(dto, actorIdOf(actor)) };
  }

  @Get('entries/:id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Journal entry detail (admin)' })
  async entry(@Param('id') id: string) {
    return { data: await this.ledger.getEntry(id) };
  }

  @Post('entries/:id/reverse')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Reverse a journal entry with a counter-entry (admin)' })
  async reverse(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.ledger.reverseEntry(id, actorIdOf(actor)) };
  }
}
