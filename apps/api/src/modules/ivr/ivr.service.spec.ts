import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AdvisoryItem, Enrolment, Profile } from '@agric-platform/shared';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryIvrCallRepository } from '../../database/repositories/ivr-call.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import type { AdvisoryService } from '../advisory/advisory.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { IvrController } from './ivr.controller.js';
import {
  IVR_SESSION_TTL_MS,
  IvrService,
  latestAdvisory,
  resolveIvrDriver
} from './ivr.service.js';

const ENABLED_ENV = {
  IVR_DRIVER: 'live',
  AT_API_KEY: 'test-key',
  AT_USERNAME: 'test-user'
} as unknown as NodeJS.ProcessEnv;

const PRICES = [
  {
    id: 'price-1',
    commodity: 'Maize',
    market: 'Dawanau',
    state: 'Kano',
    priceNgn: 45000,
    source: 'stub',
    observedAt: '2025-06-01T09:00:00.000Z',
    ingestedAt: '2025-06-01T10:00:00.000Z'
  },
  {
    id: 'price-2',
    commodity: 'Maize',
    market: 'Dawanau',
    state: 'Kano',
    priceNgn: 47000,
    source: 'stub',
    observedAt: '2025-06-05T09:00:00.000Z',
    ingestedAt: '2025-06-05T10:00:00.000Z'
  },
  {
    id: 'price-3',
    commodity: 'Rice',
    market: 'Mile 12',
    state: 'Lagos',
    priceNgn: 78000,
    source: 'stub',
    observedAt: '2025-06-02T09:00:00.000Z',
    ingestedAt: '2025-06-02T10:00:00.000Z'
  }
];

const ADVISORIES: AdvisoryItem[] = [
  {
    id: 'adv-national',
    kind: 'weather',
    title: 'National rainfall outlook',
    summary: 'Moderate rains expected nationwide.',
    publishedAt: '2025-06-04T08:00:00.000Z'
  },
  {
    id: 'adv-kano',
    kind: 'pest_alert',
    title: 'Fall armyworm alert',
    summary: 'Scout maize fields twice weekly.',
    state: 'Kano',
    severity: 'warning',
    publishedAt: '2025-06-03T08:00:00.000Z'
  }
];

function profile(userId: string, state = 'Kano', completionScore = 75): Profile {
  return {
    userId,
    location: { state, lga: 'Nassarawa' },
    farmingInterests: ['maize'],
    valueChains: ['grains'],
    completionScore,
    badges: []
  };
}

function build(
  overrides: {
    env?: NodeJS.ProcessEnv;
    profiles?: Map<string, Profile>;
    enrolments?: Enrolment[];
    advisories?: AdvisoryItem[];
  } = {}
) {
  const users = new UsersService(createInMemoryUserRepository());
  const profiles = {
    get: async (userId: string) => {
      const found = overrides.profiles?.get(userId);
      if (!found) {
        throw new NotFoundException('Profile not found');
      }
      return found;
    }
  } as unknown as ProfilesService;
  const advisory = {
    all: async () => overrides.advisories ?? ADVISORIES
  } as unknown as AdvisoryService;
  const learning = {
    enrolmentsForUser: async () => overrides.enrolments ?? []
  } as unknown as LearningService;
  const calls = createInMemoryIvrCallRepository();
  const prices = createInMemoryCommodityPriceRepository(PRICES);
  const service = new IvrService(
    users,
    profiles,
    advisory,
    learning,
    calls,
    prices,
    overrides.env ?? ENABLED_ENV
  );
  return { service, users, calls };
}

