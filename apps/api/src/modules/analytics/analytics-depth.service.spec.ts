import { describe, expect, it } from 'vitest';
import { createInMemoryAnalyticsMartRepository } from '../../database/repositories/analytics-mart.repository.js';
import { AnalyticsDepthService } from './analytics-depth.service.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function makeService(data: {
  users?: unknown[];
  profiles?: unknown[];
  enrolments?: unknown[];
  applications?: unknown[];
  events?: unknown[];
  rsvps?: unknown[];
}) {
  const listRepo = (rows: unknown[]) => ({ all: async () => rows });
  return new AnalyticsDepthService(
    listRepo(data.users ?? []) as never,
    listRepo(data.profiles ?? []) as never,
    listRepo(data.enrolments ?? []) as never,
    listRepo(data.applications ?? []) as never,
    listRepo(data.events ?? []) as never,
    listRepo(data.rsvps ?? []) as never,
    listRepo([]) as never,
    listRepo([]) as never,
    listRepo([]) as never,
    createInMemoryAnalyticsMartRepository()
  );
}

const users = [
  {
    id: 'u1',
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActiveAt: '2026-08-08T09:00:00.000Z',
    roles: ['farmer'],
    kycTier: 'tier_1',
    isVerified: true
  },
  {
    id: 'u2',
    createdAt: '2026-07-28T10:00:00.000Z',
    roles: ['farmer', 'buyer'],
    kycTier: 'tier_0',
    isVerified: false
  }
];

const profiles = [
  { userId: 'u1', completionScore: 80, location: { state: 'Kano', lga: 'Dala' }, farmingInterests: ['maize'] },
  { userId: 'u2', completionScore: 40, location: { state: 'Lagos', lga: 'Ikeja' }, farmingInterests: ['maize', 'rice'] }
];

describe('AnalyticsDepthService.segment', () => {
  it('segments members by role with percentages of the member population', async () => {
    const service = makeService({ users });
    const result = await service.segment('role');
    expect(result.total).toBe(2);
    expect(result.segments).toEqual([
      { key: 'farmer', count: 2, percentage: 100 },
      { key: 'buyer', count: 1, percentage: 50 }
    ]);
  });

  it('segments by KYC tier and signup cohort month (Africa/Lagos)', async () => {
    const service = makeService({ users });
    const kyc = await service.segment('kyc_tier');
    expect(kyc.segments.map((s) => [s.key, s.count])).toEqual(
      expect.arrayContaining([
        ['tier_0', 1],
        ['tier_1', 1]
      ])
    );
    const cohort = await service.segment('cohort');
    expect(cohort.segments.map((s) => [s.key, s.count])).toEqual(
      expect.arrayContaining([
        ['2026-07', 1],
        ['2026-08', 1]
      ])
    );
  });

  it('segments by crop across profile farming interests', async () => {
    const service = makeService({ users, profiles });
    const crop = await service.segment('crop');
    expect(crop.segments).toEqual([
      { key: 'maize', count: 2, percentage: 100 },
      { key: 'rice', count: 1, percentage: 50 }
    ]);
  });
});

describe('AnalyticsDepthService.funnel / chapterFunnel / retention', () => {
  it('runs the member funnel over repository data with the default window', async () => {
    const service = makeService({
      users,
      profiles,
      enrolments: [{ userId: 'u1' }],
      applications: [{ userId: 'u1' }]
    });
    const result = await service.funnel(90, NOW);
    expect(result.steps.map((s) => s.count)).toEqual([2, 1, 1, 1]);
  });

  it('runs the chapter-ops funnel over events and RSVPs', async () => {
    const service = makeService({
      events: [{ id: 'e1' }],
      rsvps: [
        { eventId: 'e1', status: 'rsvp' },
        { eventId: 'e1', status: 'attended' }
      ]
    });
    const funnel = await service.chapterFunnel();
    expect(funnel).toMatchObject({ events: 1, rsvps: 2, attendances: 1, attendanceRate: 0.5 });
  });

  it('builds the retention matrix over repository users', async () => {
    const service = makeService({ users });
    const matrix = await service.retention(4, NOW);
    expect(matrix.timezone).toBe('Africa/Lagos');
    // Both users signed up in the Lagos week starting Monday 2026-07-27
    // (Aug 1 10:00 UTC is still Saturday in WAT).
    expect(matrix.rows.map((r) => r.cohortWeek)).toEqual(['2026-07-27']);
    expect(matrix.rows[0].size).toBe(2);
  });
});
