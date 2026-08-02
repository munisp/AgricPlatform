import { describe, expect, it } from 'vitest';
import { createInMemoryAnalyticsMartRepository } from '../../database/repositories/analytics-mart.repository.js';
import { AnalyticsDepthService } from './analytics-depth.service.js';
import {
  computeLearningDaily,
  computeMarketplaceDaily,
  computeMemberKpis,
  learningCsv,
  marketplaceCsv,
  memberKpisCsv,
  MART_COLUMNS
} from './marts.js';

const DAY = '2026-08-03'; // Lagos day: [2026-08-02T23:00Z, 2026-08-03T23:00Z)

describe('computeMemberKpis', () => {
  const source = {
    users: [
      // In-day signup (01:30 UTC Aug 3 = 02:30 WAT Aug 3).
      { id: 'u1', createdAt: '2026-08-03T01:30:00.000Z', lastActiveAt: '2026-08-03T10:00:00.000Z', isVerified: true },
      // Boundary: 22:30 UTC Aug 2 = 23:30 WAT Aug 2 → previous Lagos day.
      { id: 'u2', createdAt: '2026-08-02T22:30:00.000Z', isVerified: false },
      // Boundary: 23:30 UTC Aug 2 = 00:30 WAT Aug 3 → inside the day.
      { id: 'u3', createdAt: '2026-08-02T23:30:00.000Z', isVerified: true }
    ],
    profiles: [
      { userId: 'u1', completionScore: 80 },
      { userId: 'u2', completionScore: 40 },
      { userId: 'u3', completionScore: 60 }
    ]
  };

  it('counts cumulative and in-day KPIs with Lagos day boundaries', () => {
    const row = computeMemberKpis(DAY, source);
    expect(row).toEqual({
      snapshotDate: DAY,
      totalMembers: 3,
      newMembers: 2, // u1 + u3 (u2 is previous Lagos day)
      activeMembers: 1, // only u1 has lastActiveAt in-day
      verifiedMembers: 2,
      completeProfiles: 2, // 80 and 60 (threshold inclusive)
      avgProfileCompletion: 60
    });
  });

  it('handles an empty population', () => {
    expect(computeMemberKpis(DAY, { users: [], profiles: [] })).toEqual({
      snapshotDate: DAY,
      totalMembers: 0,
      newMembers: 0,
      activeMembers: 0,
      verifiedMembers: 0,
      completeProfiles: 0,
      avgProfileCompletion: 0
    });
  });
});

describe('computeMarketplaceDaily', () => {
  it('sums GMV only for orders created inside the Lagos day', () => {
    const row = computeMarketplaceDaily(DAY, {
      listings: [{ isActive: true }, { isActive: false }, { isActive: true }],
      orders: [
        { createdAt: '2026-08-03T05:00:00.000Z', totalNaira: 10_000 },
        { createdAt: '2026-08-03T22:00:00.000Z', totalNaira: 5_500.5 },
        { createdAt: '2026-08-01T12:00:00.000Z', totalNaira: 99_999 }
      ]
    });
    expect(row).toEqual({
      snapshotDate: DAY,
      activeListings: 2,
      totalOrders: 3,
      newOrders: 2,
      gmvNaira: 15_500.5
    });
  });
});

describe('computeLearningDaily', () => {
  it('counts in-day enrolments/completions with a cumulative completion rate', () => {
    const row = computeLearningDaily(DAY, {
      courses: [{ id: 'c1' }, { id: 'c2' }],
      enrolments: [
        { enrolledAt: '2026-08-03T08:00:00.000Z' },
        { enrolledAt: '2026-07-01T08:00:00.000Z', completedAt: '2026-08-03T09:00:00.000Z' },
        { enrolledAt: '2026-07-01T08:00:00.000Z', completedAt: '2026-07-02T09:00:00.000Z' }
      ]
    });
    expect(row).toEqual({
      snapshotDate: DAY,
      totalCourses: 2,
      totalEnrolments: 3,
      newEnrolments: 1,
      completions: 1,
      completionRate: 0.6667
    });
  });
});

