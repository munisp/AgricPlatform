import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  CommerceService,
  type AddItemInput,
  type ApplyCouponInput,
  type CreateCouponInput
} from './commerce.service.js';

class AddItemDto implements AddItemInput {
  @IsString()
  @MaxLength(100)
  listingId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class UpdateQuantityDto {
  @IsInt()
  @Min(0)
  quantity!: number;
}

class ApplyCouponDto implements ApplyCouponInput {
  @IsString()
  @MaxLength(64)
  code!: string;
}

class CreateCouponDto implements CreateCouponInput {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  code!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  percentOff?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  amountOffNaira?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSubtotalNaira?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  expiresAt?: string;
}

class CheckoutDto {
  @IsString()
  @MaxLength(100)
  userId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  itemIds?: string[];
}

class AbandonDto {
  @IsString()
  @MaxLength(100)
  userId!: string;
}

/**
 * Cart + coupons (wave P6). Carts are strictly per-user: every read/write
 * is ownership-checked against the authenticated actor. Coupon admin is
 * admin-only; validation and application are user-facing but scoped.
 */
@ApiTags('commerce')
@Controller('commerce')
@UseGuards(RolesGuard)
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Get('cart')
  @Authenticated()
  @ApiOperation({ summary: "Fetch the caller's active cart" })
  async cart(@Query('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.cartFor(userId) };
  }

  @Post('cart/items')
  @Authenticated()
  @ApiOperation({ summary: 'Add a listing to the cart (quantity merges on repeats)' })
  async addItem(
    @Query('userId') userId: string,
    @Body() dto: AddItemDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.addItem(userId, dto) };
  }

  @Patch('cart/items/:itemId')
  @Authenticated()
  @ApiOperation({ summary: 'Update a cart item quantity (0 removes it)' })
  async updateItem(
    @Query('userId') userId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateQuantityDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.updateItemQuantity(userId, itemId, dto.quantity) };
  }

  @Delete('cart/items/:itemId')
  @Authenticated()
  @ApiOperation({ summary: 'Remove an item from the cart' })
  async removeItem(
    @Query('userId') userId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.removeItem(userId, itemId) };
  }

  @Delete('cart')
  @Authenticated()
  @ApiOperation({ summary: 'Clear the cart' })
  async clearCart(@Query('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.clearCart(userId) };
  }

  @Post('cart/coupon')
  @Authenticated()
  @ApiOperation({ summary: 'Apply a coupon code to the cart (single coupon per cart)' })
  async applyCoupon(
    @Query('userId') userId: string,
    @Body() dto: ApplyCouponDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.applyCoupon(userId, dto) };
  }

  @Delete('cart/coupon')
  @Authenticated()
  @ApiOperation({ summary: 'Remove the applied coupon' })
  async removeCoupon(@Query('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.removeCoupon(userId) };
  }

  @Get('cart/pricing')
  @Authenticated()
  @ApiOperation({ summary: 'Server-side cart pricing with coupon discount applied' })
  async pricing(@Query('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.commerce.pricingFor(userId) };
  }

  @Post('cart/checkout')
  @Authenticated()
  @ApiOperation({
    summary:
      'Checkout: converts the cart (or a selected subset) into marketplace orders, redeems the coupon once and clears the cart'
  })
  async checkout(@Body() dto: CheckoutDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.commerce.checkout(dto.userId, actor!, dto.itemIds) };
  }

  @Post('cart/abandon')
  @Authenticated()
  @ApiOperation({ summary: 'Abandon the active cart (recovery automation reads abandoned carts)' })
  async abandon(@Body() dto: AbandonDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.commerce.abandonCart(dto.userId) };
  }

  @Get('coupons')
  @Roles('admin')
  @ApiOperation({ summary: 'List coupons (admin)' })
  async listCoupons() {
    return { data: await this.commerce.listCoupons() };
  }

  @Post('coupons')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a coupon (admin)' })
  async createCoupon(@Body() dto: CreateCouponDto, @CurrentUser() actor: User | null) {
    return { data: await this.commerce.createCoupon(dto, actor!) };
  }

  @Delete('coupons/:code')
  @Roles('admin')
  @ApiOperation({ summary: 'Deactivate a coupon (admin)' })
  async deactivateCoupon(@Param('code') code: string, @CurrentUser() actor: User | null) {
    return { data: await this.commerce.deactivateCoupon(code, actor!) };
  }

  @Post('coupons/validate')
  @Authenticated()
  @ApiOperation({ summary: 'Validate a coupon against a subtotal without mutating the cart' })
  async validateCoupon(@Body() dto: { code: string; subtotalNaira: number }, @CurrentUser() actor: User | null) {
    if (!actor) {
      throw new ForbiddenException('Authentication required');
    }
    return { data: await this.commerce.validateCoupon(dto.code, dto.subtotalNaira) };
  }
}
