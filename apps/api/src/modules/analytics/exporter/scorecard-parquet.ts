/**
 * Parquet part-file writer for Lender Lens scorecard exports (Stage 27,
 * innovation #20). Follows the lakehouse-parquet.ts conventions: one flat
 * snake_case schema, ISO-8601 UTC timestamp strings, parquetjs-lite loaded
 * through createRequire (real Node ESM cannot statically analyze its CJS
 * named exports).
 *
 * The full immutable payload rides in payload_json (canonical JSON) so the
 * export round-trips byte-for-byte against analytics.lender_scorecards; the
 * flattened PAR columns give query engines direct access without JSON
 * parsing.
 */
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { canonicalJson } from '../lender-scorecard.js';
import type { LenderScorecardRow } from '../../../database/repositories/lender-scorecard.repository.js';

const require = createRequire(import.meta.url);
const { ParquetSchema, ParquetWriter } = require('parquetjs-lite') as typeof import('parquetjs-lite');

const utf8 = { type: 'UTF8' } as const;
const int32 = { type: 'INT32' } as const;
const int64 = { type: 'INT64' } as const;

export const SCORECARD_PARQUET_SCHEMA = new ParquetSchema({
  lender_partner_id: utf8,
  version: utf8,
  period: utf8,
  data_as_of: utf8,
  active_loans: int32,
  defaulted_loans: int32,
  outstanding_kobo: int64,
  defaulted_kobo: int64,
  par30_bps: int32,
  par60_bps: int32,
  par90_bps: int32,
  payload_json: utf8,
  payload_hash: utf8,
  generated_at: utf8
});

/** camelCase scorecard row → snake_case parquet record (column contract). */
export function encodeScorecardRow(row: LenderScorecardRow): Record<string, unknown> {
  return {
    lender_partner_id: row.lenderPartnerId,
    version: row.version,
    period: row.period,
    data_as_of: row.payload.dataAsOf,
    active_loans: row.payload.portfolio.activeLoans,
    defaulted_loans: row.payload.portfolio.defaultedLoans,
    outstanding_kobo: row.payload.portfolio.outstandingKobo,
    defaulted_kobo: row.payload.portfolio.defaultedKobo,
    par30_bps: row.payload.portfolio.par30Bps,
    par60_bps: row.payload.portfolio.par60Bps,
    par90_bps: row.payload.portfolio.par90Bps,
    payload_json: canonicalJson(row.payload),
    payload_hash: row.payloadHash,
    generated_at: row.generatedAt
  };
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

/** Serialises one scorecard row into a single-row parquet part-file buffer. */
export async function writeScorecardParquet(row: LenderScorecardRow): Promise<Buffer> {
  const sink = new BufferSink();
  const writer = await ParquetWriter.openStream(SCORECARD_PARQUET_SCHEMA, sink);
  await writer.appendRow(encodeScorecardRow(row));
  await writer.close();
  return sink.buffer();
}
