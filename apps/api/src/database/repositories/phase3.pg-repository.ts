import type pg from 'pg';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  ExternalAccountLink,
  ExternalAccountLinkCriteria,
  ExternalAccountLinkRepository,
  FarmRecord,
  FarmRecordCriteria,
  FarmRecordRepository,
  ImportBatch,
  ImportBatchCriteria,
  ImportBatchRepository,
  ImportRecord,
  ImportRecordCriteria,
  ImportRecordRepository,
  InboundEvent,
  InboundEventCriteria,
  InboundEventRepository
} from './phase3.repository.js';

// The mappers live next to the repositories (instead of row-mappers.ts) to
// keep the wave P5a diff additive and conflict-free with concurrent waves.

/** toRow helper: emits only keys whose value is not undefined so partial
 * update patches never overwrite untouched columns. */
function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof T>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (item[key] !== undefined) {
      row[column] = item[key];
    }
  }
  return row;
}

const ts = (value: unknown): string => new Date(value as string).toISOString();

const linkMapper: RowMapper<ExternalAccountLink> = {
  columns: ['id', 'user_id', 'system', 'external_id', 'consent_at', 'revoked_at', 'created_at'],
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    system: row.system as ExternalAccountLink['system'],
    externalId: row.external_id as string,
    consentAt: ts(row.consent_at),
    revokedAt: row.revoked_at ? ts(row.revoked_at) : undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      user_id: 'userId',
      system: 'system',
      external_id: 'externalId',
      consent_at: 'consentAt',
      revoked_at: 'revokedAt',
      created_at: 'createdAt'
    })
};

export function externalAccountLinkCriteriaSql(criteria: ExternalAccountLinkCriteria): WhereClause {
  return composeWhere(
    eq('user_id', criteria.userId),
    eq('system', criteria.system),
    criteria.activeOnly ? { where: 'revoked_at IS NULL', params: [] } : null
  );
}

export class PgExternalAccountLinkRepository
  extends PgRepositoryBase<ExternalAccountLink, ExternalAccountLinkCriteria>
  implements ExternalAccountLinkRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'integrations.external_account_links',
      mapper: linkMapper,
      criteria: externalAccountLinkCriteriaSql,
      orderBy: 'created_at DESC, id'
    });
  }
}

export function createPgExternalAccountLinkRepository(pool: pg.Pool): PgExternalAccountLinkRepository {
  return new PgExternalAccountLinkRepository(pool);
}

// ---------------------------------------------------------------------------

const farmRecordMapper: RowMapper<FarmRecord> = {
  columns: ['id', 'link_id', 'record_type', 'external_id', 'payload', 'source', 'observed_at', 'synced_at'],
  fromRow: (row) => ({
    id: row.id as string,
    linkId: row.link_id as string,
    recordType: row.record_type as FarmRecord['recordType'],
    externalId: row.external_id as string,
    payload: row.payload as Record<string, unknown>,
    source: row.source as string,
    observedAt: ts(row.observed_at),
    syncedAt: ts(row.synced_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      link_id: 'linkId',
      record_type: 'recordType',
      external_id: 'externalId',
      payload: 'payload',
      source: 'source',
      observed_at: 'observedAt',
      synced_at: 'syncedAt'
    })
};

export function farmRecordCriteriaSql(criteria: FarmRecordCriteria): WhereClause {
  return composeWhere(eq('link_id', criteria.linkId), eq('record_type', criteria.recordType));
}

export class PgFarmRecordRepository
  extends PgRepositoryBase<FarmRecord, FarmRecordCriteria>
  implements FarmRecordRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'integrations.farm_records',
      mapper: farmRecordMapper,
      criteria: farmRecordCriteriaSql,
      orderBy: 'observed_at DESC, id'
    });
  }

  /**
   * Idempotent sync insert: the UNIQUE(link_id, record_type, external_id)
   * constraint from 007 dedupes re-synced records; DO NOTHING keeps polling
   * and webhook replays safe.
   */
  async upsertMany(items: FarmRecord[]): Promise<number> {
    let inserted = 0;
    for (const item of items) {
      const row = farmRecordMapper.toRow(item);
      const columns = Object.keys(row);
      const values = columns.map((column) => row[column]);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const result = await this.pool.query(
        `INSERT INTO integrations.farm_records (${columns.join(', ')}) VALUES (${placeholders}) ` +
          'ON CONFLICT (link_id, record_type, external_id) DO NOTHING',
        values
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }
}

export function createPgFarmRecordRepository(pool: pg.Pool): PgFarmRecordRepository {
  return new PgFarmRecordRepository(pool);
}

// ---------------------------------------------------------------------------

const importBatchMapper: RowMapper<ImportBatch> = {
  columns: [
    'id',
    'source_system',
    'donor_source',
    'status',
    'record_count',
    'created_by',
    'created_at',
    'confirmed_at',
    'confirmed_by'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    sourceSystem: row.source_system as string,
    donorSource: row.donor_source as string,
    status: row.status as ImportBatch['status'],
    recordCount: Number(row.record_count),
    createdBy: row.created_by as string,
    createdAt: ts(row.created_at),
    confirmedAt: row.confirmed_at ? ts(row.confirmed_at) : undefined,
    confirmedBy: (row.confirmed_by as string) ?? undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      source_system: 'sourceSystem',
      donor_source: 'donorSource',
      status: 'status',
      record_count: 'recordCount',
      created_by: 'createdBy',
      created_at: 'createdAt',
      confirmed_at: 'confirmedAt',
      confirmed_by: 'confirmedBy'
    })
};

