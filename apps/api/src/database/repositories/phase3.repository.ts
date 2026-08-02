import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Phase-3 federated integration storage (wave P5a, infra/postgres/007).
 * External account links, normalised farm records, staged beneficiary
 * imports and the inbound event ledger. Identity values from partner
 * systems are stored only as SHA-256 hashes (NDPR minimisation).
 */

export type ExternalSystem = 'farmos' | 'litefarm';

export interface ExternalAccountLink {
  id: string;
  userId: string;
  system: ExternalSystem;
  externalId: string;
  /** ISO-8601 timestamp of the farmer's explicit sharing consent. */
  consentAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface ExternalAccountLinkCriteria {
  userId?: string;
  system?: string;
  /** When true only active (non-revoked) links match. */
  activeOnly?: boolean;
}

export interface ExternalAccountLinkRepository
  extends AsyncRepository<ExternalAccountLink, ExternalAccountLinkCriteria> {}

export function externalAccountLinkMatcher(
  criteria: ExternalAccountLinkCriteria
): (link: ExternalAccountLink) => boolean {
  return (link) =>
    (!criteria.userId || link.userId === criteria.userId) &&
    (!criteria.system || link.system === criteria.system) &&
    (!criteria.activeOnly || link.revokedAt === undefined);
}

export class InMemoryExternalAccountLinkRepository
  extends InMemoryRepository<ExternalAccountLink, ExternalAccountLinkCriteria>
  implements ExternalAccountLinkRepository
{
  constructor(seed: readonly ExternalAccountLink[] = []) {
    super(seed, externalAccountLinkMatcher);
  }
}

export function createInMemoryExternalAccountLinkRepository(
  seed: readonly ExternalAccountLink[] = []
): InMemoryExternalAccountLinkRepository {
  return new InMemoryExternalAccountLinkRepository(seed);
}

// ---------------------------------------------------------------------------

export type FarmRecordType = 'crop_plan' | 'harvest' | 'field_map';

export interface FarmRecord {
  id: string;
  linkId: string;
  recordType: FarmRecordType;
  /** Record id on the remote system (part of the replay dedupe key). */
  externalId: string;
  payload: Record<string, unknown>;
  source: string;
  observedAt: string;
  syncedAt: string;
}

export interface FarmRecordCriteria {
  linkId?: string;
  recordType?: FarmRecordType;
}

export interface FarmRecordRepository extends AsyncRepository<FarmRecord, FarmRecordCriteria> {
  /**
   * Idempotent sync insert: rows whose (linkId, recordType, externalId)
   * already exist are skipped. Returns the number of newly inserted rows.
   */
  upsertMany(items: FarmRecord[]): Promise<number>;
}

export function farmRecordMatcher(criteria: FarmRecordCriteria): (record: FarmRecord) => boolean {
  return (record) =>
    (!criteria.linkId || record.linkId === criteria.linkId) &&
    (!criteria.recordType || record.recordType === criteria.recordType);
}

/** The dedupe key backing the table's UNIQUE constraint. */
export function farmRecordKey(record: FarmRecord): string {
  return [record.linkId, record.recordType, record.externalId].join('¦');
}

export class InMemoryFarmRecordRepository
  extends InMemoryRepository<FarmRecord, FarmRecordCriteria>
  implements FarmRecordRepository
{
  constructor(seed: readonly FarmRecord[] = []) {
    super(seed, farmRecordMatcher);
  }

  async upsertMany(items: FarmRecord[]): Promise<number> {
    const existing = new Set([...this.items.values()].map(farmRecordKey));
    let inserted = 0;
    for (const item of items) {
      const key = farmRecordKey(item);
      if (existing.has(key) || this.items.has(item.id)) {
        continue;
      }
      existing.add(key);
      this.items.set(item.id, item);
      inserted += 1;
    }
    return inserted;
  }
}

export function createInMemoryFarmRecordRepository(
  seed: readonly FarmRecord[] = []
): InMemoryFarmRecordRepository {
  return new InMemoryFarmRecordRepository(seed);
}

// ---------------------------------------------------------------------------

export type ImportBatchStatus = 'STAGED' | 'CONFIRMED';

export interface ImportBatch {
  id: string;
  /** odk | kobo | csv_upload */
  sourceSystem: string;
  /** Donor / NGO programme label attached to every staged record. */
  donorSource: string;
  status: ImportBatchStatus;
  recordCount: number;
  createdBy: string;
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

export interface ImportBatchCriteria {
  status?: ImportBatchStatus;
  sourceSystem?: string;
}

export interface ImportBatchRepository extends AsyncRepository<ImportBatch, ImportBatchCriteria> {}

export function importBatchMatcher(criteria: ImportBatchCriteria): (batch: ImportBatch) => boolean {
  return (batch) =>
    (!criteria.status || batch.status === criteria.status) &&
    (!criteria.sourceSystem || batch.sourceSystem === criteria.sourceSystem);
}

export class InMemoryImportBatchRepository
  extends InMemoryRepository<ImportBatch, ImportBatchCriteria>
  implements ImportBatchRepository
{
  constructor(seed: readonly ImportBatch[] = []) {
    super(seed, importBatchMatcher);
  }
}

export function createInMemoryImportBatchRepository(
  seed: readonly ImportBatch[] = []
): InMemoryImportBatchRepository {
  return new InMemoryImportBatchRepository(seed);
}

// ---------------------------------------------------------------------------

export type ImportRecordStatus = 'STAGED' | 'MERGED' | 'REJECTED';

export interface ImportRecord {
  id: string;
  batchId: string;
  /** SHA-256 of the normalised NIN; never the raw value. */
  ninHash?: string;
  /** SHA-256 of the normalised phone; never the raw value. */
  phoneHash?: string;
  payload: Record<string, unknown>;
  status: ImportRecordStatus;
  donorSource: string;
  /** ISO-8601 donor-attested consent capture date. */
  consentDate: string;
  /** identity.users id when the row deduplicated against an existing user. */
  matchedUserId?: string;
  createdAt: string;
}

export interface ImportRecordCriteria {
  batchId?: string;
  status?: ImportRecordStatus;
  phoneHash?: string;
  ninHash?: string;
}

export interface ImportRecordRepository extends AsyncRepository<ImportRecord, ImportRecordCriteria> {}

export function importRecordMatcher(
  criteria: ImportRecordCriteria
): (record: ImportRecord) => boolean {
  return (record) =>
    (!criteria.batchId || record.batchId === criteria.batchId) &&
    (!criteria.status || record.status === criteria.status) &&
    (!criteria.phoneHash || record.phoneHash === criteria.phoneHash) &&
    (!criteria.ninHash || record.ninHash === criteria.ninHash);
}

export class InMemoryImportRecordRepository
  extends InMemoryRepository<ImportRecord, ImportRecordCriteria>
  implements ImportRecordRepository
{
  constructor(seed: readonly ImportRecord[] = []) {
    super(seed, importRecordMatcher);
  }
}

export function createInMemoryImportRecordRepository(
  seed: readonly ImportRecord[] = []
): InMemoryImportRecordRepository {
  return new InMemoryImportRecordRepository(seed);
}

// ---------------------------------------------------------------------------

export interface InboundEvent {
  id: string;
  /** farmos | litefarm | ofn | lender */
  system: string;
  eventType: string;
  /** Provider event id or payload hash; UNIQUE(system, dedupe_key). */
  dedupeKey: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  processedAt?: string;
}

export interface InboundEventCriteria {
  system?: string;
  eventType?: string;
}

export interface InboundEventRepository extends AsyncRepository<InboundEvent, InboundEventCriteria> {
  /**
   * Idempotent ingest: returns the stored event, or undefined when the
   * (system, dedupeKey) pair was already received (webhook replay).
   */
  ingest(event: InboundEvent): Promise<InboundEvent | undefined>;
  markProcessed(id: string, processedAt: string): Promise<InboundEvent>;
}

export function inboundEventMatcher(criteria: InboundEventCriteria): (event: InboundEvent) => boolean {
  return (event) =>
    (!criteria.system || event.system === criteria.system) &&
    (!criteria.eventType || event.eventType === criteria.eventType);
}

export class InMemoryInboundEventRepository
  extends InMemoryRepository<InboundEvent, InboundEventCriteria>
  implements InboundEventRepository
{
  constructor(seed: readonly InboundEvent[] = []) {
    super(seed, inboundEventMatcher);
  }

  async ingest(event: InboundEvent): Promise<InboundEvent | undefined> {
    const duplicate = [...this.items.values()].some(
      (existing) => existing.system === event.system && existing.dedupeKey === event.dedupeKey
    );
    if (duplicate || this.items.has(event.id)) {
      return undefined;
    }
    this.items.set(event.id, event);
    return event;
  }

  async markProcessed(id: string, processedAt: string): Promise<InboundEvent> {
    return this.update(id, { processedAt });
  }
}

export function createInMemoryInboundEventRepository(
  seed: readonly InboundEvent[] = []
): InMemoryInboundEventRepository {
  return new InMemoryInboundEventRepository(seed);
}
