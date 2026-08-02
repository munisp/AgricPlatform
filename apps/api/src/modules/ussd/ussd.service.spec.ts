import { describe, expect, it, vi } from 'vitest';
import type { Course, Opportunity } from '@agric-platform/shared';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { createInMemoryUssdSessionRepository } from '../../database/repositories/ussd-session.repository.js';
import type { LearningService } from '../learning/learning.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';
import { resolveUssdDriver, UssdService, USSD_SESSION_TTL_MS } from './ussd.service.js';

const ENABLED_ENV = {
  USSD_DRIVER: 'live',
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
  }
];

const OPPORTUNITIES: Opportunity[] = [
  {
    id: 'opp-1',
    title: 'BOI Youth Agri Grant',
    type: 'grant',
    description: 'Grant',
    states: [],
    valueChains: [],
    eligibility: [],
    deadline: '2025-07-01',
    isActive: true
  }
];

const COURSES: Course[] = [
  {
    id: 'course-agronomy101',
    title: 'Agronomy Basics',
    category: 'agronomy',
    level: 'beginner',
    durationMinutes: 60,
    language: 'en',
    enrolmentCount: 0,
    offlineAvailable: true
  }
];

function build(overrides: { enrol?: LearningService['enrol']; env?: NodeJS.ProcessEnv } = {}) {
  const users = new UsersService(createInMemoryUserRepository());
  const opportunities = {
    all: async () => OPPORTUNITIES
  } as unknown as OpportunitiesService;
  const learning = {
    allCourses: async () => COURSES,
    enrol: overrides.enrol ?? vi.fn(async () => ({ id: 'enrol-1' }))
  } as unknown as LearningService;
  const sessions = createInMemoryUssdSessionRepository();
  const prices = createInMemoryCommodityPriceRepository(PRICES);
  const service = new UssdService(
    users,
    opportunities,
    learning,
    sessions,
    prices,
    overrides.env ?? ENABLED_ENV
  );
  return { service, users, sessions, learning };
}

