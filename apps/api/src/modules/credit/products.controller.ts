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
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { CreditService, type CreateCreditProductInput } from './credit.service.js';

class CreateProductDto implements CreateCreditProductInput {
  @IsString()
  name!: string;

  @IsInt()
  @Min(0)
  minPrincipalKobo!: number;

  @IsInt()
  @Min(0)
  maxPrincipalKobo!: number;

  @IsInt()
  @Min(0)
  interestBpsAnnual!: number;

  @IsInt()
  @Min(1)
  termDays!: number;

  @IsOptional()
  @IsBoolean()
  groupLending?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minPrincipalKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxPrincipalKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  interestBpsAnnual?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  termDays?: number;

  @IsOptional()
  @IsBoolean()
  groupLending?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/** Loan product catalogue: public list, admin-managed. */
@ApiTags('credit')
@Controller('credit/products')
export class CreditProductsController {
  constructor(private readonly credit: CreditService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List loan products (active by default)' })
  async list(@Query('all') all?: string) {
    return { data: await this.credit.listProducts(all !== 'true') };
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Loan product detail' })
  async get(@Param('id') id: string) {
    return { data: await this.credit.getProduct(id) };
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a loan product (admin)' })
  async create(@Body() dto: CreateProductDto, @CurrentUser() actor: User | null) {
    return { data: await this.credit.createProduct(dto, requireActor(actor)) };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Update a loan product (admin)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.updateProduct(id, dto, requireActor(actor)) };
  }
}
