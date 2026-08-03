import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * NDPA 2023 compliance tooling persistence (Wave COMP, migration 021).
 *
 * These ports back the compliance module (versioned consent capture,
 * data-subject export/erasure workflow, retention sweeper). They are
 * deliberately NOT the legacy privacy ports (privacy.consent_records /
 * privacy.data_requests): the compliance schema adds policy versioning and a
 * four-state DSR workflow, and the retention sweeper needs set-level
 * anonymise/purge operations that the generic AsyncRepository port does not
 * express. Both implementations (in-memory below, pg in
 * compliance.pg-repository.ts) must stay behaviourally identical.
 */

// ---------------------------------------------------------------------------
// Consent records (compliance.consent_records)
// ---------------------------------------------------------------------------

export interface ComplianceConsentRecord {
  id: string;
  userId: string;
  purpose: string;
  /** Version of the privacy/consent policy text the user agreed to. */
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string;
  source: string;
}

export interface ComplianceConsentRepository {
  create(record: ComplianceConsentRecord): Promise<ComplianceConsentRecord>;
  findById(id: string): Promise<ComplianceConsentRecord | undefined>;
  /** All consent decisions for a user, oldest first. */
  findByUser(userId: string): Promise<ComplianceConsentRecord[]>;
  /** Latest still-active (not revoked) grant for (user, purpose), if any. */
  findActive(userId: string, purpose: string): Promise<ComplianceConsentRecord | undefined>;
  /**
   * Stamps revoked_at on the record. Throws NotFoundException when the id
   * does not exist and BadRequestException when it is already revoked.
   */
  revoke(id: string, revokedAt: string): Promise<ComplianceConsentRecord>;
  /** Retention sweeper: counts revoked records whose revoked_at < cutoff. */
  countRevokedBefore(cutoff: string): Promise<number>;
  /**
   * Retention sweeper: pseudonymises user_id on revoked records older than
   * the cutoff (consent history is the controller's proof of lawful basis,
   * so the row survives with the personal reference scrubbed).
   * `pseudonymFor` maps a user id onto its tombstone. Returns rows changed.
   */
  anonymizeRevokedBefore(
    cutoff: string,
    pseudonymFor: (userId: string) => string
  ): Promise<number>;
  /** Retention sweeper: hard-deletes revoked records older than the cutoff. */
  purgeRevokedBefore(cutoff: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Data subject requests (compliance.data_subject_requests)
// ---------------------------------------------------------------------------

export type DataSubjectRequestType = 'export' | 'erasure';
export type DataSubjectRequestStatus = 'pending' | 'processing' | 'completed' | 'rejected';

export interface DataSubjectRequest {
  id: string;
  userId: string;
  type: DataSubjectRequestType;
  status: DataSubjectRequestStatus;
  requestedAt: string;
  completedAt?: string;
  /** Export: sha256 of the payload. Erasure: audit event id of the anonymisation. */
  resultRef?: string;
  /** Rejection reason / operator note. */
  note?: string;
}

export interface DataSubjectRequestRepository {
  create(request: DataSubjectRequest): Promise<DataSubjectRequest>;
  findById(id: string): Promise<DataSubjectRequest | undefined>;
  getById(id: string): Promise<DataSubjectRequest>;
  findByUser(userId: string): Promise<DataSubjectRequest[]>;
  update(id: string, patch: Partial<DataSubjectRequest>): Promise<DataSubjectRequest>;
  /** Retention sweeper: closed requests (completed|rejected) completed before the cutoff. */
  countClosedBefore(cutoff: string): Promise<number>;
  /** Retention sweeper: pseudonymises user_id on closed requests older than the cutoff. */
  anonymizeClosedBefore(cutoff: string, pseudonymFor: (userId: string) => string): Promise<number>;
  /** Retention sweeper: hard-deletes closed requests older than the cutoff. */
  purgeClosedBefore(cutoff: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Retention policies (compliance.retention_policies)
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  /** Entity key handled by the sweeper, e.g. 'compliance.consent_records'. */
  entity: string;
  retainDays: number;
  /** true = pseudonymise the user reference; false = hard-delete rows. */
  anonymizeNotDelete: boolean;
  updatedAt: string;
}

export interface RetentionPolicyRepository {
  list(): Promise<RetentionPolicy[]>;
  findByEntity(entity: string): Promise<RetentionPolicy | undefined>;
  upsert(policy: RetentionPolicy): Promise<RetentionPolicy>;
}

/**
 * Default policies mirrored by migration 021's seed rows and documented in
 * docs/compliance/retention-policy.md. TEMPLATE values — a qualified DPO
 * must confirm them against the organisation's retention schedule.
 */
export const DEFAULT_RETENTION_POLICIES: ReadonlyArray<Omit<RetentionPolicy, 'updatedAt'>> = [
  { entity: 'compliance.consent_records', retainDays: 730, anonymizeNotDelete: true },
  { entity: 'compliance.data_subject_requests', retainDays: 1095, anonymizeNotDelete: true },
  { entity: 'notifications.messages', retainDays: 365, anonymizeNotDelete: false }
];

// ---------------------------------------------------------------------------
// In-memory implementations (default when DATABASE_URL is not configured)
// ---------------------------------------------------------------------------

export class InMemoryComplianceConsentRepository implements ComplianceConsentRepository {
  private readonly records = new Map<string, ComplianceConsentRecord>();

  constructor(seed: readonly ComplianceConsentRecord[] = []) {
    for (const record of seed) {
      this.records.set(record.id, { ...record });
    }
  }

  async create(record: ComplianceConsentRecord): Promise<ComplianceConsentRecord> {
    if (this.records.has(record.id)) {
      throw new BadRequestException(`Consent record '${record.id}' already exists`);
    }
    this.records.set(record.id, { ...record });
    return { ...record };
  }

  async findById(id: string): Promise<ComplianceConsentRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async findByUser(userId: string): Promise<ComplianceConsentRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt))
      .map((record) => ({ ...record }));
  }

