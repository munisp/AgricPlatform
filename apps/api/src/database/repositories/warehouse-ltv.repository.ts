import { ConflictException } from '@nestjs/common';
import type {
  CollateralPosition,
  CollateralPositionStatus,
  LtvObservation
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Stage 27 / Innovation 8: Receipt LTV Guardian persistence ports.
 *
 * Collateral positions use the standard async port (CAS transitions ride
 * updateExpected). LTV observations are APPEND-ONLY evidence: the port
 * deliberately exposes no update/remove surface at all, so no service code
 * path can rewrite history (the pg implementation enforces the same).
 */

/* ----------------------------------------------------- collateral positions -- */

export interface CollateralPositionCriteria {
  receiptId?: string;
  loanId?: string;
  lenderId?: string;
  borrowerId?: string;
  status?: CollateralPositionStatus;
}

export type CollateralPositionRepository = AsyncRepository<
  CollateralPosition,
  CollateralPositionCriteria
>;

/** Statuses in which a position is still being evaluated (one per receipt). */
export const LIVE_POSITION_STATUSES: readonly CollateralPositionStatus[] = [
  'active',
  'margin_call'
];

export function collateralPositionMatcher(
  criteria: CollateralPositionCriteria
): (position: CollateralPosition) => boolean {
  return (position) =>
    (!criteria.receiptId || position.receiptId === criteria.receiptId) &&
    (!criteria.loanId || position.loanId === criteria.loanId) &&
    (!criteria.lenderId || position.lenderId === criteria.lenderId) &&
    (!criteria.borrowerId || position.borrowerId === criteria.borrowerId) &&
    (!criteria.status || position.status === criteria.status);
}

export class InMemoryCollateralPositionRepository
  extends InMemoryRepository<CollateralPosition, CollateralPositionCriteria>
  implements CollateralPositionRepository
{
  constructor(seed: readonly CollateralPosition[] = []) {
    super(seed, collateralPositionMatcher);
  }

  /**
   * Mirrors the pg partial unique index
   * warehouse_collateral_positions_one_active_idx: at most one live
   * (active|margin_call) position per receipt, enforced atomically here so
   * in-memory tests exercise the same invariant the database guarantees.
   */
  override async create(item: CollateralPosition): Promise<CollateralPosition> {
    if (LIVE_POSITION_STATUSES.includes(item.status)) {
      for (const existing of this.items.values()) {
        if (existing.receiptId === item.receiptId && LIVE_POSITION_STATUSES.includes(existing.status)) {
          throw new ConflictException(
            `Receipt '${item.receiptId}' already has a live collateral position`
          );
        }
      }
    }
    return super.create(item);
  }
}

export function createInMemoryCollateralPositionRepository(): InMemoryCollateralPositionRepository {
  return new InMemoryCollateralPositionRepository();
}

/* --------------------------------------------------------- ltv observations -- */

export interface LtvObservationCriteria {
  positionId?: string;
}

/**
 * Append-only observation log port. There is intentionally NO update and NO
 * remove method: observations are the evidence trail for margin-call
 * decisions and must be immutable once written.
 */
export interface LtvObservationRepository {
  append(observation: LtvObservation): Promise<LtvObservation>;
  find(criteria: LtvObservationCriteria): Promise<LtvObservation[]>;
  findById(id: string): Promise<LtvObservation | undefined>;
  all(): Promise<LtvObservation[]>;
}

export class InMemoryLtvObservationRepository implements LtvObservationRepository {
  private readonly items = new Map<string, LtvObservation>();

  constructor(seed: readonly LtvObservation[] = []) {
    for (const observation of seed) {
      this.items.set(observation.id, structuredClone(observation));
    }
  }

  append(observation: LtvObservation): Promise<LtvObservation> {
    if (this.items.has(observation.id)) {
      throw new ConflictException(`LTV observation '${observation.id}' already exists`);
    }
    this.items.set(observation.id, observation);
    return Promise.resolve(observation);
  }

  find(criteria: LtvObservationCriteria): Promise<LtvObservation[]> {
    return Promise.resolve(
      [...this.items.values()].filter(
        (observation) => !criteria.positionId || observation.positionId === criteria.positionId
      )
    );
  }

  findById(id: string): Promise<LtvObservation | undefined> {
    return Promise.resolve(this.items.get(id));
  }

  all(): Promise<LtvObservation[]> {
    return Promise.resolve([...this.items.values()]);
  }
}

export function createInMemoryLtvObservationRepository(): InMemoryLtvObservationRepository {
  return new InMemoryLtvObservationRepository();
}
