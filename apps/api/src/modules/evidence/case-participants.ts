import { ServiceUnavailableException } from '@nestjs/common';
import type pg from 'pg';
import type { EvidenceCaseType } from '@agric-platform/shared';

/**
 * Evidence Locker case-participant guard (Stage 27 Innovation 13).
 *
 * Uploads are admitted only from a PARTY to the case; the party set is
 * resolved READ-ONLY against the existing case registries (this module
 * never writes to marketplace/vsla/insurance tables):
 *
 *   escrow    -> marketplace.escrow_records joined to marketplace.orders:
 *                the order's buyer_id and seller_id. case_id is the escrow
 *                record id (the order id is also accepted — disputes are
 *                opened against orders and the join disambiguates).
 *   vsla      -> vsla_carbon.vsla_members: ACTIVE members of the group.
 *   insurance -> insurance.policies: the policyholder (farmer_user_id).
 *   pool      -> NO pool registry exists in this tree yet (pool settlement
 *                is a separate in-flight innovation): the lookup returns an
 *                empty party set, so pool cases fail CLOSED (unknown case)
 *                rather than admitting uploads against unverifiable cases.
 *
 * Admins are handled at the service layer (they seal and inspect; they do
 * not gain upload rights here).
 *
 * Fail-closed: when no database pool is wired (in-memory development
 * profile) the lookup answers 503 — case membership cannot be verified,
 * so no evidence can be admitted, mirroring the storage stub doctrine.
 */

export const CASE_PARTICIPANT_LOOKUP = Symbol('CASE_PARTICIPANT_LOOKUP');

export interface CaseParticipantLookup {
  /** Party user ids for the case; EMPTY when the case does not exist. */
  participants(caseType: EvidenceCaseType, caseId: string): Promise<string[]>;
}

const REGISTRY_UNAVAILABLE =
  'Evidence case registry is unavailable (no database pool on this profile) — ' +
  'case membership cannot be verified, so the request fails closed.';

export class UnavailableCaseParticipantLookup implements CaseParticipantLookup {
  participants(): Promise<string[]> {
    return Promise.reject(new ServiceUnavailableException(REGISTRY_UNAVAILABLE));
  }
}

const ESCROW_PARTIES_SQL =
  'SELECT DISTINCT o.buyer_id AS party FROM marketplace.escrow_records e ' +
  'JOIN marketplace.orders o ON o.id = e.order_id WHERE e.id = $1 OR e.order_id = $1 ' +
  'UNION ' +
  'SELECT DISTINCT o.seller_id AS party FROM marketplace.escrow_records e ' +
  'JOIN marketplace.orders o ON o.id = e.order_id WHERE e.id = $1 OR e.order_id = $1';

const VSLA_PARTIES_SQL =
  'SELECT user_id AS party FROM vsla_carbon.vsla_members ' +
  "WHERE group_id = $1 AND status = 'ACTIVE'";

const INSURANCE_PARTIES_SQL =
  'SELECT farmer_user_id AS party FROM insurance.policies WHERE id = $1';

export class SqlCaseParticipantLookup implements CaseParticipantLookup {
  constructor(private readonly pool: pg.Pool) {}

  async participants(caseType: EvidenceCaseType, caseId: string): Promise<string[]> {
    const sql =
      caseType === 'escrow'
        ? ESCROW_PARTIES_SQL
        : caseType === 'vsla'
          ? VSLA_PARTIES_SQL
          : caseType === 'insurance'
            ? INSURANCE_PARTIES_SQL
            : null;
    if (sql === null) {
      // 'pool': no registry in this tree — fail closed as an unknown case.
      return [];
    }
    const result = await this.pool.query(sql, [caseId]);
    return result.rows.map((row) => (row as { party: string }).party);
  }
}

export function createCaseParticipantLookup(pool: pg.Pool | null): CaseParticipantLookup {
  return pool ? new SqlCaseParticipantLookup(pool) : new UnavailableCaseParticipantLookup();
}