export function importBatchCriteriaSql(criteria: ImportBatchCriteria): WhereClause {
  return composeWhere(eq('status', criteria.status), eq('source_system', criteria.sourceSystem));
}

export class PgImportBatchRepository
  extends PgRepositoryBase<ImportBatch, ImportBatchCriteria>
  implements ImportBatchRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'integrations.import_batches',
      mapper: importBatchMapper,
      criteria: importBatchCriteriaSql,
      orderBy: 'created_at DESC, id'
    });
  }
}

export function createPgImportBatchRepository(pool: pg.Pool): PgImportBatchRepository {
  return new PgImportBatchRepository(pool);
}

// ---------------------------------------------------------------------------

const importRecordMapper: RowMapper<ImportRecord> = {
  columns: [
    'id',
    'batch_id',
    'nin_hash',
    'phone_hash',
    'payload',
    'status',
    'donor_source',
    'consent_date',
    'matched_user_id',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    batchId: row.batch_id as string,
    ninHash: (row.nin_hash as string) ?? undefined,
    phoneHash: (row.phone_hash as string) ?? undefined,
    payload: row.payload as Record<string, unknown>,
    status: row.status as ImportRecord['status'],
    donorSource: row.donor_source as string,
    consentDate: ts(row.consent_date),
    matchedUserId: (row.matched_user_id as string) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      batch_id: 'batchId',
      nin_hash: 'ninHash',
      phone_hash: 'phoneHash',
      payload: 'payload',
      status: 'status',
      donor_source: 'donorSource',
      consent_date: 'consentDate',
      matched_user_id: 'matchedUserId',
      created_at: 'createdAt'
    })
};

export function importRecordCriteriaSql(criteria: ImportRecordCriteria): WhereClause {
  return composeWhere(
    eq('batch_id', criteria.batchId),
    eq('status', criteria.status),
    eq('phone_hash', criteria.phoneHash),
    eq('nin_hash', criteria.ninHash)
  );
}

export class PgImportRecordRepository
  extends PgRepositoryBase<ImportRecord, ImportRecordCriteria>
  implements ImportRecordRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'integrations.import_records',
      mapper: importRecordMapper,
      criteria: importRecordCriteriaSql,
      orderBy: 'created_at, id'
    });
  }
}

export function createPgImportRecordRepository(pool: pg.Pool): PgImportRecordRepository {
  return new PgImportRecordRepository(pool);
}

// ---------------------------------------------------------------------------

const inboundEventMapper: RowMapper<InboundEvent> = {
  columns: ['id', 'system', 'event_type', 'dedupe_key', 'payload', 'received_at', 'processed_at'],
  fromRow: (row) => ({
    id: row.id as string,
    system: row.system as string,
    eventType: row.event_type as string,
    dedupeKey: row.dedupe_key as string,
    payload: row.payload as Record<string, unknown>,
    receivedAt: ts(row.received_at),
    processedAt: row.processed_at ? ts(row.processed_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      system: 'system',
      event_type: 'eventType',
      dedupe_key: 'dedupeKey',
      payload: 'payload',
      received_at: 'receivedAt',
      processed_at: 'processedAt'
    })
};

export function inboundEventCriteriaSql(criteria: InboundEventCriteria): WhereClause {
  return composeWhere(eq('system', criteria.system), eq('event_type', criteria.eventType));
}

export class PgInboundEventRepository
  extends PgRepositoryBase<InboundEvent, InboundEventCriteria>
  implements InboundEventRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'integrations.inbound_events',
      mapper: inboundEventMapper,
      criteria: inboundEventCriteriaSql,
      orderBy: 'received_at DESC, id'
    });
  }

  /** Replay-safe ingest backed by UNIQUE(system, dedupe_key). */
  async ingest(event: InboundEvent): Promise<InboundEvent | undefined> {
    const row = inboundEventMapper.toRow(event);
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const result = await this.pool.query(
      `INSERT INTO integrations.inbound_events (${columns.join(', ')}) VALUES (${placeholders}) ` +
        'ON CONFLICT (system, dedupe_key) DO NOTHING',
      values
    );
    return (result.rowCount ?? 0) > 0 ? event : undefined;
  }

  async markProcessed(id: string, processedAt: string): Promise<InboundEvent> {
    return this.update(id, { processedAt });
  }
}

export function createPgInboundEventRepository(pool: pg.Pool): PgInboundEventRepository {
  return new PgInboundEventRepository(pool);
}
