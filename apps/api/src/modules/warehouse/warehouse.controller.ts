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
import { ArrayMinSize, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { User, WarehouseCertificationStatus, WarehouseGrade } from '@agric-platform/shared';
import { WAREHOUSE_CERTIFICATION_STATUSES, WAREHOUSE_GRADES, WAREHOUSE_LOSS_KINDS } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { WarehouseBondService } from './warehouse-bond.service.js';
import {
  WarehouseService,
  type RegisterWarehouseInput,
  type ReportLossInput,
  type SplitReceiptPartInput
} from './warehouse.service.js';

/** V-07: spoilage/condition loss report (warehouse operator = admin). */
class ReportLossDto implements ReportLossInput {
  @IsIn(WAREHOUSE_LOSS_KINDS)
  kind!: ReportLossInput['kind'];

  @IsOptional()
  @IsNumber()
  @Min(0)
  lostWeightKg?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lostBagCount?: number;

  @IsOptional()
  @IsIn(WAREHOUSE_GRADES)
  newGrade?: WarehouseGrade;

  @IsString()
  @MaxLength(2000)
  reason!: string;
}

/** V-37: one part of a receipt split. */
class SplitPartDto implements SplitReceiptPartInput {
  @IsNumber()
  @Min(0.000001)
  weightKg!: number;

  @IsInt()
  @Min(1)
  bagCount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  toOwnerId?: string;
}

class SplitReceiptDto {
  @ValidateNested({ each: true })
  @Type(() => SplitPartDto)
  @ArrayMinSize(2)
  parts!: SplitPartDto[];
}

/** V-39: operator bond posting (admin). */
class PostBondDto {
  @IsInt()
  @Min(1)
  amountKobo!: number;
}

/** V-39: one adjudicated write-down inside a fraud case. */
class FraudWriteDownDto {
  @IsString()
  @MaxLength(100)
  receiptId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  lostWeightKg?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lostBagCount?: number;
}

class ResolveFraudCaseDto {
  @IsString()
  @MaxLength(200)
  caseId!: string;

  @IsInt()
  @Min(1)
  compensationKobo!: number;

  @ValidateNested({ each: true })
  @Type(() => FraudWriteDownDto)
  writeDowns!: FraudWriteDownDto[];
}

class RegisterWarehouseDto implements RegisterWarehouseInput {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(100)
  state!: string;

  @IsString()
  @MaxLength(100)
  lga!: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsNumber()
  @Min(0.01)
  capacityTonnes!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  operatorLicenseRef?: string;
}

class BrowseWarehousesQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lga?: string;

  @IsOptional()
  @IsIn(WAREHOUSE_CERTIFICATION_STATUSES)
  certificationStatus?: WarehouseCertificationStatus;
}

class CreateDepositDto {
  @IsString()
  @MaxLength(100)
  warehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotId?: string;

  @IsString()
  @MaxLength(100)
  crop!: string;
}

class GradeDepositDto {
  @IsIn(WAREHOUSE_GRADES)
  grade!: WarehouseGrade;

  @IsNumber()
  @Min(0)
  @Max(100)
  moisturePercent!: number;

  @IsInt()
  @Min(1)
  bagCount!: number;

  @IsNumber()
  @Min(0.01)
  weightKg!: number;
}

class PledgeReceiptDto {
  @IsInt()
  @Min(1)
  principalKobo!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  terms?: string;
}

class TransferReceiptDto {
  @IsString()
  @MaxLength(100)
  toOwnerId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

@ApiTags('warehouse')
@Controller('warehouse')
export class WarehouseController {
  constructor(
    private readonly warehouse: WarehouseService,
    private readonly bond: WarehouseBondService
  ) {}

  /* ------------------------- warehouse registry (admin) ------------------ */

  @Get('warehouses')
  @ApiOperation({ summary: 'Browse the certified warehouse registry (state/LGA/certification filters)' })
  browseWarehouses(@Query() query: BrowseWarehousesQuery) {
    return this.warehouse.browseWarehouses(query).then((data) => ({ data }));
  }

