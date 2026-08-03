/**
 * Deterministic agent commission table (wave AGENTBANK). Commission is a
 * pure function of (transaction type, amount): basis points of the amount,
 * floored to integer kobo and capped per transaction. No clocks, no random
 * sources — the same inputs always accrue the same commission, which is
 * what makes the monthly statement and reconciliation reproducible.
 *
 * The table is a business-config constant; changing it changes future
 * accruals only (accruals are posted to the ledger per transaction).
 */
export interface CommissionRule {
  /** Basis points (1/100 of a percent) of the transaction amount. */
  bps: number;
  /** Per-transaction cap in kobo. */
  capKobo: number;
}

export type CommissionableType = 'cash_in' | 'cash_out' | 'voucher_redemption';

export const AGENT_COMMISSION_TABLE: Readonly<Record<CommissionableType, CommissionRule>> = {
  cash_in: { bps: 50, capKobo: 50_000 }, // 0.50%, cap N500.00
  cash_out: { bps: 75, capKobo: 75_000 }, // 0.75%, cap N750.00
  voucher_redemption: { bps: 25, capKobo: 25_000 } // 0.25%, cap N250.00
} as const;

/** Commission for one transaction, in integer kobo (never negative). */
export function commissionFor(type: CommissionableType, amountKobo: number): number {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    return 0;
  }
  const rule = AGENT_COMMISSION_TABLE[type];
  const raw = Math.floor((amountKobo * rule.bps) / 10_000);
  return Math.min(raw, rule.capKobo);
}