  async findActive(
    userId: string,
    purpose: string
  ): Promise<ComplianceConsentRecord | undefined> {
    const active = [...this.records.values()]
      .filter((record) => record.userId === userId && record.purpose === purpose && !record.revokedAt)
      .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
    return active[0] ? { ...active[0] } : undefined;
  }

  async revoke(id: string, revokedAt: string): Promise<ComplianceConsentRecord> {
    const record = this.records.get(id);
    if (!record) {
      throw new NotFoundException(`Consent record '${id}' not found`);
    }
    if (record.revokedAt) {
      throw new BadRequestException(`Consent record '${id}' is already revoked`);
    }
    const updated = { ...record, revokedAt };
    this.records.set(id, updated);
    return { ...updated };
  }

  async countRevokedBefore(cutoff: string): Promise<number> {
    return [...this.records.values()].filter(
      (record) => record.revokedAt && record.revokedAt < cutoff
    ).length;
  }

  async anonymizeRevokedBefore(
    cutoff: string,
    pseudonymFor: (userId: string) => string
  ): Promise<number> {
    let changed = 0;
    for (const [id, record] of this.records) {
      if (record.revokedAt && record.revokedAt < cutoff) {
        const tombstone = pseudonymFor(record.userId);
        if (tombstone === record.userId) continue;
        this.records.set(id, { ...record, userId: tombstone });
        changed += 1;
      }
    }
    return changed;
  }

  async purgeRevokedBefore(cutoff: string): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.revokedAt && record.revokedAt < cutoff) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

export function createInMemoryComplianceConsentRepository(): InMemoryComplianceConsentRepository {
  return new InMemoryComplianceConsentRepository();
}

export class InMemoryDataSubjectRequestRepository implements DataSubjectRequestRepository {
  private readonly requests = new Map<string, DataSubjectRequest>();

