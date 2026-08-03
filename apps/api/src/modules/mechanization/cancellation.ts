/**
 * Deterministic cancellation / hold-release schedule (wave MECHANIZATION).
 * Pure function — the same inputs always produce the same split, and the
 * table below is pinned by known-answer tests and mirrored in
 * docs/mechanization-marketplace.md.
 *
 * Who cancels, and when, decides where the held kobo go:
 *
 * | Cancelling party | Timing vs windowStart        | Farmer refund | Owner compensation |
 * |------------------|------------------------------|---------------|--------------------|
 * | owner            | any time before completion   | 100%          | 0%                 |
 * | admin            | any time before completion   | 100%          | 0%                 |
 * | farmer           | ≥ 48 h before window start   | 100%          | 0%                 |
 * | farmer           | 24–48 h before window start  | 90%           | 10%                |
 * | farmer           | < 24 h before / in service   | 70%           | 30%                |
 *
 * Disputes freeze the hold entirely; an admin resolution pays 100% one way
 * ('refund_farmer' or 'pay_owner'). Rounding: the owner share is rounded to
 * the nearest kobo, the farmer receives the remainder (exact conservation).
 */

export const FARMER_FREE_CANCEL_HOURS = 48;
export const FARMER_LATE_CANCEL_HOURS = 24;
export const LATE_CANCEL_OWNER_SHARE = 0.1;
export const VERY_LATE_CANCEL_OWNER_SHARE = 0.3;

export type CancellingParty = 'farmer' | 'owner' | 'admin';

export interface CancellationSplit {
  refundToFarmerKobo: number;
  compensationToOwnerKobo: number;
  /** Machine-readable schedule row applied (audit + tests). */
  rule:
    | 'owner_cancel_full_refund'
    | 'admin_cancel_full_refund'
    | 'farmer_free_cancel'
    | 'farmer_late_cancel_90_10'
    | 'farmer_very_late_cancel_70_30';
}

export function cancellationSplit(
  totalKobo: number,
  cancelledBy: CancellingParty,
  windowStart: string,
  nowMs: number
): CancellationSplit {
  if (!Number.isSafeInteger(totalKobo) || totalKobo < 0) {
    throw new RangeError('totalKobo must be a non-negative safe integer');
  }
  if (cancelledBy === 'owner') {
    return {
      refundToFarmerKobo: totalKobo,
      compensationToOwnerKobo: 0,
      rule: 'owner_cancel_full_refund'
    };
  }
  if (cancelledBy === 'admin') {
    return {
      refundToFarmerKobo: totalKobo,
      compensationToOwnerKobo: 0,
      rule: 'admin_cancel_full_refund'
    };
  }
  const hoursBeforeStart = (Date.parse(windowStart) - nowMs) / (60 * 60 * 1000);
  if (hoursBeforeStart >= FARMER_FREE_CANCEL_HOURS) {
    return {
      refundToFarmerKobo: totalKobo,
      compensationToOwnerKobo: 0,
      rule: 'farmer_free_cancel'
    };
  }
  const ownerShare =
    hoursBeforeStart >= FARMER_LATE_CANCEL_HOURS
      ? LATE_CANCEL_OWNER_SHARE
      : VERY_LATE_CANCEL_OWNER_SHARE;
  const compensationToOwnerKobo = Math.round(totalKobo * ownerShare);
  return {
    refundToFarmerKobo: totalKobo - compensationToOwnerKobo,
    compensationToOwnerKobo,
    rule:
      hoursBeforeStart >= FARMER_LATE_CANCEL_HOURS
        ? 'farmer_late_cancel_90_10'
        : 'farmer_very_late_cancel_70_30'
  };
}
