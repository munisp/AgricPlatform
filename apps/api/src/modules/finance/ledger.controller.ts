import {
  Body,
  Controller,
  Get,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_DIRECTIONS,
  type LedgerAccountType,
  type LedgerDirection,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  LEDGER_BACKEND,
  type LedgerBackendDriver
} from '../integrations/drivers/tigerbeetle.driver.js';
import { LedgerReconciliationService } from './ledger-reconciliation.service.js';
import { LedgerService, type PostEntryInput } from './ledger.service.js';
import { TbConsistencyChecker } from './tb-consistency.checker.js';

class CreateLedgerAccountDto {
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9:_-]+$/i)
  code!: string;

  @IsIn(LEDGER_ACCOUNT_TYPES)
  type!: LedgerAccountType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerId?: string;
}

class PostingDto {
  @IsString()
  @MaxLength(100)
  accountCode!: string;

  @IsIn(LEDGER_DIRECTIONS)
  direction!: LedgerDirection;

  @IsInt()
  @Min(1)
  amountKobo!: number;
}

class PostEntryDto implements PostEntryInput {
  @IsString()
  @MaxLength(100)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
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
  constructor(
    private readonly ledger: LedgerService,
    private readonly reconciliation: LedgerReconciliationService,
    private readonly tbConsistency: TbConsistencyChecker,
    @Optional() @Inject(LEDGER_BACKEND) private readonly backend?: LedgerBackendDriver
  ) {}

  /**
   * WP-G13 drift detection: committed journal entries failing the balance
   * invariant (finance.transfer_is_balanced / ≥2 postings). Must be empty —
   * a non-empty result proves a writer bypassed the guarded posting path.
   * A non-empty result increments finance.ledger.unbalanced_transfers and
   * writes an audit row.
   */
  @Get('reconciliation/balance')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Unbalanced committed journal entries (admin; drift alert — must be empty)'
  })
  async unbalancedEntries() {
    const unbalanced = await this.reconciliation.findUnbalancedEntries();
    return { data: { balanced: unbalanced.length === 0, entries: unbalanced } };
  }

  /**
   * WP-G13 escrow value reconciliation: Σ open escrow holds vs the ledger
   * holds-liability and provider-float accounts, plus per-escrow leg
   * presence. Detect-only; drift increments
   * finance.ledger.escrow_reconciliation.drift and is audited.
   */
  @Get('reconciliation/escrow')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Escrow Σ vs ledger liability reconciliation report (admin, detect-only)'
  })
  async escrowReconciliation() {
    return { data: await this.reconciliation.reconcileEscrow({ repair: false }) };
  }

  /**
   * WP-G13 escrow reconciliation REPAIR: posts missing hold/settlement legs
   * (idempotency-keyed — never double-posts), backfilling pre-WP-G13
   * escrows. Amount mismatches and orphan entries stay alert-only.
   */
  @Post('reconciliation/escrow/repair')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Repair missing escrow ledger legs (admin; idempotent) and re-report'
  })
  async escrowReconciliationRepair() {
    return { data: await this.reconciliation.reconcileEscrow({ repair: true }) };
  }

  /**
   * WP-G13 pg↔TigerBeetle consistency: per configured account pair, the pg
   * ledger balance vs the TigerBeetle posted balance. Disabled (inert)
   * unless the tigerbeetle backend is selected; tigerbeetle selected with
   * no account map reports unmapped=true (fail-visible, never silently
   * divergent).
   */
  @Get('reconciliation/backend')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'pg↔TigerBeetle balance consistency report (admin; inert unless LEDGER_DRIVER=tigerbeetle)'
  })
  async backendConsistency() {
    return { data: await this.tbConsistency.runCheck() };
  }

  /**
   * Wave FABRIC: selected ledger-backend driver status (stub = Postgres
   * ledger authoritative; tigerbeetle = proof-of-port, legal-gated OFF by
   * default). Diagnostics only — never moves money.
   */
  @Get('backend-status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Ledger-backend driver status (admin, diagnostics)' })
  async backendStatus() {
    return {
      data: this.backend
        ? { driver: this.backend.name, ...(await this.backend.status()) }
        : { driver: 'stub', configured: true, healthy: true, detail: 'No backend driver bound.' }
    };
  }

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
