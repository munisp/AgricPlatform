import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  allMilestonesMet,
  assertValidPriceBand,
  buyerEscrowAccountCode,
  contractEscrowLiabilityAccountCode,
  coopReceivableAccountCode,
  deliveryAmountKobo,
  deliveryLedgerIdempotencyKey,
  effectiveMilestoneStatus,
  isIsoCalendarDate,
  milestoneStatusAfterDelivery,
  priceWithinBand,
  settlementLedgerIdempotencyKey,
  validateMilestonePlan,
  type OfftakePriceBand
} from './offtake.js';

/**
 * Harvest Forward Contracts (Stage 27, Innovation 18) — pure domain math:
 * milestone state accumulation, missed-only-after-due-date, price-band
 * settlement pricing, and plan validation. No I/O anywhere in this spec.
 */

const band: OfftakePriceBand = { floorKoboPerKg: 40_000, capKoboPerKg: 60_000 };

describe('offtake price-band settlement pricing', () => {
  it('accepts floor, cap and in-band prices', () => {
    expect(priceWithinBand(band, 40_000)).toBe(true);
    expect(priceWithinBand(band, 50_000)).toBe(true);
    expect(priceWithinBand(band, 60_000)).toBe(true);
  });

  it('rejects prices outside the band (never silently clamped)', () => {
    expect(priceWithinBand(band, 39_999)).toBe(false);
    expect(priceWithinBand(band, 60_001)).toBe(false);
    expect(priceWithinBand(band, 0)).toBe(false);
    expect(priceWithinBand(band, -50_000)).toBe(false);
  });

  it('rejects non-integer prices (money never floats)', () => {
    expect(priceWithinBand(band, 50_000.5)).toBe(false);
    expect(priceWithinBand(band, Number.NaN)).toBe(false);
  });

  it('validates band shape: positive floor, cap >= floor, safe integers', () => {
    expect(() => assertValidPriceBand(band)).not.toThrow();
    expect(() => assertValidPriceBand({ floorKoboPerKg: 0, capKoboPerKg: 1 })).toThrow(
      BadRequestException
    );
    expect(() => assertValidPriceBand({ floorKoboPerKg: -1, capKoboPerKg: 1 })).toThrow(
      BadRequestException
    );
    expect(() => assertValidPriceBand({ floorKoboPerKg: 60_000, capKoboPerKg: 40_000 })).toThrow(
      BadRequestException
    );
    expect(() => assertValidPriceBand({ floorKoboPerKg: 1.5, capKoboPerKg: 2 })).toThrow(
      BadRequestException
    );
  });

  it('computes delivery amounts in exact integer kobo', () => {
    expect(deliveryAmountKobo(2_000, 45_000)).toBe(90_000_000);
    expect(deliveryAmountKobo(1, 1)).toBe(1);
  });

  it('refuses unrepresentable or non-positive amounts instead of rounding', () => {
    expect(() => deliveryAmountKobo(0, 45_000)).toThrow(BadRequestException);
    expect(() => deliveryAmountKobo(100, 0)).toThrow(BadRequestException);
    expect(() => deliveryAmountKobo(1.5, 45_000)).toThrow(BadRequestException);
    expect(() => deliveryAmountKobo(Number.MAX_SAFE_INTEGER, 2)).toThrow(BadRequestException);
  });
});

describe('offtake milestone state math', () => {
  it('accumulates: pending -> partial -> met as deliveries land', () => {
    expect(milestoneStatusAfterDelivery(0, 5_000)).toBe('pending');
    expect(milestoneStatusAfterDelivery(2_000, 5_000)).toBe('partial');
    expect(milestoneStatusAfterDelivery(4_999, 5_000)).toBe('partial');
    expect(milestoneStatusAfterDelivery(5_000, 5_000)).toBe('met');
  });

  it('is missed ONLY after the due date, never before', () => {
    const milestone = { status: 'partial' as const, dueDate: '2027-03-31' };
    expect(effectiveMilestoneStatus(milestone, '2027-03-30')).toBe('partial');
    expect(effectiveMilestoneStatus(milestone, '2027-03-31')).toBe('partial'); // due date itself is not missed
    expect(effectiveMilestoneStatus(milestone, '2027-04-01')).toBe('missed');
  });

  it('a met milestone never regresses to missed', () => {
    const milestone = { status: 'met' as const, dueDate: '2027-03-31' };
    expect(effectiveMilestoneStatus(milestone, '2027-12-31')).toBe('met');
  });

  it('a pending milestone with no deliveries misses after the due date', () => {
    const milestone = { status: 'pending' as const, dueDate: '2027-01-15' };
    expect(effectiveMilestoneStatus(milestone, '2027-01-15')).toBe('pending');
    expect(effectiveMilestoneStatus(milestone, '2027-01-16')).toBe('missed');
  });

  it('fulfilment requires every milestone met (and at least one)', () => {
    expect(allMilestonesMet([])).toBe(false);
    expect(allMilestonesMet([{ status: 'met' }, { status: 'met' }])).toBe(true);
    expect(allMilestonesMet([{ status: 'met' }, { status: 'partial' }])).toBe(false);
  });
});

