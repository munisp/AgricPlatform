import { describe, expect, it } from 'vitest';
import {
  computeSlaDueAt,
  slaConfigFromEnv,
  SLA_BUSINESS_DAYS_DEFAULT,
  type SlaBusinessHoursConfig
} from './sla-schedule.js';

/**
 * SLA business-hours clock vectors (Stage 27 innovation #19). All instants
 * are UTC; 2026-09-11 is a Friday, 2026-09-12 a Saturday, 2026-09-14 a
 * Monday.
 */
const CONFIG: SlaBusinessHoursConfig = {
  slaBusinessHours: 4,
  windowStartHour: 8,
  windowEndHour: 17,
  businessDays: [1, 2, 3, 4, 5]
};

describe('computeSlaDueAt (business-hours aware)', () => {
  it('counts business hours inside the same-day window', () => {
    const due = computeSlaDueAt(new Date('2026-09-11T09:00:00Z'), CONFIG);
    expect(due.toISOString()).toBe('2026-09-11T13:00:00.000Z');
  });

  it('starts counting at window open when raised before hours', () => {
    const due = computeSlaDueAt(new Date('2026-09-11T06:30:00Z'), CONFIG);
    expect(due.toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('rolls the remainder to the next business day', () => {
    // 15:30 Friday: 1.5h remain in the window; the other 2.5h land Monday.
    const due = computeSlaDueAt(new Date('2026-09-11T15:30:00Z'), CONFIG);
    expect(due.toISOString()).toBe('2026-09-14T10:30:00.000Z');
  });

  it('skips weekends entirely (Friday evening → Monday)', () => {
    const due = computeSlaDueAt(new Date('2026-09-11T18:00:00Z'), CONFIG);
    expect(due.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('skips a non-business start day (Saturday → Monday window)', () => {
    const due = computeSlaDueAt(new Date('2026-09-12T10:00:00Z'), CONFIG);
    expect(due.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('spans multiple days when the SLA exceeds one window', () => {
    const long: SlaBusinessHoursConfig = { ...CONFIG, slaBusinessHours: 20 };
    // 9h/day window: Mon 09:00 start consumes 8h, Tuesday 9h, leaving 3h
    // for Wednesday morning (08:00 + 3h = 11:00).
    const due = computeSlaDueAt(new Date('2026-09-14T09:00:00Z'), long);
    expect(due.toISOString()).toBe('2026-09-16T11:00:00.000Z');
  });

  it('honours sub-hour precision', () => {
    const fine: SlaBusinessHoursConfig = { ...CONFIG, slaBusinessHours: 0.5 };
    const due = computeSlaDueAt(new Date('2026-09-14T16:45:00Z'), fine);
    // 15 minutes remain Monday; the other 15 land Tuesday morning.
    expect(due.toISOString()).toBe('2026-09-15T08:15:00.000Z');
  });

  it('fails visibly on a degenerate config (due immediately, never silent)', () => {
    const broken: SlaBusinessHoursConfig = { ...CONFIG, businessDays: [] };
    const start = new Date('2026-09-14T09:00:00Z');
    expect(computeSlaDueAt(start, broken).getTime()).toBe(start.getTime());
  });
});

describe('slaConfigFromEnv', () => {
  it('defaults to 4 business hours, Mon–Fri 08:00–17:00 UTC', () => {
    const config = slaConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.slaBusinessHours).toBe(4);
    expect(config.windowStartHour).toBe(8);
    expect(config.windowEndHour).toBe(17);
    expect(config.businessDays).toEqual(SLA_BUSINESS_DAYS_DEFAULT);
  });

  it('parses a configured window and weekday list', () => {
    const config = slaConfigFromEnv({
      AGRONOMIST_SLA_BUSINESS_HOURS: '8',
      AGRONOMIST_SLA_WINDOW_START: '7',
      AGRONOMIST_SLA_WINDOW_END: '19',
      AGRONOMIST_SLA_BUSINESS_DAYS: '1,2,3,4,5,6'
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({
      slaBusinessHours: 8,
      windowStartHour: 7,
      windowEndHour: 19,
      businessDays: [1, 2, 3, 4, 5, 6]
    });
  });

  it('falls back sanely on malformed values', () => {
    const config = slaConfigFromEnv({
      AGRONOMIST_SLA_BUSINESS_HOURS: 'not-a-number',
      AGRONOMIST_SLA_WINDOW_START: '99',
      AGRONOMIST_SLA_WINDOW_END: '2',
      AGRONOMIST_SLA_BUSINESS_DAYS: 'monday,wednesday'
    } as NodeJS.ProcessEnv);
    expect(config.slaBusinessHours).toBe(4);
    expect(config.windowStartHour).toBe(8);
    expect(config.windowEndHour).toBe(17);
    expect(config.businessDays).toEqual(SLA_BUSINESS_DAYS_DEFAULT);
  });
});
