import type { EscrowPayout, EscrowRecord } from '@agric-platform/shared';
import type { RowMapper } from './pg-repository.base.js';
import { num, ts } from './pg-repository.base.js';
import { escrowMapper } from './row-mappers.js';

/**
 * Local copy of the row-mappers `present` helper (kept private there): toRow
 * only emits keys present on the item so Partial<T> patches update exactly
 * the patched columns; present-but-undefined values become SQL NULL.
 */
function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

/**
 * Stage 22 (audit C2): escrow mapper extended with the deposit-evidence
 * columns added by infra/postgres/045_escrow_deposit_verification.sql
 * (deposit_payment_reference / deposit_verified_at on
 * marketplace.escrow_records).
 *
 * Implemented as a wrapper around the base escrowMapper so the wave-P2a
 * mapping stays untouched; the wrapper only adds the two new columns with
 * the same toRow semantics as `present` (a key present on the item is
 * written — undefined becomes SQL NULL; an absent key is not updated).
 */
export const escrowRecordMapper: RowMapper<EscrowRecord> = {
  columns: [...escrowMapper.columns, 'deposit_payment_reference', 'deposit_verified_at'],
  fromRow: (row) => ({
    ...escrowMapper.fromRow(row),
    depositReference: (row.deposit_payment_reference as string) ?? undefined,
    depositVerifiedAt: row.deposit_verified_at ? ts(row.deposit_verified_at) : undefined
  }),
  toRow: (item) => {
    const row = escrowMapper.toRow(item);
    if ('depositReference' in item) {
      row.deposit_payment_reference = item.depositReference ?? null;
    }
    if ('depositVerifiedAt' in item) {
      row.deposit_verified_at = item.depositVerifiedAt ?? null;
    }
    return row;
  }
};

/**
 * Stage 23: mapper for marketplace.escrow_payouts
 * (infra/postgres/048_escrow_payouts.sql) — one row per recorded payout
 * attempt (release/refund), keyed by idempotency_key.
 */
export const escrowPayoutMapper: RowMapper<EscrowPayout> = {
  columns: [
    'id',
    'escrow_id',
    'order_id',
    'kind',
    'amount_kobo',
    'idempotency_key',
    'payload_hash',
    'provider',
    'provider_reference',
    'status',
    'failure_reason',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    escrowId: row.escrow_id as string,
    orderId: row.order_id as string,
    kind: row.kind as EscrowPayout['kind'],
    amountKobo: num(row.amount_kobo),
    idempotencyKey: row.idempotency_key as string,
    payloadHash: row.payload_hash as string,
    provider: row.provider as string,
    providerReference: (row.provider_reference as string) ?? undefined,
    status: row.status as EscrowPayout['status'],
    failureReason: (row.failure_reason as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      escrow_id: 'escrowId',
      order_id: 'orderId',
      kind: 'kind',
      amount_kobo: 'amountKobo',
      idempotency_key: 'idempotencyKey',
      payload_hash: 'payloadHash',
      provider: 'provider',
      provider_reference: 'providerReference',
      status: 'status',
      failure_reason: 'failureReason',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};
