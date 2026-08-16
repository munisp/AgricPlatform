import type { EscrowRecord } from '@agric-platform/shared';
import type { RowMapper } from './pg-repository.base.js';
import { ts } from './pg-repository.base.js';
import { escrowMapper } from './row-mappers.js';

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