  @Post('warehouses')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Register a warehouse (admin; starts certification PENDING)' })
  async registerWarehouse(@Body() dto: RegisterWarehouseDto, @CurrentUser() actor: User | null) {
    return { data: await this.warehouse.registerWarehouse(dto, requireActor(actor).id) };
  }

  @Get('warehouses/:id')
  @ApiOperation({ summary: 'Warehouse detail (capacity, H3 cell, certification status)' })
  async getWarehouse(@Param('id') id: string) {
    return { data: await this.warehouse.getWarehouse(id) };
  }

  @Post('warehouses/:id/certification')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Re-check operator certification through the feed port (admin; STUB-labelled by default)'
  })
  async refreshCertification(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.warehouse.refreshCertification(id, requireActor(actor)) };
  }

  /* ------------------------------ deposits -------------------------------- */

  // Declared before `deposits/:id` so literal routes are not captured as ids.
  @Get('deposits/mine')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'admin')
  @ApiOperation({ summary: "The current farmer's deposits, newest first" })
  async myDeposits(@CurrentUser() actor: User | null) {
    return { data: await this.warehouse.listDepositsForFarmer(requireActor(actor).id) };
  }

  @Post('deposits')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'admin')
  @ApiOperation({ summary: 'Deposit a crop lot at a certified warehouse (farmer)' })
  async createDeposit(@Body() dto: CreateDepositDto, @CurrentUser() actor: User | null) {
    return { data: await this.warehouse.createDeposit(dto, requireActor(actor).id) };
  }

  @Get('deposits/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Deposit detail (owner, admin or regulator)' })
  async getDeposit(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    const deposit = await this.warehouse.getDeposit(id);
    if (
      deposit.farmerId !== caller.id &&
      !caller.roles.includes('admin') &&
      !caller.roles.includes('regulator')
    ) {
      throw new UnauthorizedException('Only the deposit owner may view this deposit');
    }
    return { data: deposit };
  }

  @Post('deposits/:id/grading')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Record the quality grading (warehouse operator / admin)' })
  async gradeDeposit(
    @Param('id') id: string,
    @Body() dto: GradeDepositDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.warehouse.gradeDeposit(id, dto, requireActor(actor)) };
  }

  @Post('deposits/:id/receipt')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Issue the HMAC-signed e-WHR for a graded deposit (idempotent)' })
  async issueReceipt(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.warehouse.issueReceipt(id, requireActor(actor)) };
  }

  /* ------------------------------- receipts ------------------------------- */

  // Declared before `receipts/:id` so literal routes are not captured as ids.
  @Get('receipts/mine')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'admin')
  @ApiOperation({ summary: 'Receipts owned by the current user, newest first' })
  async myReceipts(@CurrentUser() actor: User | null) {
    return { data: await this.warehouse.listReceiptsForOwner(requireActor(actor).id) };
  }

  @Get('receipts/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Receipt detail (owner, pledge-holding lender, admin, regulator)' })
  async getReceipt(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    const receipt = await this.warehouse.getReceipt(id);
    await this.warehouse.assertReceiptViewer(receipt, caller);
    return { data: receipt };
  }

  @Get('receipts/:id/verify')
  @ApiOperation({ summary: 'Verify the HMAC signature of a receipt (tamper evidence)' })
  async verifyReceipt(@Param('id') id: string) {
    const receipt = await this.warehouse.getReceipt(id);
    return { data: { receiptNumber: receipt.receiptNumber, valid: this.warehouse.verifyReceipt(receipt) } };
  }

  @Get('receipts/:id/pledges')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Pledge history for a receipt (receipt parties)' })
  async receiptPledges(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    const receipt = await this.warehouse.getReceipt(id);
    await this.warehouse.assertReceiptViewer(receipt, caller);
    return { data: await this.warehouse.listPledgesForReceipt(id) };
  }

  @Get('receipts/:id/transfers')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Ownership-transfer audit trail for a receipt (receipt parties)' })
  async receiptTransfers(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    const receipt = await this.warehouse.getReceipt(id);
    await this.warehouse.assertReceiptViewer(receipt, caller);
    return { data: await this.warehouse.listTransfersForReceipt(id) };
  }

  @Post('receipts/:id/pledge')
  @UseGuards(RolesGuard)
  @Roles('lender', 'admin')
  @ApiOperation({ summary: 'Pledge a receipt as loan collateral (lender; collateral-registry recorded)' })
  async pledgeReceipt(
    @Param('id') id: string,
    @Body() dto: PledgeReceiptDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.warehouse.pledgeReceipt(id, dto, requireActor(actor)) };
  }

  @Post('receipts/:id/release')
  @UseGuards(RolesGuard)
  @Roles('lender', 'admin')
  @ApiOperation({ summary: 'Release the active pledge (pledge-holding lender or admin)' })
  async releasePledge(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.warehouse.releasePledge(id, requireActor(actor)) };
  }

  @Post('receipts/:id/transfer')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Transfer receipt ownership (owner; append-only audit trail)' })
  async transferReceipt(
    @Param('id') id: string,
    @Body() dto: TransferReceiptDto,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.warehouse.transferReceipt(id, dto.toOwnerId, requireActor(actor), dto.note)
    };
  }

  @Post('receipts/:id/redeem')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Withdraw the grain — the receipt is REDEEMED (owner; not while pledged)' })
  async redeemReceipt(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.warehouse.redeemReceipt(id, requireActor(actor)) };
  }

  /** V-07: record a spoilage/condition loss (warehouse operator = admin). */
  @Post('receipts/:id/loss')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'V-07: report a spoilage/condition loss or re-grade — cumulative write-down, propagates to LTV (margin call) and claims (haircut)'
  })
  async reportLoss(
    @Param('id') id: string,
    @Body() dto: ReportLossDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.warehouse.reportLoss(id, dto, requireActor(actor)) };
  }

  /** V-37: split a receipt into quantity-conserved, signature-chained children. */
  @Post('receipts/:id/split')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({
    summary:
      'V-37: split a receipt into child receipts (owner; exact quantity conservation; parent becomes non-pledgeable)'
  })
  async splitReceipt(
    @Param('id') id: string,
    @Body() dto: SplitReceiptDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.warehouse.splitReceipt(id, dto.parts, requireActor(actor)) };
  }

  /** V-39: post the operator performance bond (ledger-backed; admin). */
  @Post('warehouses/:id/bond')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'V-39: post the operator bond (balanced legs; idempotent per warehouse; E-08 external gate)'
  })
  async postBond(
    @Param('id') warehouseId: string,
    @Body() dto: PostBondDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.bond.postBond(warehouseId, dto.amountKobo, requireActor(actor)) };
  }

  /** V-39: resolve an operator fraud case — write-downs + balanced bond draw. */
  @Post('warehouses/:id/fraud-cases')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'V-39: resolve an operator fraud case — pro-rata receipt write-downs + bond draw (capped at the bond, fail closed)'
  })
  async resolveFraudCase(
    @Param('id') warehouseId: string,
    @Body() dto: ResolveFraudCaseDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.bond.resolveFraudCase(warehouseId, dto, requireActor(actor)) };
  }

  /* ------------------------------ lender desk ----------------------------- */

  @Get('pledges/mine')
  @UseGuards(RolesGuard)
  @Roles('lender', 'admin')
  @ApiOperation({ summary: 'Pledges registered by the current lender, newest first' })
  async myPledges(@CurrentUser() actor: User | null) {
    return { data: await this.warehouse.listPledgesForLender(requireActor(actor).id) };
  }

  /* ------------------------------- oversight ------------------------------ */

  @Get('registry/export')
  @UseGuards(RolesGuard)
  @Roles('regulator', 'admin')
  @ApiOperation({ summary: 'Read-only audit export: receipts, pledges, transfers (regulator/admin)' })
  async exportRegistry(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.warehouse.exportRegistry() };
  }

  @Get('integrations/status')
  @ApiOperation({ summary: 'External-port driver labels (certification feed, collateral registry)' })
  integrationStatus() {
    return { data: this.warehouse.integrationStatus() };
  }
}
