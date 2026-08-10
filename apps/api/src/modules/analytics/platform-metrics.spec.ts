import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chapter } from '@agric-platform/shared';
import { InMemoryCreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import { AnalyticsService } from './analytics.service.js';
import { assertNoSeedPlatformMetrics, composePlatformMetrics } from './platform-metrics.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('composePlatformMetrics', () => {
  it('labels repository-computed metrics live and omits unverifiable trends', () => {
    const metrics = composePlatformMetrics({
      members: 3,
      activeChapters: 2,
      courseCompletions: 7,
      openOpportunities: 4,
      marketplaceListings: 5,
      creditProfiles: 2
    });
    expect(metrics).toHaveLength(6);
    for (const metric of metrics) {
      expect(metric.basis).toBe('live');
      expect(metric.trend).toBeUndefined();
    }
    expect(metrics.find((m) => m.key === 'members')?.value).toBe(3);
  });

  it('labels uncomputable metrics as seed fixtures (never unlabeled)', () => {
    const metrics = composePlatformMetrics({ members: 3 });
    const seed = metrics.find((m) => m.key === 'active_chapters');
    expect(seed?.basis).toBe('seed');
    expect(seed?.value).toBe(24); // the labelled fixture value
    expect(metrics.filter((m) => m.basis === 'seed')).toHaveLength(5);
  });
});

describe('assertNoSeedPlatformMetrics', () => {
  it('refuses seed metrics in production (503 fail-closed)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const metrics = composePlatformMetrics({ members: 3 });
    expect(() => assertNoSeedPlatformMetrics(metrics)).toThrow(ServiceUnavailableException);
    expect(() => assertNoSeedPlatformMetrics(metrics)).toThrow(/seed fixtures/);
  });

  it('passes all-live metrics in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const metrics = composePlatformMetrics({
      members: 1,
      activeChapters: 1,
      courseCompletions: 1,
      openOpportunities: 1,
      marketplaceListings: 1,
      creditProfiles: 1
    });
    expect(() => assertNoSeedPlatformMetrics(metrics)).not.toThrow();
  });

  it('allows labelled seed metrics outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const metrics = composePlatformMetrics({});
    expect(() => assertNoSeedPlatformMetrics(metrics)).not.toThrow();
  });
});

describe('AnalyticsService.metrics (repository-computed KPIs)', () => {
  const chapter = (id: string, active: boolean): Chapter => ({
    id,
    name: id,
    level: 'ward',
    state: 'Kano',
    memberCount: 1,
    active
  });

  function build(options: { withChapters?: boolean; withCredit?: boolean } = {}) {
    const creditProfiles = new InMemoryCreditProfileRepository();
    void creditProfiles.upsert({
      userId: 'u1',
      score: 500,
      trainingSignals: 0,
      transactionSignals: 0,
      productionSignals: 0,
      documentCount: 0,
      improvementActions: []
    });
    void creditProfiles.upsert({
      userId: 'u2',
      score: 600,
      trainingSignals: 0,
      transactionSignals: 0,
      productionSignals: 0,
      documentCount: 0,
      improvementActions: []
    });
    const service = new AnalyticsService(
      { count: async () => 3 } as never,
      {} as never,
      { completionCount: async () => 7 } as never,
      { list: async () => ({ total: 4 }) } as never,
      { activeListingCount: async () => 5 } as never,
      options.withChapters === false
        ? undefined
        : ({ all: async () => [chapter('c1', true), chapter('c2', true), chapter('c3', false)] } as never),
      options.withCredit === false ? undefined : creditProfiles
    );
    return service;
  }

  it('computes every KPI from repository counts with a live basis', async () => {
    const metrics = await build().metrics();
    expect(metrics).toEqual([
      { key: 'members', label: 'Registered members', value: 3, basis: 'live' },
      { key: 'active_chapters', label: 'Active chapters', value: 2, basis: 'live' },
      { key: 'course_completions', label: 'Course completions', value: 7, basis: 'live' },
      { key: 'opportunities', label: 'Open opportunities', value: 4, basis: 'live' },
      { key: 'marketplace_listings', label: 'Marketplace listings', value: 5, basis: 'live' },
      { key: 'credit_profiles', label: 'Credit profiles', value: 2, basis: 'live' }
    ]);
  });

  it('serves labelled seed metrics for unwired sources outside production', async () => {
    const metrics = await build({ withChapters: false, withCredit: false }).metrics();
    expect(metrics.find((m) => m.key === 'active_chapters')?.basis).toBe('seed');
    expect(metrics.find((m) => m.key === 'credit_profiles')?.basis).toBe('seed');
    expect(metrics.find((m) => m.key === 'members')?.basis).toBe('live');
  });

  it('refuses the whole KPI response in production when a source is unwired', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(build({ withCredit: false }).metrics()).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('serves all-live KPIs in production when every source is wired', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const metrics = await build().metrics();
    expect(metrics.every((m) => m.basis === 'live')).toBe(true);
  });
});
