import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import {
  ESCROW_STATUSES,
  INVOICE_STATUSES,
  SHIPMENT_STATUSES,
  type EscrowStatus,
  type InvoiceStatus,
  type ShipmentStatus,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertPartyOrAdmin, assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { LogisticsService, type SchedulePickupInput } from './logistics.service.js';
import { MarketplaceService } from './marketplace.service.js';

class EscrowStatusDto {
  @IsIn(ESCROW_STATUSES)
  status!: EscrowStatus;
}

class InvoiceStatusDto {
  @IsIn(INVOICE_STATUSES)
  status!: InvoiceStatus;
}

class SchedulePickupDto implements SchedulePickupInput {
  @IsOptional()
  @IsString()
  carrier?: string;

  @IsOptional()
  @IsString()
  trackingReference?: string;

  @IsOptional()
  @IsISO8601()
  scheduledPickupAt?: string;
}

class ShipmentStatusDto {
  @IsIn(SHIPMENT_STATUSES)
  status!: ShipmentStatus;

  @IsOptional()
  @IsString()
  failureReason?: string;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/** Wave P2a marketplace depth: escrow, invoicing, logistics coordination. */
@ApiTags('marketplace')
@Controller()
export class CommerceController {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly escrow: EscrowService,
    private readonly invoices: InvoiceService,
    private readonly logistics: LogisticsService
  ) {}

  @Post('orders/:id/escrow')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Hold the order total in escrow (buyer or admin; idempotent per order)' })
  async holdEscrow(@Param('id') orderId: string, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    const order = await this.marketplace.getOrder(orderId);
    assertSelfOrAdmin(user, order.buyerId);
    return { data: await this.escrow.holdForOrder(orderId, user.id) };
  }

  @Get('orders/:id/escrow')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Escrow record for an order (order parties or admin)' })
  async escrowForOrder(@Param('id') orderId: string, @CurrentUser() actor: User | null) {
    const order = await this.marketplace.getOrder(orderId);
    assertPartyOrAdmin(actor, [order.buyerId, order.sellerId]);
    return { data: (await this.escrow.escrowForOrder(orderId)) ?? null };
  }

  /**
   * Deterministic escrow expiry sweep (funds-integrity wave): every held
   * escrow past its heldUntil deadline is auto-refunded through the guarded
   * transition machinery. Admin-triggered; safe to run repeatedly.
   */
  @Post('escrow/expire')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Auto-refund all expired escrow holds (admin; idempotent)' })
  async expireEscrows(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.escrow.expireHeldEscrows() };
  }

  @Patch('escrow/:id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Transition an escrow (state machine enforced, actor-scoped)' })
  async transitionEscrow(
    @Param('id') id: string,
    @Body() dto: EscrowStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.escrow.transition(id, dto.status, requireActor(actor)) };
  }

  @Post('orders/:id/invoice')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Issue the invoice for an order (seller or admin; idempotent per order)' })
  async issueInvoice(@Param('id') orderId: string, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    const order = await this.marketplace.getOrder(orderId);
    assertSelfOrAdmin(user, order.sellerId);
    return { data: await this.invoices.issueForOrder(orderId, user.id) };
  }

  @Get('invoices')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List invoices by seller, buyer or status (own records or admin)' })
  async listInvoices(
    @CurrentUser() actor: User | null,
    @Query('sellerId') sellerId?: string,
    @Query('buyerId') buyerId?: string,
    @Query('status') status?: InvoiceStatus
  ) {
    const user = requireActor(actor);
    if (!user.roles.includes('admin') && sellerId !== user.id && buyerId !== user.id) {
      assertSelfOrAdmin(user, sellerId ?? buyerId ?? '');
    }
    return { data: await this.invoices.list({ sellerId, buyerId, status }) };
  }

  @Get('invoices/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Invoice detail (invoice parties or admin)' })
  async getInvoice(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const invoice = await this.invoices.getById(id);
    assertPartyOrAdmin(actor, [invoice.buyerId, invoice.sellerId]);
    return { data: invoice };
  }

  @Get('invoices/:id/serialised')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'PDF-ready invoice serialisation (invoice parties or admin)' })
  async serialiseInvoice(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const invoice = await this.invoices.getById(id);
    assertPartyOrAdmin(actor, [invoice.buyerId, invoice.sellerId]);
    return { data: await this.invoices.serialise(id) };
  }

  @Patch('invoices/:id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Transition an invoice status (state machine enforced, actor-scoped)' })
  async transitionInvoice(
    @Param('id') id: string,
    @Body() dto: InvoiceStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.invoices.transition(id, dto.status, requireActor(actor)) };
  }

  @Post('orders/:id/shipment')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Schedule pickup for an order (seller; one shipment per order)' })
  async schedulePickup(
    @Param('id') orderId: string,
    @Body() dto: SchedulePickupDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.logistics.schedulePickup(orderId, dto, requireActor(actor)) };
  }

  @Get('orders/:id/shipment')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Shipment for an order (order parties or admin)' })
  async shipmentForOrder(@Param('id') orderId: string, @CurrentUser() actor: User | null) {
    const order = await this.marketplace.getOrder(orderId);
    assertPartyOrAdmin(actor, [order.buyerId, order.sellerId]);
    return { data: (await this.logistics.shipmentForOrder(orderId)) ?? null };
  }

  @Patch('shipments/:id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Transition a shipment (delivery confirmation releases escrow)' })
  async transitionShipment(
    @Param('id') id: string,
    @Body() dto: ShipmentStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.logistics.transition(id, dto.status, requireActor(actor), dto.failureReason)
    };
  }
}
