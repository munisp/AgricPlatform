/**
 * Parquet part-file writer for the lakehouse export (parquetjs-lite).
 *
 * One schema per analytics star table (migration 019); column names are the
 * snake_case mart columns so external query engines see the same contract the
 * CSV handoff already documented. Timestamp columns are ISO-8601 UTC strings
 * (UTF8) — the same representation the CSV exports use; promoting them to
 * parquet TIMESTAMP logical types is a documented future refinement, not a
 * correctness gap. Array columns (roles, debit/credit accounts) are native
 * parquet REPEATED UTF8 fields.
 */
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import type {
  ParquetFieldDef,
  ParquetSchema as ParquetSchemaType
} from 'parquetjs-lite';

// parquetjs-lite is CommonJS whose named exports are not statically analyzable
// by cjs-module-lexer, so `import { ParquetSchema } from 'parquetjs-lite'`
// crashes under real Node ESM (vitest's interop hides this). Load the values
// through createRequire and keep the type surface from the declarations.
const require = createRequire(import.meta.url);
const { ParquetSchema, ParquetWriter } = require('parquetjs-lite') as typeof import('parquetjs-lite');
import type {
  DailyMetricRow,
  DimListingRow,
  DimUserRow,
  FactLivestockRow,
  FactOrderRow,
  FactPaymentRow
} from '../star-marts.js';

/** Tables exported by the lakehouse exporter (1:1 with migration 019 marts). */
export const LAKEHOUSE_TABLES = [
  'dim_users',
  'dim_listings',
  'fact_orders',
  'fact_payments',
  'fact_livestock',
  'mart_daily_metrics'
] as const;
export type LakehouseTable = (typeof LAKEHOUSE_TABLES)[number];

const utf8: ParquetFieldDef = { type: 'UTF8' };
const optUtf8: ParquetFieldDef = { type: 'UTF8', optional: true };
const int32: ParquetFieldDef = { type: 'INT32' };
const int64: ParquetFieldDef = { type: 'INT64' };
const bool: ParquetFieldDef = { type: 'BOOLEAN' };
const utf8List: ParquetFieldDef = { type: 'UTF8', repeated: true };

const SCHEMAS: Record<LakehouseTable, ParquetSchemaType> = {
  dim_users: new ParquetSchema({
    user_id: utf8,
    roles: utf8List,
    state: optUtf8,
    chapter_id: optUtf8,
    registered_at: utf8
  }),
  dim_listings: new ParquetSchema({
    listing_id: utf8,
    seller_id: utf8,
    kind: utf8,
    crop: optUtf8,
    state: optUtf8,
    created_at: utf8
  }),
  fact_orders: new ParquetSchema({
    order_id: utf8,
    listing_id: utf8,
    buyer_id: utf8,
    seller_id: utf8,
    channel: utf8,
    variant_id: optUtf8,
    quantity: int32,
    total_kobo: int64,
    status: utf8,
    status_history_count: int32,
    escrow_required: bool,
    placed_at: utf8,
    fulfilled_at: optUtf8
  }),
  fact_payments: new ParquetSchema({
    entry_id: utf8,
    idempotency_key: utf8,
    reference_type: optUtf8,
    reference_id: optUtf8,
    debit_accounts: utf8List,
    credit_accounts: utf8List,
    amount_kobo: int64,
    posted_at: utf8
  }),
  fact_livestock: new ParquetSchema({
    animal_id: utf8,
    owner_user_id: utf8,
    species: utf8,
    breed: utf8,
    state: utf8,
    status: utf8,
    registered_at: utf8
  }),
  mart_daily_metrics: new ParquetSchema({
    metric_date: utf8,
    orders_gmv_kobo: int64,
    orders_count: int32,
    active_farmers: int32,
    escrow_held_kobo: int64,
    livestock_registered: int32
  })
};

/** camelCase mart row → snake_case parquet record (column contract). */
function encodeRow(table: LakehouseTable, row: unknown): Record<string, unknown> {
  switch (table) {
    case 'dim_users': {
      const r = row as unknown as DimUserRow;
      return {
        user_id: r.userId,
        roles: r.roles,
        state: r.state ?? null,
        chapter_id: r.chapterId ?? null,
        registered_at: r.registeredAt
      };
    }
    case 'dim_listings': {
      const r = row as unknown as DimListingRow;
      return {
        listing_id: r.listingId,
        seller_id: r.sellerId,
        kind: r.kind,
        crop: r.crop ?? null,
        state: r.state ?? null,
        created_at: r.createdAt
      };
    }
    case 'fact_orders': {
      const r = row as unknown as FactOrderRow;
      return {
        order_id: r.orderId,
        listing_id: r.listingId,
        buyer_id: r.buyerId,
        seller_id: r.sellerId,
        channel: r.channel,
        variant_id: r.variantId ?? null,
        quantity: r.quantity,
        total_kobo: r.totalKobo,
        status: r.status,
        status_history_count: r.statusHistoryCount,
        escrow_required: r.escrowRequired,
        placed_at: r.placedAt,
        fulfilled_at: r.fulfilledAt ?? null
      };
    }
    case 'fact_payments': {
      const r = row as unknown as FactPaymentRow;
      return {
        entry_id: r.entryId,
        idempotency_key: r.idempotencyKey,
        reference_type: r.referenceType ?? null,
        reference_id: r.referenceId ?? null,
        debit_accounts: r.debitAccounts,
        credit_accounts: r.creditAccounts,
        amount_kobo: r.amountKobo,
        posted_at: r.postedAt
      };
    }
    case 'fact_livestock': {
      const r = row as unknown as FactLivestockRow;
      return {
        animal_id: r.animalId,
        owner_user_id: r.ownerUserId,
        species: r.species,
        breed: r.breed,
        state: r.state,
        status: r.status,
        registered_at: r.registeredAt
      };
    }
    case 'mart_daily_metrics': {
      const r = row as unknown as DailyMetricRow;
      return {
        metric_date: r.metricDate,
        orders_gmv_kobo: r.ordersGmvKobo,
        orders_count: r.ordersCount,
        active_farmers: r.activeFarmers,
        escrow_held_kobo: r.escrowHeldKobo,
        livestock_registered: r.livestockRegistered
      };
    }
  }
}

/** In-memory Writable that collects the parquet byte stream. */
class BufferSink extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Serialise one table's rows into a single parquet part-file buffer.
 * parquetjs-lite has no openBuffer writer, so the byte stream is collected
 * through an in-memory Writable (rows fit comfortably: mart tables are
 * single-digit-GB at most and part files are per-day snapshots).
 */
export async function writeParquetPart(
  table: LakehouseTable,
  rows: readonly unknown[]
): Promise<Buffer> {
  const sink = new BufferSink();
  const writer = await ParquetWriter.openStream(SCHEMAS[table], sink);
  for (const row of rows) {
    await writer.appendRow(encodeRow(table, row));
  }
  await writer.close();
  return sink.buffer();
}
