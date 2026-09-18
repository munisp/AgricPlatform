import type { LedgerPosting } from '@agric-platform/shared';

/**
 * Escrow double-entry ledger legs (Stage 27, WP-G13 ledger hardening).
 *
 * Until WP-G13 the escrow state machine moved value entirely off-ledger:
 * holds, releases and refunds changed marketplace.escrow_records and drove
 * the payment provider / payout rail, but no double-entry journal recorded
 * the platform's obligation. This module defines the two pooled ledger
 * accounts and the posting builders so every escrow state transition leaves
 * a balanced journal trail:
 *
 *   hold (buyer funds captured by the provider/rail):
 *     DR marketplace:escrow:provider_float   (asset — funds held at the rail)
 *     CR marketplace:escrow:holds_liability  (liability — owed to order parties)
 *   release / refund (rail pays seller / refunds buyer):
 *     DR marketplace:escrow:holds_liability
 *     CR marketplace:escrow:provider_float
 *
 * Every leg is idempotency-keyed (`escrow-ledger:hold:<orderId>`,
 * `escrow-ledger:released:<id>`, `escrow-ledger:refunded:<id>`), so retries,
 * replays and the reconciliation repair sweep can never double-post. The
 * HOLD leg key is deliberately ORDER-derived (V-49): one order escrows once,
 * so even if a driver bug ever produced two escrow records for one order,
 * the second hold leg would replay against the same key instead of
 * double-posting the liability.
 *
 * Invariant the reconciliation job (finance LedgerReconciliationService)
 * proves: Σ amount_kobo of escrows in open states (held, releasing,
 * refunding, disputed) === outstanding holds_liability (credits − debits)
 * === provider_float balance (debits − credits). Money is integer kobo.
 */

/** Asset account: buyer funds held at the payment provider / payout rail. */
export const ESCROW_PROVIDER_FLOAT_ACCOUNT = 'marketplace:escrow:provider_float';

/** Liability account: held escrow funds owed to order parties. */
export const ESCROW_HOLDS_LIABILITY_ACCOUNT = 'marketplace:escrow:holds_liability';

/** Ledger reference types for the escrow legs (reconciliation scans these). */
export const ESCROW_LEDGER_REFERENCE_TYPES = {
  hold: 'marketplace_escrow_hold',
  released: 'marketplace_escrow_release',
  refunded: 'marketplace_escrow_refund',
  // V-06 split settlement: a disputed/partially-fulfilled escrow settles in
  // TWO legs (a seller release part + a buyer refund part) that sum EXACTLY
  // to the held amount. Each leg settles its partial amount out of the
  // holds liability, so the reconciliation invariant still holds: Σ open
  // escrow amounts === outstanding holds_liability.
  split_release: 'marketplace_escrow_split_release',
  split_refund: 'marketplace_escrow_split_refund'
} as const;

export type EscrowLedgerLeg = keyof typeof ESCROW_LEDGER_REFERENCE_TYPES;

/** Escrow states whose funds are still the platform's liability. */
export const ESCROW_OPEN_STATUSES = ['held', 'releasing', 'refunding', 'disputed'] as const;

export function escrowHoldLedgerKey(orderId: string): string {
  return `escrow-ledger:hold:${orderId}`;
}

export function escrowMoneyOutLedgerKey(
  status: 'released' | 'refunded',
  escrowId: string
): string {
  return `escrow-ledger:${status}:${escrowId}`;
}

/**
 * V-06: idempotency key for one split leg. Per (escrow, leg-part) so a
 * replayed/duplicated split resolution can never double-post a part, and
 * the two parts are independently re-ensurable.
 */
export function escrowSplitLegLedgerKey(
  leg: 'split_release' | 'split_refund',
  escrowId: string
): string {
  return `escrow-ledger:${leg}:${escrowId}`;
}

/** Hold legs: DR provider float, CR holds liability. */
export function buildEscrowHoldPostings(amountKobo: number): LedgerPosting[] {
  return [
    { accountCode: ESCROW_PROVIDER_FLOAT_ACCOUNT, direction: 'debit', amountKobo },
    { accountCode: ESCROW_HOLDS_LIABILITY_ACCOUNT, direction: 'credit', amountKobo }
  ];
}

/** Money-out legs (release to seller / refund to buyer): settle the hold. */
export function buildEscrowSettlementPostings(amountKobo: number): LedgerPosting[] {
  return [
    { accountCode: ESCROW_HOLDS_LIABILITY_ACCOUNT, direction: 'debit', amountKobo },
    { accountCode: ESCROW_PROVIDER_FLOAT_ACCOUNT, direction: 'credit', amountKobo }
  ];
}

/**
 * V-06: full posting descriptor for ONE split-settlement leg (partial
 * release to the seller or partial refund to the buyer). The pair posted for
 * one settlement sums exactly to the escrow's held amountKobo.
 */
export function escrowSplitLegPostingInput(
  record: { id: string; orderId: string },
  leg: 'split_release' | 'split_refund',
  amountKobo: number
): {
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  postings: LedgerPosting[];
} {
  const side = leg === 'split_release' ? 'release' : 'refund';
  return {
    idempotencyKey: escrowSplitLegLedgerKey(leg, record.id),
    referenceType: ESCROW_LEDGER_REFERENCE_TYPES[leg],
    referenceId: record.id,
    description: `Escrow split ${side} ${record.id} (${amountKobo} kobo partial settlement)`,
    postings: buildEscrowSettlementPostings(amountKobo)
  };
}

/** Full posting descriptor for one WHOLE-AMOUNT escrow leg (service + reconciler share it).
 *  V-06 split legs are partial-amount and use escrowSplitLegPostingInput instead. */
export function escrowLegPostingInput(
  record: { id: string; orderId: string; amountKobo: number },
  leg: 'hold' | 'released' | 'refunded'
): {
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
  description: string;
  postings: LedgerPosting[];
} {
  return {
    idempotencyKey:
      leg === 'hold' ? escrowHoldLedgerKey(record.orderId) : escrowMoneyOutLedgerKey(leg, record.id),
    referenceType: ESCROW_LEDGER_REFERENCE_TYPES[leg],
    referenceId: record.id,
    description:
      leg === 'hold'
        ? `Escrow hold ${record.id} (${record.amountKobo} kobo into provider float)`
        : `Escrow ${leg} ${record.id} (${record.amountKobo} kobo settlement)`,
    postings:
      leg === 'hold'
        ? buildEscrowHoldPostings(record.amountKobo)
        : buildEscrowSettlementPostings(record.amountKobo)
  };
}
