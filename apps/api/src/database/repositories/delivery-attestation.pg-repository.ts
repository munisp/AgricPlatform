import type pg from 'pg';
import { mapPgError } from '../pg/pg-repository.base.js';
import type { DeliveryAttestation } from '../../modules/marketplace/delivery-attestation.types.js';
import type { DeliveryAttestationRepository } from './delivery-attestation.repository.js';

/**
 * Stage 27 (Innovation 9): pg implementation for
 * marketplace.delivery_attestations (migration 067). APPEND-ONLY — no
 * UPDATE/DELETE statements exist here; the hash chain is the tamper-evidence
 * layer and (escrow_id, seq) / payload_hash uniqueness serializes chain
 * extension (a concurrent append loses with a 409 and must re-read the head).
 */

const ATTESTATION_COLS =
  'id, escrow_id, order_id, seq, attested_by, role, lat, lng, h3_res9, within_geofence, device_basis, attested_at, prev_hash, payload_hash';

function attestationFromRow(row: Record<string, unknown>): DeliveryAttestation {
  const attestedAt = row.attested_at;
  return {
    id: row.id as string,
    escrowId: row.escrow_id as string,
    orderId: row.order_id as string,
    seq: Number(row.seq),
    attestedBy: row.attested_by as string,
    role: row.role as DeliveryAttestation['role'],
    lat: Number(row.lat),
    lng: Number(row.lng),
    h3Res9: row.h3_res9 as string,
    withinGeofence: row.within_geofence as boolean,
    deviceBasis: row.device_basis as DeliveryAttestation['deviceBasis'],
    attestedAt: attestedAt instanceof Date ? attestedAt.toISOString() : String(attestedAt),
    prevHash: row.prev_hash as string,
    payloadHash: row.payload_hash as string
  };
}

export class PgDeliveryAttestationRepository implements DeliveryAttestationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(attestation: DeliveryAttestation): Promise<DeliveryAttestation> {
    try {
      await this.pool.query(
        `INSERT INTO marketplace.delivery_attestations (${ATTESTATION_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          attestation.id,
          attestation.escrowId,
          attestation.orderId,
          attestation.seq,
          attestation.attestedBy,
          attestation.role,
          attestation.lat,
          attestation.lng,
          attestation.h3Res9,
          attestation.withinGeofence,
          attestation.deviceBasis,
          attestation.attestedAt,
          attestation.prevHash,
          attestation.payloadHash
        ]
      );
      return attestation;
    } catch (error) {
      // Unique violations (payload_hash or (escrow_id, seq)) mean a forked or
      // rewritten chain collided with the stored one — surface as a conflict.
      mapPgError(error);
    }
  }

  async findById(id: string): Promise<DeliveryAttestation | undefined> {
    const result = await this.pool.query(
      `SELECT ${ATTESTATION_COLS} FROM marketplace.delivery_attestations WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? attestationFromRow(result.rows[0]) : undefined;
  }

  async listByEscrow(escrowId: string): Promise<DeliveryAttestation[]> {
    const result = await this.pool.query(
      `SELECT ${ATTESTATION_COLS} FROM marketplace.delivery_attestations
       WHERE escrow_id = $1 ORDER BY seq ASC`,
      [escrowId]
    );
    return result.rows.map(attestationFromRow);
  }

  async countByEscrow(escrowId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM marketplace.delivery_attestations WHERE escrow_id = $1',
      [escrowId]
    );
    return result.rows[0].count as number;
  }
}

export function createPgDeliveryAttestationRepository(pool: pg.Pool): PgDeliveryAttestationRepository {
  return new PgDeliveryAttestationRepository(pool);
}
