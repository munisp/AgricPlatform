import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  DeliveryAttestationService,
  GEO_SEALED_DELIVERY_FLAG,
  type AttestDeliveryInput,
  type SetDeliveryPointInput
} from './delivery-attestation.service.js';
import { DELIVERY_DEVICE_BASES } from './delivery-attestation.types.js';
import { EscrowService } from './escrow.service.js';

class SetDeliveryPointDto implements SetDeliveryPointInput {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  /** k-ring radius (cells); 0 = the exact drop cell. Bounded fail-closed. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  radiusCells?: number;
}

class AttestDeliveryDto implements AttestDeliveryInput {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsIn(DELIVERY_DEVICE_BASES)
  deviceBasis!: AttestDeliveryInput['deviceBasis'];

  // NOTE: there is deliberately NO within_geofence field. Containment is
  // recomputed server-side from the signed coordinates; a client-supplied
  // claim would never be trusted.
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Stage 27 (Innovation 9): Geo-Sealed Delivery routes. Every route is gated
 * behind the `geo-sealed-delivery` rollout flag (fail-closed 404 while off).
 */
@ApiTags('marketplace')
@Controller()
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryAttestationService,
    private readonly escrow: EscrowService
  ) {}

  @Post('orders/:id/delivery-point')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Authenticated()
  @RequiresFeature(GEO_SEALED_DELIVERY_FLAG)
  @ApiOperation({
    summary:
      'Pin the agreed delivery drop point for the order escrow (buyer; server computes the res-9 H3 cell; opt-in)'
  })
  async setDeliveryPoint(
    @Param('id') orderId: string,
    @Body() dto: SetDeliveryPointDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.delivery.setDeliveryPoint(orderId, dto, requireActor(actor)) };
  }

  @Post('escrow/:id/attest-delivery')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Authenticated()
  @RequiresFeature(GEO_SEALED_DELIVERY_FLAG)
  @ApiOperation({
    summary:
      'Attest delivery at the pinned drop point (buyer/agent device; containment recomputed server-side — 409 GEO_FENCE_MISMATCH when outside)'
  })
  async attestDelivery(
    @Param('id') escrowId: string,
    @Body() dto: AttestDeliveryDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.delivery.attestDelivery(escrowId, dto, requireActor(actor)) };
  }

  @Get('escrow/:id/delivery-attestations')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Authenticated()
  @RequiresFeature(GEO_SEALED_DELIVERY_FLAG)
  @ApiOperation({
    summary:
      'Hash-chained delivery attestations for an escrow in chain order (order parties or admin; dispute evidence)'
  })
  async attestationsForEscrow(@Param('id') escrowId: string, @CurrentUser() actor: User | null) {
    return { data: await this.delivery.attestationsForEscrow(escrowId, requireActor(actor)) };
  }

  /**
   * Deterministic confirm-window sweep (Stage 27, Innovation 9): every
   * delivered_pending_confirm escrow past its confirm deadline is
   * auto-released through the same guarded transition machinery as the expiry
   * sweep. Distinct from POST /escrow/expire — held_until expiry semantics
   * are unchanged. Admin-triggered; safe to run repeatedly.
   */
  @Post('escrow/delivery-confirm-sweep')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin')
  @RequiresFeature(GEO_SEALED_DELIVERY_FLAG)
  @ApiOperation({
    summary: 'Auto-release geo-sealed escrows past the confirm window (admin; idempotent)'
  })
  async sweepDeliveryConfirm(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.escrow.releaseDeliveredEscrows() };
  }
}
