import { ConflictException } from '@nestjs/common';
import type { DeliveryAttestation } from '../../modules/marketplace/delivery-attestation.types.js';

/**
 * Stage 27 (Innovation 9): delivery attestation store
 * (marketplace.delivery_attestations, migration 067).
 *
 * APPEND-ONLY: the port deliberately exposes no update/remove — history is
 * tamper-evident via the per-escrow hash chain (seq + prev_hash +
 * payload_hash); a rewritten history collides on the (escrow_id, seq) or
 * payload_hash uniqueness and surfaces as a conflict.
 */
export interface DeliveryAttestationRepository {
  /**
   * Appends an attestation. Throws ConflictException when the payload_hash or
   * the (escrow_id, seq) pair already exists — a rewritten/forked chain
   * collides here.
   */
  append(attestation: DeliveryAttestation): Promise<DeliveryAttestation>;
  findById(id: string): Promise<DeliveryAttestation | undefined>;
  /** Attestations of one escrow in chain order (ascending seq). */
  listByEscrow(escrowId: string): Promise<DeliveryAttestation[]>;
  /** Current chain length for an escrow (next seq). */
  countByEscrow(escrowId: string): Promise<number>;
}

export class InMemoryDeliveryAttestationRepository implements DeliveryAttestationRepository {
  private readonly items = new Map<string, DeliveryAttestation>();

  constructor(seed: readonly DeliveryAttestation[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async append(attestation: DeliveryAttestation): Promise<DeliveryAttestation> {
    for (const existing of this.items.values()) {
      if (existing.payloadHash === attestation.payloadHash) {
        throw new ConflictException('A delivery attestation with this payload_hash already exists');
      }
      if (existing.escrowId === attestation.escrowId && existing.seq === attestation.seq) {
        throw new ConflictException(
          `Delivery attestation seq ${attestation.seq} already exists for escrow '${attestation.escrowId}'`
        );
      }
    }
    this.items.set(attestation.id, structuredClone(attestation));
    return attestation;
  }

  async findById(id: string): Promise<DeliveryAttestation | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async listByEscrow(escrowId: string): Promise<DeliveryAttestation[]> {
    return [...this.items.values()]
      .filter((attestation) => attestation.escrowId === escrowId)
      .sort((a, b) => a.seq - b.seq)
      .map((attestation) => structuredClone(attestation));
  }

  async countByEscrow(escrowId: string): Promise<number> {
    return [...this.items.values()].filter((attestation) => attestation.escrowId === escrowId)
      .length;
  }
}

export function createInMemoryDeliveryAttestationRepository(
  seed: readonly DeliveryAttestation[] = []
): InMemoryDeliveryAttestationRepository {
  return new InMemoryDeliveryAttestationRepository(seed);
}