describe('resolveUssdDriver (fail-closed)', () => {
  it('is disabled on the default stub flag', () => {
    expect(resolveUssdDriver({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveUssdDriver({ USSD_DRIVER: 'stub' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('enables only with live|sandbox AND both credentials', () => {
    expect(resolveUssdDriver(ENABLED_ENV).enabled).toBe(true);
    expect(
      resolveUssdDriver({ USSD_DRIVER: 'sandbox', AT_API_KEY: 'k', AT_USERNAME: 'u' } as NodeJS.ProcessEnv)
        .enabled
    ).toBe(true);
    const partial = resolveUssdDriver({ USSD_DRIVER: 'live', AT_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(partial.enabled).toBe(false);
    expect(partial.missing).toEqual(['AT_USERNAME']);
  });

  it('treats unknown flags as disabled', () => {
    expect(resolveUssdDriver({ USSD_DRIVER: 'yes' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('throws at boot in production when the driver is set without credentials', () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        build({ env: { USSD_DRIVER: 'live' } as NodeJS.ProcessEnv })
      ).toThrowError(/missing configuration.*AT_API_KEY, AT_USERNAME/);
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it('stays constructible outside production even with missing credentials (endpoint disabled)', () => {
    const { service } = build({ env: { USSD_DRIVER: 'live' } as NodeJS.ProcessEnv });
    expect(service.driverConfig.enabled).toBe(false);
    expect(service.driverConfig.missing).toEqual(['AT_API_KEY', 'AT_USERNAME']);
  });
});

describe('UssdService.handleCallback', () => {
  it('walks the full registration traversal and creates a tier-0 user', async () => {
    const { service, users } = build();
    const session = { sessionId: 's-1', phoneNumber: '+234801' };
    const open = await service.handleCallback({ ...session, text: '' });
    expect(open).toContain('CON Welcome');
    expect(await service.handleCallback({ ...session, text: '1' })).toContain('full name');
    expect(await service.handleCallback({ ...session, text: '1*Amina Bello' })).toContain('state');
    expect(await service.handleCallback({ ...session, text: '1*Amina Bello*Kano' })).toContain('role');
    const done = await service.handleCallback({ ...session, text: '1*Amina Bello*Kano*1' });
    expect(done).toContain('END Registration complete');

    const user = await users.findByPhone('+234801');
    expect(user).toBeDefined();
    expect(user?.fullName).toBe('Amina Bello');
    expect(user?.roles).toEqual(['farmer']);
    expect(user?.kycTier).toBe('tier_0');
    expect(user?.preferredLanguage).toBe('en');
  });

  it('is idempotent on sessionId + cumulative text (replays do not re-register)', async () => {
    const { service, users } = build();
    const session = { sessionId: 's-2', phoneNumber: '+234802' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '1' });
    await service.handleCallback({ ...session, text: '1*Amina Bello' });
    await service.handleCallback({ ...session, text: '1*Amina Bello*Kano' });
    const first = await service.handleCallback({ ...session, text: '1*Amina Bello*Kano*1' });
    const replay = await service.handleCallback({ ...session, text: '1*Amina Bello*Kano*1' });
    expect(replay).toBe(first);
    // The replay returned the cached response; no second user was created.
    const registered = (await users.list({})).data.filter((user) => user.phone === '+234802');
    expect(registered).toHaveLength(1);
  });

  it('tells an already-registered number on re-registration', async () => {
    const { service, users } = build();
    await users.create({
      phone: '+234803',
      fullName: 'Existing User',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const session = { sessionId: 's-3', phoneNumber: '+234803' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '1' });
    await service.handleCallback({ ...session, text: '1*Another Name' });
    await service.handleCallback({ ...session, text: '1*Another Name*Lagos' });
    const done = await service.handleCallback({ ...session, text: '1*Another Name*Lagos*1' });
    expect(done).toBe('END This phone number is already registered.');
  });

  it('serves the latest price per crop', async () => {
    const { service } = build();
    const session = { sessionId: 's-4', phoneNumber: '+234804' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '2' });
    const price = await service.handleCallback({ ...session, text: '2*1' });
    expect(price).toContain('Maize: NGN 47,000'); // latest observation wins
    expect(price.startsWith('END ')).toBe(true);
  });

  it('lists open opportunities', async () => {
    const { service } = build();
    const session = { sessionId: 's-5', phoneNumber: '+234805' };
    await service.handleCallback({ ...session, text: '' });
    const list = await service.handleCallback({ ...session, text: '3' });
    expect(list).toContain('1 BOI Youth Agri Grant');
  });

  it('confirms course enrolment for a registered phone', async () => {
    const enrol = vi.fn(async () => ({ id: 'enrol-9' }));
    const { service, users } = build({ enrol: enrol as unknown as LearningService['enrol'] });
    const user = await users.create({
      phone: '+234806',
      fullName: 'Enrolled Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const session = { sessionId: 's-6', phoneNumber: '+234806' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '4' });
    await service.handleCallback({ ...session, text: '4*agronomy101' });
    const done = await service.handleCallback({ ...session, text: '4*agronomy101*1' });
    expect(done).toContain('END Enrolment confirmed');
    expect(enrol).toHaveBeenCalledWith('course-agronomy101', user.id);
  });

  it('requires registration before enrolment', async () => {
    const { service } = build();
    const session = { sessionId: 's-7', phoneNumber: '+234807' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '4' });
    await service.handleCallback({ ...session, text: '4*agronomy101' });
    const done = await service.handleCallback({ ...session, text: '4*agronomy101*1' });
    expect(done).toBe('END Register first (menu option 1) to enrol in a course.');
  });

  it('resets an expired session back to the opening menu', async () => {
    const { service, sessions } = build();
    const session = { sessionId: 's-8', phoneNumber: '+234808' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '1' });
    const stored = await sessions.findById('s-8');
    expect(stored?.currentMenu).toBe('register_name');
    // Force expiry, then continue the cumulative text — the engine restarts.
    await sessions.save({ ...stored!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const after = await service.handleCallback({ ...session, text: '1*Amina Bello' });
    // Fresh session: last segment 'Amina Bello' is not a main-menu choice.
    expect(after).toContain('Invalid choice.');
    expect(after).toContain('1 Register');
  });

  it('sweeps expired sessions', async () => {
    const { service, sessions } = build();
    const session = { sessionId: 's-9', phoneNumber: '+234809' };
    await service.handleCallback({ ...session, text: '' });
    const stored = await sessions.findById('s-9');
    expect(stored).toBeDefined();
    const future = new Date(Date.now() + USSD_SESSION_TTL_MS + 1000);
    expect(await service.sweepExpiredSessions(future)).toBe(1);
    expect(await sessions.findById('s-9')).toBeUndefined();
    expect(await service.sweepExpiredSessions(future)).toBe(0);
  });
});
