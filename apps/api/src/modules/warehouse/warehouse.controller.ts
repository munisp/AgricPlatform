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
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min
} from 'class-validator';
import type { User, WarehouseCertificationStatus, WarehouseGrade } from '@agric-platform/shared';
import { WAREHOUSE_CERTIFICATION_STATUSES, WAREHOUSE_GRADES } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  WarehouseService,
  type RegisterWarehouseInput
} from './warehouse.service.js';

class RegisterWarehouseDto implements RegisterWarehouseInput {
  @IsString()
  name!: string;

  @IsString()
  state!: string;

  @IsString()
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
  operatorLicenseRef?: string;
}

class BrowseWarehousesQuery {
  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsIn(WAREHOUSE_CERTIFICATION_STATUSES)
  certificationStatus?: WarehouseCertificationStatus;
}

class CreateDepositDto {
  @IsString()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  lotId?: string;

  @IsString()
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
  terms?: string;
}

class TransferReceiptDto {
  @IsString()
  toOwnerId!: string;

  @IsOptional()
  @IsString()
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
  constructor(private readonly warehouse: WarehouseService) {}

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
