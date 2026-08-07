import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { computeShareOut } from './share-out.js';

describe('computeShareOut (deterministic pro-rata VSLA share-out)', () => {
  it('pays each member exactly their contribution when the pool covers it', () => {
    const payouts = computeShareOut(
      [
        { memberId: 'm1', contributedKobo: 100_000 },
        { memberId: 'm2', contributedKobo: 300_000 }
      ],
      400_000
    );
    expect(payouts.find((p) => p.memberId === 'm1')).toMatchObject({
      shareKobo: 100_000,
      residualKobo: 0
    });
    expect(payouts.find((p) => p.memberId === 'm2')).toMatchObject({
      shareKobo: 300_000,
      residualKobo: 0
    });
  });

  it('conserves the pool exactly (sum of shares == distributable)', () => {
    const payouts = computeShareOut(
      [
        { memberId: 'm1', contributedKobo: 100 },
        { memberId: 'm2', contributedKobo: 100 },
        { memberId: 'm3', contributedKobo: 100 }
      ],
      100
    );
    expect(payouts.reduce((sum, p) => sum + p.shareKobo, 0)).toBe(100);
  });

  it('splits pro-rata with largest-remainder top-up (deterministic tie-break)', () => {
    const first = computeShareOut(
      [
        { memberId: 'm1', contributedKobo: 1 },
        { memberId: 'm2', contributedKobo: 1 },
        { memberId: 'm3', contributedKobo: 1 }
      ],
      2
    );
    const second = computeShareOut(
      [
        { memberId: 'm3', contributedKobo: 1 },
        { memberId: 'm1', contributedKobo: 1 },
        { memberId: 'm2', contributedKobo: 1 }
      ],
      2
    );
    // 2/3 each → floor 0, remainder equal; memberId order decides the top-up.
    const total = (payouts: typeof first) => payouts.reduce((sum, p) => sum + p.shareKobo, 0);
    expect(total(first)).toBe(2);
    expect(total(second)).toBe(2);
    for (const memberId of ['m1', 'm2', 'm3']) {
      expect(first.find((p) => p.memberId === memberId)?.shareKobo).toBe(
        second.find((p) => p.memberId === memberId)?.shareKobo
      );
    }
  });

  it('leaves the shortfall as residual liability when loans are outstanding', () => {
    const payouts = computeShareOut(
      [
        { memberId: 'm1', contributedKobo: 200_000 },
        { memberId: 'm2', contributedKobo: 200_000 }
      ],
      100_000
    );
    for (const payout of payouts) {
      expect(payout.shareKobo + payout.residualKobo).toBe(payout.contributedKobo);
      expect(payout.shareKobo).toBe(50_000);
      expect(payout.residualKobo).toBe(150_000);
    }
  });

  it('distributes an interest surplus pro-rata above contributions', () => {
    const payouts = computeShareOut(
      [
        { memberId: 'm1', contributedKobo: 100_000 },
        { memberId: 'm2', contributedKobo: 300_000 }
      ],
      500_000
    );
    expect(payouts.reduce((sum, p) => sum + p.shareKobo, 0)).toBe(500_000);
    expect(payouts.find((p) => p.memberId === 'm1')?.shareKobo).toBe(125_000);
    expect(payouts.find((p) => p.memberId === 'm2')?.shareKobo).toBe(375_000);
    expect(payouts.every((p) => p.residualKobo === 0)).toBe(true);
  });

  it('is a pure function of its inputs (byte-stable across calls)', () => {
    const members = [
      { memberId: 'm1', contributedKobo: 12_345 },
      { memberId: 'm2', contributedKobo: 67_890 },
      { memberId: 'm3', contributedKobo: 22_222 }
    ];
    expect(computeShareOut(members, 90_000)).toEqual(computeShareOut(members, 90_000));
  });

  it('handles an empty membership and zero-contribution edge cases', () => {
    expect(computeShareOut([], 100_000)).toEqual([]);
    const payouts = computeShareOut([{ memberId: 'm1', contributedKobo: 0 }], 100_000);
    expect(payouts).toEqual([
      { memberId: 'm1', shareKobo: 0, contributedKobo: 0, residualKobo: 0 }
    ]);
  });

  it('handles a zero distributable pool without dividing by zero', () => {
    const payouts = computeShareOut([{ memberId: 'm1', contributedKobo: 50_000 }], 0);
    expect(payouts[0]).toEqual({
      memberId: 'm1',
      shareKobo: 0,
      contributedKobo: 50_000,
      residualKobo: 50_000
    });
  });

  it('rejects negative or non-integer amounts', () => {
    expect(() => computeShareOut([{ memberId: 'm1', contributedKobo: -1 }], 0)).toThrow(
      BadRequestException
    );
    expect(() => computeShareOut([{ memberId: 'm1', contributedKobo: 100 }], -1)).toThrow(
      BadRequestException
    );
    expect(() => computeShareOut([{ memberId: 'm1', contributedKobo: 1.5 }], 1)).toThrow(
      BadRequestException
    );
  });
});
