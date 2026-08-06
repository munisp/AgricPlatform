import type {
  ParametricPayout,
  ParametricPolicy,
  ParametricPolicyStatus,
  ParametricProduct,
  ParametricTriggerEvent
} from '@agric-platform/shared';
import { ConflictException } from '@nestjs/common';

/**
 * Parametric insurance persistence ports (wave-insurance, migration 031,
 * schema `insurance`). In-memory implementations mirror the pg semantics so
 * unit tests keep full fidelity; production swaps them behind the same port
 * via the DatabaseModule factories. Upsert semantics mirror the unique
 * indexes: products by code, trigger events by (policyId,
 * evidenceFingerprint), payouts by triggerEventId — deterministic
 * re-evaluation is a no-op.
 */

export interface ParametricProductCriteria {
  code?: string;
  peril?: string;
}

export interface ParametricProductRepository {
  /** Insert or replace the row matching the product code (catalog seed). */
  upsert(record: ParametricProduct): Promise<ParametricProduct>;
  find(criteria: ParametricProductCriteria): Promise<ParametricProduct[]>;
  findOne(criteria: ParametricProductCriteria): Promise<ParametricProduct | undefined>;
  findById(id: string): Promise<ParametricProduct | undefined>;
  all(): Promise<ParametricProduct[]>;
}

export function insuranceProductMatcher(
  criteria: ParametricProductCriteria
): (record: ParametricProduct) => boolean {
  return (record) =>
    (!criteria.code || record.code === criteria.code) &&
    (!criteria.peril || record.peril === criteria.peril);
}

export class InMemoryParametricProductRepository implements ParametricProductRepository {
  private readonly items = new Map<string, ParametricProduct>();

  upsert(record: ParametricProduct): Promise<ParametricProduct> {
    const existing = [...this.items.values()].find((item) => item.code === record.code);
    this.items.set(existing?.id ?? record.id, structuredClone(record));
    return Promise.resolve(record);
  }