describe('resolveIvrDriver (fail-closed)', () => {
  it('is disabled on the default stub flag', () => {
    expect(resolveIvrDriver({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveIvrDriver({ IVR_DRIVER: 'stub' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('enables only with live|sandbox AND both credentials', () => {
    expect(resolveIvrDriver(ENABLED_ENV).enabled).toBe(true);
    expect(
      resolveIvrDriver({ IVR_DRIVER: 'sandbox', AT_API_KEY: 'k', AT_USERNAME: 'u' } as NodeJS.ProcessEnv)
        .enabled
    ).toBe(true);
    const partial = resolveIvrDriver({ IVR_DRIVER: 'live', AT_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(partial.enabled).toBe(false);
    expect(partial.missing).toEqual(['AT_USERNAME']);
  });

  it('treats unknown flags as disabled', () => {
    expect(resolveIvrDriver({ IVR_DRIVER: 'yes' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('throws at boot in production when the driver is set without credentials', () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        build({ env: { IVR_DRIVER: 'live' } as NodeJS.ProcessEnv })
      ).toThrowError(/missing configuration.*AT_API_KEY, AT_USERNAME/);
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it('stays constructible outside production even with missing credentials (endpoint disabled)', () => {
    const { service } = build({ env: { IVR_DRIVER: 'live' } as NodeJS.ProcessEnv });
    expect(service.driverConfig.enabled).toBe(false);
    expect(service.driverConfig.missing).toEqual(['AT_API_KEY', 'AT_USERNAME']);
  });

  it('controller returns 404 while the driver is disabled', async () => {
    const { service } = build({ env: {} as NodeJS.ProcessEnv });
    const controller = new IvrController(service);
    await expect(
      controller.callback({ sessionId: 's-x', callerNumber: '+234801' })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('controller serves Voice XML when enabled', async () => {
    const { service } = build();
    const controller = new IvrController(service);
    const xml = await controller.callback({ sessionId: 's-c', callerNumber: '+234801' });
    expect(xml).toContain('<Response>');
    expect(xml).toContain('Welcome to AgricPlatform voice service.');
  });
});

describe('IvrService.handleCallback', () => {
  it('opens with the welcome Say and a 5s GetDigits main menu', async () => {
    const { service } = build();
    const xml = await service.handleCallback({ sessionId: 's-1', callerNumber: '+234801' });
    expect(xml).toContain('<Say>Welcome to AgricPlatform voice service.</Say>');
    expect(xml).toContain('<GetDigits timeout="5" numDigits="1">');
    expect(xml).toContain('Press 1 for commodity prices.');
    expect(xml).toContain('Press 0 to speak to an agent.');
  });

  it('walks the full price-check traversal and says the latest price', async () => {
    const { service, calls } = build();
    const call = { sessionId: 's-2', callerNumber: '+234802' };
    await service.handleCallback(call);
    const menu = await service.handleCallback({ ...call, dtmfDigits: '1' });
    expect(menu).toContain('Press 1 for Maize.');
    expect(menu).toContain('Press 2 for Rice.');
    const price = await service.handleCallback({ ...call, dtmfDigits: '1' });
    expect(price).toContain('Maize is 47,000 naira'); // latest observation wins
    expect(price).toContain('Dawanau market, Kano');
    const record = await calls.findById('s-2');
    expect(record?.outcome).toBe('completed');
    expect(record?.dtmfHistory).toBe('1*1');
  });

  it('says the state-scoped advisory for a known caller', async () => {
    const profiles = new Map<string, Profile>();
    const { service, users } = build({ profiles });
    const user = await users.create({
      phone: '+234803',
      fullName: 'Kano Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    profiles.set(user.id, profile(user.id, 'Kano'));
    await service.handleCallback({ sessionId: 's-3', callerNumber: '+234803' });
    const xml = await service.handleCallback({
      sessionId: 's-3',
      callerNumber: '+234803',
      dtmfDigits: '2'
    });
    expect(xml).toContain('Fall armyworm alert');
    expect(xml).not.toContain('National rainfall outlook');
  });

  it('falls back to the national advisory for an unknown caller', async () => {
    const { service } = build();
    await service.handleCallback({ sessionId: 's-4', callerNumber: '+234899' });
    const xml = await service.handleCallback({
      sessionId: 's-4',
      callerNumber: '+234899',
      dtmfDigits: '2'
    });
    expect(xml).toContain('National rainfall outlook');
  });

  it('says registration status with KYC tier and profile completeness', async () => {
    const profiles = new Map<string, Profile>();
    const { service, users } = build({ profiles });
    const user = await users.create({
      phone: '+234805',
      fullName: 'Amina Bello',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    profiles.set(user.id, profile(user.id, 'Kano', 80));
    expect(user.kycTier).toBe('tier_0');
    await service.handleCallback({ sessionId: 's-5', callerNumber: '+234805' });
    const xml = await service.handleCallback({
      sessionId: 's-5',
      callerNumber: '+234805',
      dtmfDigits: '3'
    });
    expect(xml).toContain('Amina Bello');
    expect(xml).toContain('tier 0');
    expect(xml).toContain('80 percent');
  });

  it('says course enrolment status for a known caller', async () => {
    const enrolments: Enrolment[] = [
      {
        id: 'e-1',
        courseId: 'c-1',
        userId: 'u',
        progressPercent: 40,
        status: 'in_progress',
        enrolledAt: '2025-05-01T00:00:00.000Z'
      },
      {
        id: 'e-2',
        courseId: 'c-2',
        userId: 'u',
        progressPercent: 100,
        status: 'completed',
        enrolledAt: '2025-04-01T00:00:00.000Z',
        completedAt: '2025-05-20T00:00:00.000Z'
      }
    ];
    const setup = build({ enrolments });
    await setup.users.create({
      phone: '+234806',
      fullName: 'Learning Farmer',
      roles: ['student'],
      preferredLanguage: 'en'
    });
    await setup.service.handleCallback({ sessionId: 's-6', callerNumber: '+234806' });
    const xml = await setup.service.handleCallback({
      sessionId: 's-6',
      callerNumber: '+234806',
      dtmfDigits: '4'
    });
    expect(xml).toContain('enrolled in 2 courses');
    expect(xml).toContain('1 in progress');
    expect(xml).toContain('1 completed');
  });

  it('tells an unregistered number to register first (status options)', async () => {
    const { service } = build();
    await service.handleCallback({ sessionId: 's-7', callerNumber: '+234807' });
    const xml = await service.handleCallback({
      sessionId: 's-7',
      callerNumber: '+234807',
      dtmfDigits: '3'
    });
    expect(xml).toContain('not registered');
  });

  it('escalates on 0 and marks the call for an agent callback', async () => {
    const { service, calls } = build();
    const call = { sessionId: 's-8', callerNumber: '+234808' };
    await service.handleCallback(call);
    const xml = await service.handleCallback({ ...call, dtmfDigits: '0' });
    expect(xml).toContain('<Enqueue/>');
    expect(xml).toContain('connect you to an AgricPlatform agent');
    const record = await calls.findById('s-8');
    expect(record?.outcome).toBe('escalated');
    expect(record?.currentMenu).toBe('main');
  });

  it('re-prompts on invalid digits and ends politely after three strikes', async () => {
    const { service, calls } = build();
    const call = { sessionId: 's-9', callerNumber: '+234809' };
    await service.handleCallback(call);
    const first = await service.handleCallback({ ...call, dtmfDigits: 'x' });
    expect(first).toContain('not a valid choice');
    await service.handleCallback({ ...call, dtmfDigits: 'y' });
    const third = await service.handleCallback({ ...call, dtmfDigits: 'z' });
    expect(third).toContain('Too many invalid entries');
    expect(third).not.toContain('<GetDigits');
    const record = await calls.findById('s-9');
    expect(record?.outcome).toBe('abandoned');
  });

  it('handles a GetDigits timeout (empty dtmfDigits) as a strike', async () => {
    const { service } = build();
    const call = { sessionId: 's-10', callerNumber: '+234810' };
    await service.handleCallback(call);
    const xml = await service.handleCallback({ ...call, dtmfDigits: '' });
    expect(xml).toContain('We did not hear any input.');
    expect(xml).toContain('<GetDigits');
  });

  it('is idempotent on terminal replays (same sessionId, unchanged history)', async () => {
    const { service, calls } = build();
    const call = { sessionId: 's-11', callerNumber: '+234811' };
    await service.handleCallback(call);
    const first = await service.handleCallback({ ...call, dtmfDigits: '0' });
    expect(first).toContain('<Enqueue/>');
    // AT retries the terminal POST: cached response, no history growth, no
    // second escalation side effect.
    const replay = await service.handleCallback({ ...call, dtmfDigits: '0' });
    expect(replay).toBe(first);
    const record = await calls.findById('s-11');
    expect(record?.dtmfHistory).toBe('0');
    expect(record?.outcome).toBe('escalated');
  });

  it('treats a repeated opening ring (no dtmfDigits) as an idempotent welcome', async () => {
    const { service } = build();
    const call = { sessionId: 's-11b', callerNumber: '+234811' };
    const first = await service.handleCallback(call);
    await service.handleCallback({ ...call, dtmfDigits: '1' });
    const reopened = await service.handleCallback(call);
    expect(reopened).toBe(first);
    expect(reopened).toContain('Welcome to AgricPlatform voice service.');
  });

  it('acknowledges the final hangup notification with an empty Response', async () => {
    const { service, calls } = build();
    const call = { sessionId: 's-12', callerNumber: '+234812' };
    await service.handleCallback(call);
    const xml = await service.handleCallback({ ...call, isActive: '0' });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    const record = await calls.findById('s-12');
    expect(record?.currentMenu).toBe('main');
  });

  it('restarts an expired call back at the welcome menu', async () => {
    const { service, calls } = build();
    const call = { sessionId: 's-13', callerNumber: '+234813' };
    await service.handleCallback(call);
    await service.handleCallback({ ...call, dtmfDigits: '1' });
    const stored = await calls.findById('s-13');
    expect(stored?.currentMenu).toBe('price_select');
    // Force expiry, then send more digits — the engine restarts at welcome.
    await calls.save({ ...stored!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const after = await service.handleCallback({ ...call, dtmfDigits: '1' });
    expect(after).toContain('Welcome to AgricPlatform voice service.');
    expect((await calls.findById('s-13'))?.dtmfHistory).toBe('');
  });

  it('sweeps expired calls', async () => {
    const { service, calls } = build();
    await service.handleCallback({ sessionId: 's-14', callerNumber: '+234814' });
    expect(await calls.findById('s-14')).toBeDefined();
    const future = new Date(Date.now() + IVR_SESSION_TTL_MS + 1000);
    expect(await service.sweepExpiredCalls(future)).toBe(1);
    expect(await calls.findById('s-14')).toBeUndefined();
    expect(await service.sweepExpiredCalls(future)).toBe(0);
  });
});

describe('latestAdvisory (scoping)', () => {
  it('prefers the caller state over a newer national item', () => {
    const pick = latestAdvisory(ADVISORIES, 'Kano');
    expect(pick?.title).toBe('Fall armyworm alert');
  });

  it('falls back to national when the state has no advisory', () => {
    const pick = latestAdvisory(ADVISORIES, 'Lagos');
    expect(pick?.title).toBe('National rainfall outlook');
  });

  it('returns national for unknown callers and undefined when empty', () => {
    expect(latestAdvisory(ADVISORIES)?.title).toBe('National rainfall outlook');
    expect(latestAdvisory([], 'Kano')).toBeUndefined();
  });
});
