import { describe, expect, it } from 'vitest';
import { chapterOpsFunnel, memberFunnel, PROFILE_COMPLETE_THRESHOLD } from './funnel.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('memberFunnel', () => {
  const input = {
    users: [
      { id: 'u1', createdAt: daysAgo(10) },
      { id: 'u2', createdAt: daysAgo(20) },
      { id: 'u3', createdAt: daysAgo(30) },
      { id: 'u4', createdAt: daysAgo(200) } // outside the 90-day window
    ],
    profiles: [
      { userId: 'u1', completionScore: 80 },
      { userId: 'u2', completionScore: PROFILE_COMPLETE_THRESHOLD },
      { userId: 'u3', completionScore: 35 },
      { userId: 'u4', completionScore: 100 }
    ],
    enrolments: [{ userId: 'u1' }, { userId: 'u4' }],
    applications: [{ userId: 'u1' }],
    windowDays: 90,
    now: NOW
  };

  it('computes step counts over the window cohort only', () => {
    const steps = memberFunnel(input);
    expect(steps.map((s) => [s.key, s.count])).toEqual([
      ['registered', 3],
      ['profile_complete', 2],
      ['first_course', 1],
      ['first_application', 1]
    ]);
  });

  it('computes conversion from previous step and from registration', () => {
    const steps = memberFunnel(input);
    expect(steps[0].conversionFromPrevious).toBeNull();
    expect(steps[0].conversionFromFirst).toBe(1);
    expect(steps[1].conversionFromPrevious).toBeCloseTo(2 / 3, 4);
    expect(steps[2].conversionFromPrevious).toBeCloseTo(1 / 2, 4);
    expect(steps[3].conversionFromFirst).toBeCloseTo(1 / 3, 4);
  });

  it('treats the completion threshold as inclusive', () => {
    const steps = memberFunnel({
      ...input,
      users: [{ id: 'u2', createdAt: daysAgo(5) }],
      profiles: [{ userId: 'u2', completionScore: PROFILE_COMPLETE_THRESHOLD }],
      enrolments: [],
      applications: []
    });
    expect(steps[1].count).toBe(1);
  });

  it('window boundary is inclusive of members registered exactly windowDays ago', () => {
    const steps = memberFunnel({
      users: [{ id: 'edge', createdAt: daysAgo(30) }],
      profiles: [],
      enrolments: [],
      applications: [],
      windowDays: 30,
      now: NOW
    });
    expect(steps[0].count).toBe(1);
  });

  it('empty cohort yields zeroed steps without divide-by-zero', () => {
    const steps = memberFunnel({
      users: [],
      profiles: [],
      enrolments: [],
      applications: [],
      windowDays: 90,
      now: NOW
    });
    expect(steps.every((s) => s.count === 0 && s.conversionFromFirst === 0)).toBe(true);
    expect(steps[1].conversionFromPrevious).toBe(0);
  });
});

describe('chapterOpsFunnel', () => {
  it('computes events → RSVPs → attendance with rates', () => {
    const funnel = chapterOpsFunnel(
      [{ id: 'e1' }, { id: 'e2' }],
      [
        { eventId: 'e1', status: 'rsvp' },
        { eventId: 'e1', status: 'attended' },
        { eventId: 'e2', status: 'attended' },
        { eventId: 'other', status: 'rsvp' } // unknown event excluded
      ]
    );
    expect(funnel).toEqual({
      events: 2,
      rsvps: 3,
      attendances: 2,
      rsvpPerEvent: 1.5,
      attendanceRate: 0.6667
    });
  });

  it('handles no events and no RSVPs without divide-by-zero', () => {
    expect(chapterOpsFunnel([], [])).toEqual({
      events: 0,
      rsvps: 0,
      attendances: 0,
      rsvpPerEvent: 0,
      attendanceRate: 0
    });
  });
});