  find(criteria: ParametricProductCriteria): Promise<ParametricProduct[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insuranceProductMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findOne(criteria: ParametricProductCriteria): Promise<ParametricProduct | undefined> {
    return (await this.find(criteria))[0];
  }

  async findById(id: string): Promise<ParametricProduct | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricProduct[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryParametricProductRepository(): InMemoryParametricProductRepository {
  return new InMemoryParametricProductRepository();
}

// ---------------------------------------------------------------------------

export interface ParametricPolicyCriteria {
  farmerUserId?: string;
  status?: ParametricPolicyStatus;
  season?: string;
  plotId?: string;
}

export interface ParametricPolicyRepository {
  create(record: ParametricPolicy): Promise<ParametricPolicy>;
  update(record: ParametricPolicy): Promise<ParametricPolicy>;
  /**
   * Compare-and-set status transition: applies `patch` only when the stored
   * row still has `expectedStatus`; throws ConflictException (409) otherwise
   * so illegal/concurrent transitions never double-fire.
   */
  transition(
    id: string,
    expectedStatus: ParametricPolicyStatus,
    patch: Partial<ParametricPolicy>
  ): Promise<ParametricPolicy>;
  find(criteria: ParametricPolicyCriteria): Promise<ParametricPolicy[]>;
  findById(id: string): Promise<ParametricPolicy | undefined>;
  all(): Promise<ParametricPolicy[]>;
}

export function insurancePolicyMatcher(
  criteria: ParametricPolicyCriteria
): (record: ParametricPolicy) => boolean {
  return (record) =>
    (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
    (!criteria.status || record.status === criteria.status) &&
    (!criteria.season || record.season === criteria.season) &&
    (!criteria.plotId || record.plotId === criteria.plotId);
}

export class InMemoryParametricPolicyRepository implements ParametricPolicyRepository {
  private readonly items = new Map<string, ParametricPolicy>();

  create(record: ParametricPolicy): Promise<ParametricPolicy> {
    this.items.set(record.id, structuredClone(record));
    return Promise.resolve(record);
  }

  async update(record: ParametricPolicy): Promise<ParametricPolicy> {
    await this.get(record.id);
    this.items.set(record.id, structuredClone(record));
    return record;
  }

  /**
   * Synchronous check-and-set (no await between read and write) so the
   * precondition cannot be defeated by a concurrent transition — mirrors the
   * guarded SQL UPDATE in the pg implementation.
   */
  transition(
    id: string,
    expectedStatus: ParametricPolicyStatus,
    patch: Partial<ParametricPolicy>
  ): Promise<ParametricPolicy> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Insurance policy '${id}' not found`);
    }
    if (current.status !== expectedStatus) {
      throw new ConflictException(
        `Insurance policy '${id}' is '${current.status}', not '${expectedStatus}'`
      );
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return Promise.resolve(structuredClone(next));
  }

  find(criteria: ParametricPolicyCriteria): Promise<ParametricPolicy[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insurancePolicyMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findById(id: string): Promise<ParametricPolicy | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricPolicy[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }

  private async get(id: string): Promise<ParametricPolicy> {
    const item = await this.findById(id);
    if (!item) {
      throw new ConflictException(`Insurance policy '${id}' not found`);
    }
    return item;
  }
}

export function createInMemoryParametricPolicyRepository(): InMemoryParametricPolicyRepository {
  return new InMemoryParametricPolicyRepository();
}

// ---------------------------------------------------------------------------

export interface ParametricTriggerEventCriteria {
  policyId?: string;
  farmerUserId?: string;
  evidenceFingerprint?: string;
}

export interface ParametricTriggerEventRepository {
  /**
   * Insert or return the row matching (policyId, evidenceFingerprint):
   * re-running the deterministic evaluation with unchanged inputs replays
   * the original event instead of duplicating it.
   */
  upsert(record: ParametricTriggerEvent): Promise<{ record: ParametricTriggerEvent; created: boolean }>;
  find(criteria: ParametricTriggerEventCriteria): Promise<ParametricTriggerEvent[]>;
  findById(id: string): Promise<ParametricTriggerEvent | undefined>;
  all(): Promise<ParametricTriggerEvent[]>;
}

export function insuranceTriggerEventMatcher(
  criteria: ParametricTriggerEventCriteria
): (record: ParametricTriggerEvent) => boolean {
  return (record) =>
    (!criteria.policyId || record.policyId === criteria.policyId) &&
    (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
    (!criteria.evidenceFingerprint || record.evidenceFingerprint === criteria.evidenceFingerprint);
}

export class InMemoryParametricTriggerEventRepository implements ParametricTriggerEventRepository {
  private readonly items = new Map<string, ParametricTriggerEvent>();

  upsert(
    record: ParametricTriggerEvent
  ): Promise<{ record: ParametricTriggerEvent; created: boolean }> {
    const existing = [...this.items.values()].find(
      (item) =>
        item.policyId === record.policyId &&
        item.evidenceFingerprint === record.evidenceFingerprint
    );
    if (existing) {
      return Promise.resolve({ record: structuredClone(existing), created: false });
    }
    this.items.set(record.id, structuredClone(record));
    return Promise.resolve({ record, created: true });
  }

  find(criteria: ParametricTriggerEventCriteria): Promise<ParametricTriggerEvent[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insuranceTriggerEventMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findById(id: string): Promise<ParametricTriggerEvent | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricTriggerEvent[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryParametricTriggerEventRepository(): InMemoryParametricTriggerEventRepository {
  return new InMemoryParametricTriggerEventRepository();
}

// ---------------------------------------------------------------------------

export interface ParametricPayoutCriteria {
  policyId?: string;
  farmerUserId?: string;
  status?: ParametricPayout['status'];
  triggerEventId?: string;
}

export interface ParametricPayoutRepository {
  /** Insert or return the row matching triggerEventId (one payout per trigger). */
  upsert(record: ParametricPayout): Promise<{ record: ParametricPayout; created: boolean }>;
  update(record: ParametricPayout): Promise<ParametricPayout>;
  find(criteria: ParametricPayoutCriteria): Promise<ParametricPayout[]>;
  findById(id: string): Promise<ParametricPayout | undefined>;
  all(): Promise<ParametricPayout[]>;
}

export function insurancePayoutMatcher(
  criteria: ParametricPayoutCriteria
): (record: ParametricPayout) => boolean {
  return (record) =>
    (!criteria.policyId || record.policyId === criteria.policyId) &&
    (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
    (!criteria.status || record.status === criteria.status) &&
    (!criteria.triggerEventId || record.triggerEventId === criteria.triggerEventId);
}

export class InMemoryParametricPayoutRepository implements ParametricPayoutRepository {
  private readonly items = new Map<string, ParametricPayout>();

  upsert(record: ParametricPayout): Promise<{ record: ParametricPayout; created: boolean }> {
    const existing = [...this.items.values()].find(
      (item) => item.triggerEventId === record.triggerEventId
    );
    if (existing) {
      return Promise.resolve({ record: structuredClone(existing), created: false });
    }
    this.items.set(record.id, structuredClone(record));
    return Promise.resolve({ record, created: true });
  }

  async update(record: ParametricPayout): Promise<ParametricPayout> {
    const current = this.items.get(record.id);
    if (!current) {
      throw new ConflictException(`Insurance payout '${record.id}' not found`);
    }
    this.items.set(record.id, structuredClone(record));
    return record;
  }

  find(criteria: ParametricPayoutCriteria): Promise<ParametricPayout[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insurancePayoutMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findById(id: string): Promise<ParametricPayout | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricPayout[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryParametricPayoutRepository(): InMemoryParametricPayoutRepository {
  return new InMemoryParametricPayoutRepository();
}
