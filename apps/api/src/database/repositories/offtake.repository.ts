import { ConflictException, NotFoundException } from '@nestjs/common';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import type {
  OfftakeContract,
  OfftakeContractStatus,
  OfftakeDelivery,
  OfftakeMilestone
} from '../../modules/marketplace/offtake.js';

/**
 * Harvest Forward Contracts persistence ports (Stage 27 Batch 3,
 * Innovation 18) over infra/postgres/077_offtake_contracts.sql:
 * marketplace.offtake_contracts / offtake_milestones / offtake_deliveries.
 *
 * The pg implementation owns the delivery-saga transaction
 * (recordDeliveryTx): contract re-verification + delivery idempotency claim
 * + milestone guarded accumulation + the balanced escrow-hold ledger
 * journal + fulfilment CAS + the outbox events commit in ONE database
 * transaction. The in-memory implementation keeps the same semantics
 * synchronously for unit tests / dev without DATABASE_URL: the delivery
 * idempotency-key claim is the arbiter and OfftakeService posts the journal
 * through LedgerService (idempotency-keyed) before finalizing state.
 */

export interface OfftakeContractCriteria {
  cooperativeId?: string;
  buyerOrgId?: string;
  status?: OfftakeContractStatus;
  idempotencyKey?: string;
}

/** Everything the delivery transaction persists atomically (pg path). */
export interface OfftakeDeliveryTxInput {
  contractId: string;
  milestoneId: string;
  delivery: OfftakeDelivery;
  /** New accumulated delivered_qty_kg + derived status + evidence links. */
  milestonePatch: {
    deliveredQtyKg: number;
    status: OfftakeMilestone['status'];
    linkedLotId: string;
    invoiceId?: string;
    escrowId?: string;
  };
  /** Balanced escrow-hold journal (DR buyer escrow asset, CR contract liability). */
  entry: LedgerJournalEntry;
  /**
   * Builds the outbox events from the COMMITTED milestone state (called
   * inside the transaction, after the accumulation CAS and the fulfilment
   * CAS) so milestone_met/fulfilled are never emitted from a stale pre-read.
   * The built events are appended to events.outbox in the same transaction.
   */
  buildEvents: (result: { milestone: OfftakeMilestone; fulfilled: boolean }) => DomainEvent[];
}

export interface OfftakeContractRepository
  extends AsyncRepository<OfftakeContract, OfftakeContractCriteria> {
  /**
   * True when recordDeliveryTx persists the delivery claim + milestone
   * accumulation + ledger journal + state + outbox events in one database
   * transaction (PostgreSQL implementation).
   */
  readonly transactionalDelivery?: boolean;

  /** Milestones are created with the contract (UNIQUE (contract_id, seq)). */
  addMilestones(milestones: readonly OfftakeMilestone[]): Promise<void>;
  /** Milestones of a contract, ordered by seq. */
  listMilestones(contractId: string): Promise<OfftakeMilestone[]>;
  /** One milestone by (contractId, seq); undefined when absent. */
  milestoneBySeq(contractId: string, seq: number): Promise<OfftakeMilestone | undefined>;
  /** The milestone linked to an escrow record, if any (settlement consumer). */
  milestoneByEscrowId(escrowId: string): Promise<OfftakeMilestone | undefined>;
  /** Deliveries of a contract, in recording order. */
  listDeliveries(contractId: string): Promise<OfftakeDelivery[]>;
  /** Replay lookup for the delivery idempotency key. */
  deliveryByIdempotencyKey(idempotencyKey: string): Promise<OfftakeDelivery | undefined>;
  /** Non-transactional delivery insert (in-memory path; the key is the arbiter). */
  addDelivery(delivery: OfftakeDelivery): Promise<OfftakeDelivery>;

  /**
   * Non-transactional milestone write (in-memory path + the missed/defaulted
   * sweep). Guarded: `expected` preconditions must still hold, else 409.
   */
  updateMilestoneExpected(
    id: string,
    patch: Partial<OfftakeMilestone>,
    expected: Partial<OfftakeMilestone>
  ): Promise<OfftakeMilestone>;

  /**
   * PostgreSQL-only single-transaction delivery saga step. Returns
   * 'applied' when this call committed the delivery, 'replay' when the
   * idempotency key was already committed (nothing is re-posted).
   */
  recordDeliveryTx?(input: OfftakeDeliveryTxInput): Promise<'applied' | 'replay'>;
}

