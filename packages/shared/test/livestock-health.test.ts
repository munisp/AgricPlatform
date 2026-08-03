import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VACCINATION_INTERVAL_DAYS,
  VACCINATION_DUE_STATUSES,
  VACCINATION_INTERVAL_DAYS,
  VACCINATION_SCHEDULES
} from '../src/livestock-health.js';

describe('vaccination due constants', () => {
  it('defines an interval for every vaccine in every species schedule', () => {
    const scheduled = new Set(Object.values(VACCINATION_SCHEDULES).flat());
    expect(scheduled.size).toBeGreaterThan(0);
    for (const vaccine of scheduled) {
      expect(VACCINATION_INTERVAL_DAYS[vaccine], vaccine).toBeGreaterThan(0);
    }
  });

  it('keeps intervals positive whole days with a sane default', () => {
    for (const days of Object.values(VACCINATION_INTERVAL_DAYS)) {
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThan(0);
    }
    expect(DEFAULT_VACCINATION_INTERVAL_DAYS).toBe(365);
  });

  it('exposes the due statuses in urgency order', () => {
    expect(VACCINATION_DUE_STATUSES).toEqual(['overdue', 'due', 'upcoming']);
  });
});