describe('offtake milestone plan validation', () => {
  const contract = { qtyKg: 10_000, windowStart: '2027-01-01', windowEnd: '2027-06-30' };

  it('accepts a contiguous plan covering exactly the contracted volume', () => {
    expect(() =>
      validateMilestonePlan(
        [
          { seq: 1, dueDate: '2027-03-31', qtyKg: 4_000 },
          { seq: 2, dueDate: '2027-06-30', qtyKg: 6_000 }
        ],
        contract
      )
    ).not.toThrow();
  });

  it('rejects plans that under- or over-cover the contracted volume', () => {
    expect(() =>
      validateMilestonePlan([{ seq: 1, dueDate: '2027-03-31', qtyKg: 9_999 }], contract)
    ).toThrow(/sum to 9999 kg/);
    expect(() =>
      validateMilestonePlan(
        [
          { seq: 1, dueDate: '2027-03-31', qtyKg: 6_000 },
          { seq: 2, dueDate: '2027-06-30', qtyKg: 6_000 }
        ],
        contract
      )
    ).toThrow(/sum to 12000 kg/);
  });

  it('rejects non-contiguous or non-1-based seq', () => {
    expect(() =>
      validateMilestonePlan(
        [
          { seq: 1, dueDate: '2027-03-31', qtyKg: 5_000 },
          { seq: 3, dueDate: '2027-06-30', qtyKg: 5_000 }
        ],
        contract
      )
    ).toThrow(/1-based and contiguous/);
    expect(() =>
      validateMilestonePlan([{ seq: 0, dueDate: '2027-03-31', qtyKg: 10_000 }], contract)
    ).toThrow(/1-based and contiguous/);
  });

  it('rejects due dates outside the delivery window', () => {
    expect(() =>
      validateMilestonePlan([{ seq: 1, dueDate: '2026-12-31', qtyKg: 10_000 }], contract)
    ).toThrow(/inside the contract window/);
    expect(() =>
      validateMilestonePlan([{ seq: 1, dueDate: '2027-07-01', qtyKg: 10_000 }], contract)
    ).toThrow(/inside the contract window/);
  });

  it('rejects empty plans and non-positive quantities', () => {
    expect(() => validateMilestonePlan([], contract)).toThrow(/At least one/);
    expect(() =>
      validateMilestonePlan([{ seq: 1, dueDate: '2027-03-31', qtyKg: 0 }], contract)
    ).toThrow(/positive integer/);
  });
});

describe('offtake helpers', () => {
  it('validates ISO calendar dates without regexes', () => {
    expect(isIsoCalendarDate('2027-03-31')).toBe(true);
    expect(isIsoCalendarDate('2027-3-31')).toBe(false);
    expect(isIsoCalendarDate('2027-13-01')).toBe(false);
    expect(isIsoCalendarDate('2027-00-10')).toBe(false);
    expect(isIsoCalendarDate('2027-02-00')).toBe(false);
    expect(isIsoCalendarDate('not-a-date')).toBe(false);
    expect(isIsoCalendarDate('2027/03/31')).toBe(false);
  });

  it('derives deterministic ledger account codes and idempotency keys', () => {
    expect(buyerEscrowAccountCode('org-buyer')).toBe('org:org-buyer:offtake_escrow');
    expect(contractEscrowLiabilityAccountCode('offtake-1')).toBe('offtake:offtake-1:escrow_liability');
    expect(coopReceivableAccountCode('coop-1')).toBe('coop:coop-1:offtake_receivable');
    expect(deliveryLedgerIdempotencyKey('key-1')).toBe('offtake-delivery:key-1');
    expect(settlementLedgerIdempotencyKey('escrow-1')).toBe('offtake-settle:escrow-1');
  });
});
