import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnprocessableEntityException
} from '@nestjs/common';
import type { EscrowRecord, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  DELIVERY_ATTESTATION_REPOSITORY,
  ESCROW_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { DeliveryAttestationRepository } from '../../database/repositories/delivery-attestation.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import { H3Service } from '../geo/h3.service.js';
import {
  attestationHashPayloadOf,
  computeAttestationHash,
  GENESIS_PREV_HASH,
  type DeliveryAttestation,
  type DeliveryAttestationRole,
  type DeliveryDeviceBasis
} from './delivery-attestation.types.js';
import { DELIVERY_CONFIRM_WINDOW_MS, EscrowService } from './escrow.service.js';

/** Rollout flag gating every geo-sealed delivery route (default OFF). */
export const GEO_SEALED_DELIVERY_FLAG = 'geo-sealed-delivery';

/**
 * Deployment policy for device basis. When `requireGps` is true
 * (GEO_SEALED_REQUIRE_GPS=true), a manual-basis attestation is recorded
 * honestly but REJECTED (422) and never advances the escrow. Even with
 * requireGps=false, a manual attestation gets no confirm window — manual
 * alone can never auto-release; the buyer must confirm explicitly.
 */
export interface GeoSealedDeliveryOptions {
  requireGps: boolean;
}

export const GEO_SEALED_DELIVERY_OPTIONS = Symbol('GEO_SEALED_DELIVERY_OPTIONS');

export interface AttestDeliveryInput {
  /** Device-signed coordinates. The server — never the client — decides containment. */
  lat: number;
  lng: number;
  deviceBasis: DeliveryDeviceBasis;
}

export interface SetDeliveryPointInput {
  lat: number;
  lng: number;
  /** k-ring radius (cells) around the drop cell; 0 = exact cell. */
  radiusCells?: number;
}

/**
 * Stage 27 (Innovation 9): Geo-Sealed Delivery. Seals the delivery leg of an
 * escrowed order with the in-house H3 stack: the buyer pins a drop point
 * (stored as a res-9 cell — raw coordinates are never persisted on the
 * escrow), then a buyer/agent device attests delivery at that point.
 *
 * Trust doctrine:
 *  - The server NEVER trusts a client-supplied within_geofence claim — the
 *    DTO does not even carry the field; containment is recomputed from the
 *    signed coordinates against the escrow's pinned cell + radius.
 *  - Every attestation (verified or rejected) is appended to a hash-chained,
 *    append-only evidence log (marketplace.delivery_attestations).
 *  - In-geofence attestation moves the escrow held → delivered_pending_confirm
 *    through the CAS-guarded escrow transition machinery; out-of-geofence is
 *    recorded and answered 409 GEO_FENCE_MISMATCH without advancing state.
 */
@Injectable()
export class DeliveryAttestationService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Inject(DELIVERY_ATTESTATION_REPOSITORY)
    private readonly attestations: DeliveryAttestationRepository,
    private readonly escrow: EscrowService,
    private readonly h3: H3Service,
    @Optional() @Inject(GEO_SEALED_DELIVERY_OPTIONS)
    private readonly options: GeoSealedDeliveryOptions = { requireGps: false },
    @Optional() private readonly telemetry?: TelemetryService,
    @Optional() private readonly audit?: AuditService
  ) {}

  /**
   * Buyer pins the agreed drop point at checkout. The res-9 H3 cell is
   * computed HERE from the supplied coordinates; raw lat/lng is used only for
   * the computation and is never stored on the escrow record.
   */
  async setDeliveryPoint(
    orderId: string,
    input: SetDeliveryPointInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<EscrowRecord> {
    const order = await this.orders.getById(orderId);
    if (actor.id !== order.buyerId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the order buyer may set the delivery point');
    }
    this.h3.assertCoordinates(input.lat, input.lng);
    const cell = this.h3.cellAt(input.lat, input.lng, 9);
    return this.escrow.setDeliveryPoint(orderId, cell, input.radiusCells ?? 0, actor.id);
  }

  /**
   * Buyer/agent device attests delivery at the escrow's pinned drop point.
   * The attestation is ALWAYS recorded (evidence), then:
   *  - policy rejection (manual basis while requireGps) → 422, state unchanged;
   *  - server-computed containment fails → 409 GEO_FENCE_MISMATCH, unchanged;
   *  - containment holds → escrow moves to delivered_pending_confirm (CAS; a
   *    concurrent admin refund loses or wins outright — exactly one winner).
   *
   * Span attributes carry within_geofence + device_basis only — never raw
   * lat/lng (telemetry privacy doctrine).
   */
  async attestDelivery(
    escrowId: string,
    input: AttestDeliveryInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<DeliveryAttestation> {
    const escrow = await this.escrows.getById(escrowId);
    const order = await this.orders.getById(escrow.orderId);
    const role: DeliveryAttestationRole | null =
      actor.id === order.buyerId ? 'buyer' : actor.roles.includes('agent') ? 'agent' : null;
    if (!role) {
      throw new ForbiddenException(
        'Only the order buyer or an agent may attest delivery for this escrow'
      );
    }
    this.h3.assertCoordinates(input.lat, input.lng);
    if (!escrow.deliveryPointH3) {
      throw new ConflictException(
        `Escrow ${escrowId} is not geo-sealed; the buyer must set a delivery point first`
      );
    }
    // Server-side containment: the attested cell must fall inside the k-ring
    // around the pinned drop cell. Any client-supplied claim is ignored.
    const cell = this.h3.cellAt(input.lat, input.lng, 9);
    const withinGeofence = this.h3
      .disk(escrow.deliveryPointH3, escrow.geofenceRadiusCells ?? 0)
      .includes(cell);
    const attestation = await this.appendAttestation(escrow, input, role, actor.id, withinGeofence, cell);
    return this.withAttestSpan(attestation, async () => {
      if (this.options.requireGps && input.deviceBasis === 'manual') {
        await this.recordOutcome(attestation, 'device_basis_rejected', false);
        throw new UnprocessableEntityException(
          'DEVICE_BASIS_REJECTED: manual-basis attestation is not accepted under the gps-required policy'
        );
      }
      if (!withinGeofence) {
        await this.recordOutcome(attestation, 'geo_rejected', false);
        throw new ConflictException(
          `GEO_FENCE_MISMATCH: the attested location is outside the delivery geofence for escrow ${escrowId}; the attestation was recorded and the escrow state did not advance`
        );
      }
      // Manual basis advances the state but gets NO confirm window: policy
      // requires an explicit buyer confirm — manual alone never auto-releases.
      await this.escrow.markDeliveredPendingConfirm(
        escrowId,
        actor.id,
        input.deviceBasis === 'manual' ? undefined : DELIVERY_CONFIRM_WINDOW_MS
      );
      await this.recordOutcome(attestation, 'verified', true);
      return attestation;
    });
  }

  /**
   * Attestations of one escrow in chain order (dispute evidence surface).
   * Order parties or admin only.
   */
  async attestationsForEscrow(
    escrowId: string,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<DeliveryAttestation[]> {
    const escrow = await this.escrows.getById(escrowId);
    const order = await this.orders.getById(escrow.orderId);
    if (
      !actor.roles.includes('admin') &&
      actor.id !== order.buyerId &&
      actor.id !== order.sellerId
    ) {
      throw new ForbiddenException(
        'Only the order parties or an admin may read delivery attestations'
      );
    }
    return this.attestations.listByEscrow(escrowId);
  }

  /**
   * Runs the outcome inside the marketplace.delivery.attest span. Attributes
   * are the verdict and device basis only — raw coordinates are NEVER span
   * attributes (the hash-chained row is the audit-grade location record).
   */
  private async withAttestSpan<T>(
    attestation: DeliveryAttestation,
    fn: () => Promise<T>
  ): Promise<T> {
    const attributes = {
      within_geofence: attestation.withinGeofence,
      device_basis: attestation.deviceBasis
    };
    if (!this.telemetry) {
      return fn();
    }
    return this.telemetry.withSpan('marketplace.delivery.attest', attributes, fn);
  }

  private async recordOutcome(
    attestation: DeliveryAttestation,
    result: 'verified' | 'geo_rejected' | 'device_basis_rejected',
    verified: boolean
  ): Promise<void> {
    this.telemetry?.increment('marketplace.delivery_attestations_total', 1, { result });
    await this.events.publish(
      'marketplace.delivery.attested',
      {
        attestationId: attestation.id,
        escrowId: attestation.escrowId,
        orderId: attestation.orderId,
        withinGeofence: attestation.withinGeofence,
        deviceBasis: attestation.deviceBasis,
        result
      },
      attestation.attestedBy
    );
    await this.events.publish(
      verified ? 'marketplace.delivery.geo_verified' : 'marketplace.delivery.geo_rejected',
      {
        attestationId: attestation.id,
        escrowId: attestation.escrowId,
        orderId: attestation.orderId
      },
      attestation.attestedBy
    );
    await this.audit?.record({
      actorId: attestation.attestedBy,
      action: `marketplace.delivery.${result}`,
      entityType: 'delivery_attestation',
      entityId: attestation.id,
      metadata: {
        escrowId: attestation.escrowId,
        orderId: attestation.orderId,
        h3Res9: attestation.h3Res9,
        withinGeofence: attestation.withinGeofence,
        deviceBasis: attestation.deviceBasis
      }
    });
  }

  /** Appends a hash-chained attestation (seq = chain length, prev = head). */
  private async appendAttestation(
    escrow: EscrowRecord,
    input: AttestDeliveryInput,
    role: DeliveryAttestationRole,
    actorId: string,
    withinGeofence: boolean,
    h3Res9: string
  ): Promise<DeliveryAttestation> {
    const seq = await this.attestations.countByEscrow(escrow.id);
    const trail = seq > 0 ? await this.attestations.listByEscrow(escrow.id) : [];
    const prevHash = seq > 0 ? trail[trail.length - 1].payloadHash : GENESIS_PREV_HASH;
    const unsigned = {
      escrowId: escrow.id,
      orderId: escrow.orderId,
      seq,
      attestedBy: actorId,
      role,
      lat: input.lat,
      lng: input.lng,
      h3Res9,
      withinGeofence,
      deviceBasis: input.deviceBasis,
      attestedAt: new Date().toISOString(),
      prevHash
    };
    const attestation: DeliveryAttestation = {
      id: newId('dlat'),
      ...unsigned,
      payloadHash: computeAttestationHash(attestationHashPayloadOf(unsigned))
    };
    return this.attestations.append(attestation);
  }
}