describe('mart CSV export (columnar, parquet-ready)', () => {
  it('emits the documented header then one CRLF row per snapshot date', () => {
    const csv = memberKpisCsv([
      {
        snapshotDate: DAY,
        totalMembers: 3,
        newMembers: 2,
        activeMembers: 1,
        verifiedMembers: 2,
        completeProfiles: 2,
        avgProfileCompletion: 60
      }
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(MART_COLUMNS.member_kpis.join(','));
    expect(lines[1]).toBe(`${DAY},3,2,1,2,2,60`);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('marketplace and learning CSVs follow their column contracts', () => {
    expect(marketplaceCsv([]).split('\r\n')[0]).toBe(MART_COLUMNS.marketplace.join(','));
    expect(learningCsv([]).split('\r\n')[0]).toBe(MART_COLUMNS.learning.join(','));
  });
});

describe('AnalyticsDepthService.snapshotMarts', () => {
  function makeService(users: unknown[]) {
    const marts = createInMemoryAnalyticsMartRepository();
    const listRepo = (rows: unknown[]) => ({ all: async () => rows });
    const service = new AnalyticsDepthService(
      listRepo(users) as never, // users
      listRepo([{ userId: 'u1', completionScore: 80 }]) as never, // profiles
      listRepo([]) as never, // enrolments
      listRepo([]) as never, // applications
      listRepo([]) as never, // chapter events
      listRepo([]) as never, // rsvps
      listRepo([{ id: 'c1' }]) as never, // courses
      listRepo([{ isActive: true }]) as never, // listings
      listRepo([{ createdAt: '2026-08-03T05:00:00.000Z', totalNaira: 1000 }]) as never, // orders
      marts
    );
    return { service, marts };
  }

  const users = [
    { id: 'u1', createdAt: '2026-08-03T01:00:00.000Z', isVerified: true, roles: ['farmer'], kycTier: 'tier_1' }
  ];

  it('is idempotent per date: re-running upserts the same rows', async () => {
    const { service, marts } = makeService(users);
    await service.snapshotMarts(DAY);
    await service.snapshotMarts(DAY);
    expect(await marts.memberKpis()).toHaveLength(1);
    expect(await marts.marketplaceDaily()).toHaveLength(1);
    expect(await marts.learningDaily()).toHaveLength(1);
    const row = (await marts.memberKpis())[0];
    expect(row).toMatchObject({ snapshotDate: DAY, totalMembers: 1, newMembers: 1 });
  });

  it('separate dates produce separate rows; range filter is inclusive', async () => {
    const { service, marts } = makeService(users);
    await service.snapshotMarts(DAY);
    await service.snapshotMarts('2026-08-04');
    expect(await marts.memberKpis()).toHaveLength(2);
    expect(await marts.memberKpis({ from: '2026-08-04', to: '2026-08-04' })).toHaveLength(1);
  });

  it('re-running after source data changed refreshes the row (re-runnable backfill)', async () => {
    const mutableUsers: unknown[] = [...users];
    const { service, marts } = makeService(mutableUsers);
    await service.snapshotMarts(DAY);
    mutableUsers.push({
      id: 'u2',
      createdAt: '2026-08-03T06:00:00.000Z',
      isVerified: false,
      roles: ['farmer'],
      kycTier: 'tier_0'
    });
    await service.snapshotMarts(DAY);
    const rows = await marts.memberKpis();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ totalMembers: 2, newMembers: 2 });
  });

  it('martCsv streams the stored rows for a range', async () => {
    const { service } = makeService(users);
    await service.snapshotMarts(DAY);
    const csv = await service.martCsv('marketplace', { from: DAY, to: DAY });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(MART_COLUMNS.marketplace.join(','));
    expect(lines[1]).toBe(`${DAY},1,1,1,1000`);
  });
});
