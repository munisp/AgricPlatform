import { describe, expect, it } from 'vitest';
import {
  cohortRetentionMatrix,
  isPartialWeek,
  lagosDateKey,
  lagosDayRange,
  lagosWeekStart,
  weeksBetween
} from './retention.js';

describe('lagosWeekStart (Africa/Lagos, Monday week start)', () => {
  it('maps a mid-week instant to Monday 00:00 Lagos (= Sunday 23:00 UTC)', () => {
    // Wednesday 2026-08-05 10:00 UTC → Lagos week starts Monday Aug 3.
    expect(lagosWeekStart(new Date('2026-08-05T10:00:00.000Z')).toISOString()).toBe(
      '2026-08-02T23:00:00.000Z'
    );
  });

  it('timezone edge: Sunday 23:30 UTC is already Monday in Lagos (next week)', () => {
    // Sunday 2026-08-02 23:30 UTC = Monday 2026-08-03 00:30 WAT.
    expect(lagosWeekStart(new Date('2026-08-02T23:30:00.000Z')).toISOString()).toBe(
      '2026-08-02T23:00:00.000Z'
    );
    expect(lagosDateKey(new Date('2026-08-02T23:30:00.000Z'))).toBe('2026-08-03');
  });

  it('timezone edge: Sunday 22:30 UTC is still Sunday in Lagos (previous week)', () => {
    // Sunday 2026-08-02 22:30 UTC = Sunday 23:30 WAT → week started July 27.
    expect(lagosWeekStart(new Date('2026-08-02T22:30:00.000Z')).toISOString()).toBe(
      '2026-07-26T23:00:00.000Z'
    );
  });

  it('a Monday exactly at Lagos midnight starts its own week', () => {
    expect(lagosWeekStart(new Date('2026-08-02T23:00:00.000Z')).toISOString()).toBe(
      '2026-08-02T23:00:00.000Z'
    );
  });
});

describe('lagosDayRange', () => {
  it('returns [23:00 UTC previous day, 23:00 UTC day) for a Lagos calendar day', () => {
    const { start, end } = lagosDayRange('2026-08-03');
    expect(start.toISOString()).toBe('2026-08-02T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-03T23:00:00.000Z');
  });
});

describe('weeksBetween', () => {
  it('counts whole weeks between week starts', () => {
    expect(
      weeksBetween(
        new Date('2026-07-26T23:00:00.000Z'),
        new Date('2026-08-09T23:00:00.000Z')
      )
    ).toBe(2);
  });
});

describe('cohortRetentionMatrix', () => {
  // Saturday 2026-08-08 12:00 UTC; current Lagos week starts Monday Aug 3.
  const NOW = new Date('2026-08-08T12:00:00.000Z');
  const users = [
    // Week of Aug 3: signed up + last active inside the current week.
    { id: 'u1', createdAt: '2026-08-04T10:00:00.000Z', lastActiveAt: '2026-08-08T10:00:00.000Z' },
    // Week of Jul 27: one member still active in week 1, one churned after week 0.
    { id: 'u2', createdAt: '2026-07-28T10:00:00.000Z', lastActiveAt: '2026-08-05T10:00:00.000Z' },
    { id: 'u3', createdAt: '2026-07-29T10:00:00.000Z', lastActiveAt: '2026-07-29T10:00:00.000Z' },
    // Future signup (bad event data) must be excluded.
    { id: 'u4', createdAt: '2026-08-20T00:00:00.000Z' },
    // Older than the lookback window must be excluded.
    { id: 'u5', createdAt: '2026-06-01T00:00:00.000Z', lastActiveAt: '2026-08-08T00:00:00.000Z' }
  ];

  it('builds the rolling retention matrix per signup cohort', () => {
    const matrix = cohortRetentionMatrix(users, { now: NOW, maxWeeks: 2 });
    expect(matrix.timezone).toBe('Africa/Lagos');
    expect(matrix.currentWeek).toBe('2026-08-03');
    expect(matrix.rows).toHaveLength(2);

    const older = matrix.rows[0];
    expect(older.cohortWeek).toBe('2026-07-27');
    expect(older.size).toBe(2);
    expect(older.retention).toEqual([1, 0.5]);
    expect(older.retained).toEqual([2, 1]);

    const current = matrix.rows[1];
    expect(current.cohortWeek).toBe('2026-08-03');
    expect(current.size).toBe(1);
    expect(current.retention).toEqual([1]);
  });

  it('members without lastActiveAt fall back to createdAt (retained in week 0 only)', () => {
    const matrix = cohortRetentionMatrix(
      [{ id: 'u', createdAt: '2026-07-28T10:00:00.000Z' }],
      { now: NOW, maxWeeks: 2 }
    );
    expect(matrix.rows[0].retention).toEqual([1, 0]);
  });

  it('flags the current (partial) week for each cohort', () => {
    const matrix = cohortRetentionMatrix(users, { now: NOW, maxWeeks: 2 });
    expect(isPartialWeek(matrix, '2026-08-03', 0)).toBe(true);
    expect(isPartialWeek(matrix, '2026-07-27', 1)).toBe(true);
    expect(isPartialWeek(matrix, '2026-07-27', 0)).toBe(false);
  });

  it('empty population produces an empty matrix', () => {
    const matrix = cohortRetentionMatrix([], { now: NOW, maxWeeks: 4 });
    expect(matrix.rows).toEqual([]);
    expect(matrix.currentWeek).toBe('2026-08-03');
  });
});