  constructor(seed: readonly DataSubjectRequest[] = []) {
    for (const request of seed) {
      this.requests.set(request.id, { ...request });
    }
  }

  async create(request: DataSubjectRequest): Promise<DataSubjectRequest> {
    if (this.requests.has(request.id)) {
      throw new BadRequestException(`Data subject request '${request.id}' already exists`);
    }
    this.requests.set(request.id, { ...request });
    return { ...request };
  }

  async findById(id: string): Promise<DataSubjectRequest | undefined> {
    const request = this.requests.get(id);
    return request ? { ...request } : undefined;
  }

  async getById(id: string): Promise<DataSubjectRequest> {
    const request = await this.findById(id);
    if (!request) {
      throw new NotFoundException(`Data subject request '${id}' not found`);
    }
    return request;
  }

  async findByUser(userId: string): Promise<DataSubjectRequest[]> {
    return [...this.requests.values()]
      .filter((request) => request.userId === userId)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .map((request) => ({ ...request }));
  }

  async update(id: string, patch: Partial<DataSubjectRequest>): Promise<DataSubjectRequest> {
    const request = this.requests.get(id);
    if (!request) {
      throw new NotFoundException(`Data subject request '${id}' not found`);
    }
    const updated = { ...request, ...patch, id: request.id };
    this.requests.set(id, updated);
    return { ...updated };
  }

  private isClosedBefore(request: DataSubjectRequest, cutoff: string): boolean {
    return (
      (request.status === 'completed' || request.status === 'rejected') &&
      Boolean(request.completedAt) &&
      request.completedAt! < cutoff
    );
  }

  async countClosedBefore(cutoff: string): Promise<number> {
    return [...this.requests.values()].filter((request) => this.isClosedBefore(request, cutoff))
      .length;
  }

  async anonymizeClosedBefore(
    cutoff: string,
    pseudonymFor: (userId: string) => string
  ): Promise<number> {
    let changed = 0;
    for (const [id, request] of this.requests) {
      if (this.isClosedBefore(request, cutoff)) {
        const tombstone = pseudonymFor(request.userId);
        if (tombstone === request.userId) continue;
        this.requests.set(id, { ...request, userId: tombstone });
        changed += 1;
      }
    }
    return changed;
  }

  async purgeClosedBefore(cutoff: string): Promise<number> {
    let removed = 0;
    for (const [id, request] of this.requests) {
      if (this.isClosedBefore(request, cutoff)) {
        this.requests.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

export function createInMemoryDataSubjectRequestRepository(): InMemoryDataSubjectRequestRepository {
  return new InMemoryDataSubjectRequestRepository();
}

export class InMemoryRetentionPolicyRepository implements RetentionPolicyRepository {
  private readonly policies = new Map<string, RetentionPolicy>();

  constructor(seed: readonly RetentionPolicy[] = defaultRetentionPolicySeed()) {
    for (const policy of seed) {
      this.policies.set(policy.entity, { ...policy });
    }
  }

  async list(): Promise<RetentionPolicy[]> {
    return [...this.policies.values()]
      .sort((a, b) => a.entity.localeCompare(b.entity))
      .map((policy) => ({ ...policy }));
  }

  async findByEntity(entity: string): Promise<RetentionPolicy | undefined> {
    const policy = this.policies.get(entity);
    return policy ? { ...policy } : undefined;
  }

  async upsert(policy: RetentionPolicy): Promise<RetentionPolicy> {
    this.policies.set(policy.entity, { ...policy });
    return { ...policy };
  }
}

export function defaultRetentionPolicySeed(now = new Date().toISOString()): RetentionPolicy[] {
  return DEFAULT_RETENTION_POLICIES.map((policy) => ({ ...policy, updatedAt: now }));
}

export function createInMemoryRetentionPolicyRepository(): InMemoryRetentionPolicyRepository {
  return new InMemoryRetentionPolicyRepository();
}