export function offtakeContractMatcher(
  criteria: OfftakeContractCriteria
): (contract: OfftakeContract) => boolean {
  return (contract) =>
    (!criteria.cooperativeId || contract.cooperativeId === criteria.cooperativeId) &&
    (!criteria.buyerOrgId || contract.buyerOrgId === criteria.buyerOrgId) &&
    (!criteria.status || contract.status === criteria.status) &&
    (!criteria.idempotencyKey || contract.idempotencyKey === criteria.idempotencyKey);
}

function matchesMilestone(
  milestone: OfftakeMilestone,
  expected: Partial<OfftakeMilestone>
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => (milestone as unknown as Record<string, unknown>)[key] === value
  );
}

export class InMemoryOfftakeContractRepository
  extends InMemoryRepository<OfftakeContract, OfftakeContractCriteria>
  implements OfftakeContractRepository
{
  private readonly milestones = new Map<string, OfftakeMilestone>();
  private readonly deliveries = new Map<string, OfftakeDelivery>();

  constructor(seed: readonly OfftakeContract[] = []) {
    super(seed, offtakeContractMatcher);
  }

  /** Milestones are created with the contract (saga setup, not a mutation). */
  async addMilestones(milestones: readonly OfftakeMilestone[]): Promise<void> {
    for (const milestone of milestones) {
      const duplicate = [...this.milestones.values()].some(
        (existing) =>
          existing.contractId === milestone.contractId && existing.seq === milestone.seq
      );
      if (duplicate) {
        // Mirror the UNIQUE (contract_id, seq) index (23505 → 409).
        throw new ConflictException(
          `Milestone seq ${milestone.seq} already exists for contract '${milestone.contractId}'`
        );
      }
      this.milestones.set(milestone.id, structuredClone(milestone));
    }
  }

  async listMilestones(contractId: string): Promise<OfftakeMilestone[]> {
    return [...this.milestones.values()]
      .filter((milestone) => milestone.contractId === contractId)
      .sort((a, b) => a.seq - b.seq)
      .map((milestone) => structuredClone(milestone));
  }

  async milestoneBySeq(
    contractId: string,
    seq: number
  ): Promise<OfftakeMilestone | undefined> {
    const found = [...this.milestones.values()].find(
      (milestone) => milestone.contractId === contractId && milestone.seq === seq
    );
    return found ? structuredClone(found) : undefined;
  }

  async milestoneByEscrowId(escrowId: string): Promise<OfftakeMilestone | undefined> {
    const found = [...this.milestones.values()].find(
      (milestone) => milestone.escrowId === escrowId
    );
    return found ? structuredClone(found) : undefined;
  }

  async listDeliveries(contractId: string): Promise<OfftakeDelivery[]> {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.contractId === contractId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((delivery) => structuredClone(delivery));
  }

  async deliveryByIdempotencyKey(idempotencyKey: string): Promise<OfftakeDelivery | undefined> {
    const found = [...this.deliveries.values()].find(
      (delivery) => delivery.idempotencyKey === idempotencyKey
    );
    return found ? structuredClone(found) : undefined;
  }

  /** Non-transactional delivery insert (in-memory path; the key is the arbiter). */
  async addDelivery(delivery: OfftakeDelivery): Promise<OfftakeDelivery> {
    if (
      delivery.idempotencyKey &&
      (await this.deliveryByIdempotencyKey(delivery.idempotencyKey))
    ) {
      throw new ConflictException(
        `Delivery idempotency key '${delivery.idempotencyKey}' was already recorded`
      );
    }
    this.deliveries.set(delivery.id, structuredClone(delivery));
    return structuredClone(delivery);
  }

  async updateMilestoneExpected(
    id: string,
    patch: Partial<OfftakeMilestone>,
    expected: Partial<OfftakeMilestone>
  ): Promise<OfftakeMilestone> {
    const existing = this.milestones.get(id);
    if (!existing) {
      throw new NotFoundException(`Offtake milestone '${id}' not found`);
    }
    if (!matchesMilestone(existing, expected)) {
      throw new ConflictException(
        `Concurrent state change on offtake milestone '${id}'; re-read and retry the operation`
      );
    }
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.milestones.set(id, updated);
    return structuredClone(updated);
  }
}

export function createInMemoryOfftakeContractRepository(
  seed: readonly OfftakeContract[] = []
): InMemoryOfftakeContractRepository {
  return new InMemoryOfftakeContractRepository(seed);
}
