import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Course, Opportunity } from '@agric-platform/shared';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { createInMemoryUssdSessionRepository } from '../../database/repositories/ussd-session.repository.js';
import { InMemoryKeyValueStore, type KeyValueStore } from '../../redis/key-value-store.js';
import type { LearningService } from '../learning/learning.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';
import { UssdController } from './ussd.controller.js';
import {
  resolveUssdDriver,
  UssdService,
  USSD_MENU_CACHE_TTL_MS,
  USSD_SESSION_TTL_MS
} from './ussd.service.js';

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

function build(
  overrides: {
    enrol?: LearningService['enrol'];
    env?: NodeJS.ProcessEnv;
    kv?: KeyValueStore;
  } = {}
) {
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
    overrides.env ?? ENABLED_ENV,
    undefined,
    undefined,
    undefined,
    overrides.kv ?? new InMemoryKeyValueStore()
  );
  return { service, users, sessions, learning, prices, opportunities };
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

  it('throws at boot in production when the callback token is missing (audit C2-3)', () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        build({
          env: { USSD_DRIVER: 'live', AT_API_KEY: 'k', AT_USERNAME: 'u' } as NodeJS.ProcessEnv
        })
      ).toThrowError(/missing configuration.*AT_CALLBACK_TOKEN/);
      // …a published placeholder or sub-length token is equally refused
      // (Stage 24, audit A3-1)…
      for (const weak of ['replace-me', 'local-development-only', 'secret']) {
        expect(() =>
          build({
            env: {
              USSD_DRIVER: 'live',
              AT_API_KEY: 'k',
              AT_USERNAME: 'u',
              AT_CALLBACK_TOKEN: weak
            } as NodeJS.ProcessEnv
          })
        ).toThrowError(/missing configuration.*AT_CALLBACK_TOKEN/);
      }
      // …and boots once a strong shared secret is configured.
      expect(() =>
        build({
          env: {
            USSD_DRIVER: 'live',
            AT_API_KEY: 'k',
            AT_USERNAME: 'u',
            AT_CALLBACK_TOKEN: 'callback-token-with-32-chars-min-xxx'
          } as NodeJS.ProcessEnv
        })
      ).not.toThrow();
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it('keeps tests constructible without a token outside production', () => {
    const { service } = build();
    expect(service.driverConfig.enabled).toBe(true);
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
    // OB-01c: USSD registration rides the telco channel — line possession is
    // the verification proof, so the account is verified at creation.
    expect(user?.isVerified).toBe(true);
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

  it('expires a session explicitly instead of restarting mid-flow (V-66)', async () => {
    const { service, sessions } = build();
    const session = { sessionId: 's-8', phoneNumber: '+234808' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '1' });
    const stored = await sessions.findById('s-8');
    expect(stored?.currentMenu).toBe('register_name');
    // Force expiry, then continue the cumulative text — the flow must NOT
    // silently restart from the last segment; the user gets an explicit END.
    await sessions.save({ ...stored!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const after = await service.handleCallback({ ...session, text: '1*Amina Bello' });
    expect(after).toMatch(/^END /);
    expect(after).toContain('expired');
    // A genuine fresh dial (empty text) still opens the main menu.
    const fresh = await service.handleCallback({ ...session, text: '' });
    expect(fresh).toContain('1 Register');
  });

  it('rejects out-of-order cumulative text with a re-sync END (V-66)', async () => {
    const { service } = build();
    const session = { sessionId: 's-oo', phoneNumber: '+234811' };
    await service.handleCallback({ ...session, text: '' });
    // T3 (two segments) arriving before T2 (one segment) is rejected: the
    // history cannot extend the opening dial by more than one segment.
    const reordered = await service.handleCallback({ ...session, text: '1*Amina Bello' });
    expect(reordered).toMatch(/^END /);
    expect(reordered).toContain('out of sync');
    // In-order turns still work: T2 then T3 extends by exactly one segment.
    const t2 = await service.handleCallback({ ...session, text: '1' });
    expect(t2).toMatch(/^CON /);
    const t3 = await service.handleCallback({ ...session, text: '1*Amina Bello' });
    expect(t3).toMatch(/^CON |^END /);
    expect(t3).not.toContain('out of sync');
  });

  it('rejects a rewritten cumulative history while keeping session state (V-66)', async () => {
    const { service, sessions } = build();
    const session = { sessionId: 's-rw', phoneNumber: '+234812' };
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '1' });
    // Same segment count but a different prefix — not an extension.
    const rewritten = await service.handleCallback({ ...session, text: '2*evil' });
    expect(rewritten).toContain('out of sync');
    // State was not advanced by the rejected turn.
    const stored = await sessions.findById('s-rw');
    expect(stored?.currentMenu).toBe('register_name');
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

  it('binds a session to its opening phone number and rejects mid-session changes (C2-3)', async () => {
    const { service, sessions } = build();
    await service.handleCallback({ sessionId: 's-10', phoneNumber: '+234810', text: '' });
    await service.handleCallback({ sessionId: 's-10', phoneNumber: '+234810', text: '1' });
    // A different phone number cannot continue (or replay) this session.
    await expect(
      service.handleCallback({ sessionId: 's-10', phoneNumber: '+234899', text: '1*Amina Bello' })
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.handleCallback({ sessionId: 's-10', phoneNumber: '+234899', text: '1' })
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // The binding is unchanged: the original phone still owns the session.
    expect((await sessions.findById('s-10'))?.phone).toBe('+234810');
    const next = await service.handleCallback({
      sessionId: 's-10',
      phoneNumber: '+234810',
      text: '1*Amina Bello'
    });
    expect(next).toContain('state');
  });

  it('lets a different phone reuse the sessionId after the session expired', async () => {
    const { service, sessions } = build();
    await service.handleCallback({ sessionId: 's-11', phoneNumber: '+234811', text: '' });
    const stored = await sessions.findById('s-11');
    await sessions.save({ ...stored!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const open = await service.handleCallback({ sessionId: 's-11', phoneNumber: '+234899', text: '' });
    expect(open).toContain('CON Welcome');
    expect((await sessions.findById('s-11'))?.phone).toBe('+234899');
  });
});

describe('UssdController callback token gate (audit C2-3)', () => {
  const TOKEN = 'ussd-controller-test-token';

  async function withToken<T>(fn: () => Promise<T> | T): Promise<T> {
    const saved = process.env.AT_CALLBACK_TOKEN;
    process.env.AT_CALLBACK_TOKEN = TOKEN;
    try {
      return await fn();
    } finally {
      if (saved === undefined) {
        delete process.env.AT_CALLBACK_TOKEN;
      } else {
        process.env.AT_CALLBACK_TOKEN = saved;
      }
    }
  }

  it('rejects callbacks without or with a wrong token (401) once configured', async () => {
    const { service } = build();
    const controller = new UssdController(service);
    await withToken(async () => {
      await expect(
        controller.callback({ sessionId: 's-g1', phoneNumber: '+234820', text: '' })
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        controller.callback({ sessionId: 's-g1', phoneNumber: '+234820', text: '' }, 'wrong')
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('serves callbacks carrying the token as a query param or header', async () => {
    const { service } = build();
    const controller = new UssdController(service);
    await withToken(async () => {
      const viaQuery = await controller.callback(
        { sessionId: 's-g2', phoneNumber: '+234821', text: '' },
        TOKEN
      );
      expect(viaQuery).toContain('CON Welcome');
      const viaHeader = await controller.callback(
        { sessionId: 's-g3', phoneNumber: '+234822', text: '' },
        undefined,
        TOKEN
      );
      expect(viaHeader).toContain('CON Welcome');
    });
  });

  it('stays 404 while the driver is disabled, regardless of the token', async () => {
    const { service } = build({ env: {} as NodeJS.ProcessEnv });
    const controller = new UssdController(service);
    await withToken(async () => {
      await expect(
        controller.callback({ sessionId: 's-g4', phoneNumber: '+234823', text: '' }, TOKEN)
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('UssdController production hardening (V-19)', () => {
  const STRONG = 'prod-callback-token-with-32-chars-min';

  async function inProd<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.AT_CALLBACK_TOKEN = STRONG;
    try {
      return await fn();
    } finally {
      process.env = saved;
    }
  }

  function buildProd() {
    return build({
      env: { ...ENABLED_ENV, AT_CALLBACK_TOKEN: STRONG } as unknown as NodeJS.ProcessEnv
    });
  }

  it('rejects the query-string token in production (header-only)', async () => {
    const { service } = buildProd();
    const controller = new UssdController(service);
    await inProd(async () => {
      await expect(
        controller.callback(
          { sessionId: 's-p1', phoneNumber: '+234830', text: '' },
          STRONG,
          undefined,
          String(Date.now()),
          'nonce-p1-unique'
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('requires a fresh timestamp and a unique nonce; a verbatim replay 401s', async () => {
    const { service } = buildProd();
    const controller = new UssdController(service);
    await inProd(async () => {
      const ts = String(Date.now());
      const ok = await controller.callback(
        { sessionId: 's-p2', phoneNumber: '+234831', text: '' },
        undefined,
        STRONG,
        ts,
        'nonce-p2-unique'
      );
      expect(ok).toContain('CON Welcome');
      // A captured callback replayed verbatim (same nonce) is refused.
      await expect(
        controller.callback(
          { sessionId: 's-p2', phoneNumber: '+234831', text: '' },
          undefined,
          STRONG,
          ts,
          'nonce-p2-unique'
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Missing timestamp/nonce is refused.
      await expect(
        controller.callback(
          { sessionId: 's-p3', phoneNumber: '+234832', text: '' },
          undefined,
          STRONG
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // A stale timestamp outside the window is refused.
      await expect(
        controller.callback(
          { sessionId: 's-p4', phoneNumber: '+234833', text: '' },
          undefined,
          STRONG,
          String(Date.now() - 60 * 60 * 1000),
          'nonce-p4-unique'
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});

describe('UssdService registration rate limit (V-19, production profile)', () => {
  it('caps per-phone registration effects and keeps non-production unlimited', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { service } = build({
        env: {
          ...ENABLED_ENV,
          AT_CALLBACK_TOKEN: 'prod-callback-token-with-32-chars-min'
        } as unknown as NodeJS.ProcessEnv
      });
      const phone = '+234840';
      const runTraversal = async (sessionId: string) => {
        const session = { sessionId, phoneNumber: phone };
        await service.handleCallback({ ...session, text: '' });
        await service.handleCallback({ ...session, text: '1' });
        await service.handleCallback({ ...session, text: '1*Test Name' });
        await service.handleCallback({ ...session, text: '1*Test Name*Kano' });
        return service.handleCallback({ ...session, text: '1*Test Name*Kano*1' });
      };
      // Five registration effects fit the window (first registers, the rest
      // hit the already-registered conflict — all consume budget).
      for (let i = 0; i < 5; i += 1) {
        const result = await runTraversal(`s-rl-${i}`);
        expect(result).not.toContain('Too many registration attempts');
      }
      const limited = await runTraversal('s-rl-6');
      expect(limited).toBe('END Too many registration attempts for this number. Please try again later.');
    } finally {
      process.env.NODE_ENV = saved;
    }
    // Non-production: no cap.
    const { service } = build();
    const session = { sessionId: 's-rl-open', phoneNumber: '+234841' };
    await service.handleCallback({ ...session, text: '' });
    const open = await service.handleCallback({ ...session, text: '1' });
    expect(open).toMatch(/^CON /);
  });

  it('shares the counter across limiter instances, simulating replicas (OB-09)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // One shared counter store, two service instances = two API replicas.
      const kv = new InMemoryKeyValueStore();
      const env = {
        ...ENABLED_ENV,
        AT_CALLBACK_TOKEN: 'prod-callback-token-with-32-chars-min'
      } as unknown as NodeJS.ProcessEnv;
      const replicaA = build({ env, kv }).service;
      const replicaB = build({ env, kv }).service;
      const phone = '+234842';
      const runTraversal = async (service: UssdService, sessionId: string) => {
        const session = { sessionId, phoneNumber: phone };
        await service.handleCallback({ ...session, text: '' });
        await service.handleCallback({ ...session, text: '1' });
        await service.handleCallback({ ...session, text: '1*Test Name' });
        await service.handleCallback({ ...session, text: '1*Test Name*Kano' });
        return service.handleCallback({ ...session, text: '1*Test Name*Kano*1' });
      };
      // Alternate replicas: the budget is spent across BOTH instances, not
      // per instance.
      for (let i = 0; i < 5; i += 1) {
        const replica = i % 2 === 0 ? replicaA : replicaB;
        const result = await runTraversal(replica, `s-rep-${i}`);
        expect(result).not.toContain('Too many registration attempts');
      }
      // The 6th attempt is refused even against the replica that saw fewer
      // of this phone's attempts — per-replica memory would have allowed it.
      const limitedA = await runTraversal(replicaA, 's-rep-6a');
      const limitedB = await runTraversal(replicaB, 's-rep-6b');
      for (const limited of [limitedA, limitedB]) {
        expect(limited).toBe(
          'END Too many registration attempts for this number. Please try again later.'
        );
      }
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('fails closed when the counter store is down (OB-09 degraded mode)', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // A counter-store outage must not wave registrations through
      // unthrottled (store-of-record pattern, V-77): the effect is refused
      // with a retryable "service unavailable" instead.
      const brokenKv = {
        incr: async () => {
          throw new Error('redis connection refused');
        }
      } as unknown as KeyValueStore;
      const { service, users } = build({
        env: {
          ...ENABLED_ENV,
          AT_CALLBACK_TOKEN: 'prod-callback-token-with-32-chars-min'
        } as unknown as NodeJS.ProcessEnv,
        kv: brokenKv
      });
      const session = { sessionId: 's-rl-degraded', phoneNumber: '+234843' };
      await service.handleCallback({ ...session, text: '' });
      await service.handleCallback({ ...session, text: '1' });
      await service.handleCallback({ ...session, text: '1*Test Name' });
      await service.handleCallback({ ...session, text: '1*Test Name*Kano' });
      const result = await service.handleCallback({ ...session, text: '1*Test Name*Kano*1' });
      expect(result).toBe('END Service unavailable. Please try again shortly.');
      // Fail-closed means no registration happened at all.
      expect(await users.findByPhone('+234843')).toBeUndefined();
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('UssdService planting-window pulse pull (Stage 27, innovation 4)', () => {
  const session = { sessionId: 'sess-pulse', phoneNumber: '+234801', text: '' };

  function buildWithPulse(
    pulse: { previewForUser: (userId: string) => Promise<unknown> },
    flagEnabled: boolean
  ) {
    const users = new UsersService(createInMemoryUserRepository());
    const opportunities = { all: async () => OPPORTUNITIES } as unknown as OpportunitiesService;
    const learning = {
      allCourses: async () => COURSES,
      enrol: vi.fn(async () => ({ id: 'enrol-1' }))
    } as unknown as LearningService;
    const flags = { isEnabled: vi.fn(async () => flagEnabled) };
    return {
      users,
      service: new UssdService(
        users,
        opportunities,
        learning,
        createInMemoryUssdSessionRepository(),
        createInMemoryCommodityPriceRepository(PRICES),
        ENABLED_ENV,
        pulse as never,
        undefined,
        flags as never
      ),
      flags
    };
  }

  it('serves the pre-rendered advisory over the menu when the flag is on', async () => {
    const { service, users } = buildWithPulse(
      {
        previewForUser: async () => ({
          available: true,
          message: 'AgricPlatform: Plant maize on plot North field between 2 Jun and 16 Jun.'
        })
      },
      true
    );
    await users.create({ phone: '+234801', fullName: 'Ada Farmer', roles: ['farmer'], preferredLanguage: 'en' });
    await service.handleCallback({ ...session, text: '' });
    const turn = await service.handleCallback({ ...session, text: '5' });
    expect(turn).toContain('Plant maize on plot North field');
  });

  it('answers honestly when the flag is off (no pulse data gathered)', async () => {
    const previewForUser = vi.fn();
    const { service, users, flags } = buildWithPulse({ previewForUser }, false);
    await users.create({ phone: '+234801', fullName: 'Ada Farmer', roles: ['farmer'], preferredLanguage: 'en' });
    await service.handleCallback({ ...session, text: '' });
    const turn = await service.handleCallback({ ...session, text: '5' });
    expect(turn).toContain('unavailable');
    expect(flags.isEnabled).toHaveBeenCalled();
    expect(previewForUser).not.toHaveBeenCalled();
  });

  it('prompts unregistered phones to subscribe instead of fabricating a window', async () => {
    const { service } = buildWithPulse({ previewForUser: vi.fn() }, true);
    await service.handleCallback({ ...session, text: '' });
    const turn = await service.handleCallback({ ...session, text: '5' });
    expect(turn).toContain('No planting advisory subscription');
  });
});


describe('UssdService price-wire pull (Stage 27, innovation 11)', () => {
  const session = { sessionId: 'sess-wire', phoneNumber: '+234801', text: '' };

  function buildWithWire(
    wire: { wireMenuData: () => Promise<unknown> },
    flagEnabled: boolean
  ) {
    const users = new UsersService(createInMemoryUserRepository());
    const opportunities = { all: async () => OPPORTUNITIES } as unknown as OpportunitiesService;
    const learning = {
      allCourses: async () => COURSES,
      enrol: vi.fn(async () => ({ id: 'enrol-1' }))
    } as unknown as LearningService;
    const flags = { isEnabled: vi.fn(async () => flagEnabled) };
    return {
      users,
      service: new UssdService(
        users,
        opportunities,
        learning,
        createInMemoryUssdSessionRepository(),
        createInMemoryCommodityPriceRepository(PRICES),
        ENABLED_ENV,
        undefined,
        wire as never,
        flags as never
      ),
      flags
    };
  }

  it('serves the pre-rendered quote over the menu when the flag is on', async () => {
    const { service, users } = buildWithWire(
      {
        wireMenuData: async () => ({
          commodities: ['maize'],
          markets: { maize: ['Dawanau'] },
          quotes: { 'maize¦Dawanau': { available: true, text: 'maize: ₦425/kg at Dawanau (12 Jun 2026)' } }
        })
      },
      true
    );
    await users.create({ phone: '+234801', fullName: 'Ada Farmer', roles: ['farmer'], preferredLanguage: 'en' });
    await service.handleCallback({ ...session, text: '' });
    await service.handleCallback({ ...session, text: '6' });
    await service.handleCallback({ ...session, text: '6*1' });
    const turn = await service.handleCallback({ ...session, text: '6*1*1' });
    expect(turn).toContain('₦425/kg at Dawanau');
  });

  it('answers honestly when the flag is off (no wire data gathered)', async () => {
    const wireMenuData = vi.fn();
    const { service, users, flags } = buildWithWire({ wireMenuData }, false);
    await users.create({ phone: '+234801', fullName: 'Ada Farmer', roles: ['farmer'], preferredLanguage: 'en' });
    await service.handleCallback({ ...session, text: '' });
    const turn = await service.handleCallback({ ...session, text: '6' });
    expect(turn).toContain('Price unavailable');
    expect(flags.isEnabled).toHaveBeenCalled();
    expect(wireMenuData).not.toHaveBeenCalled();
  });

  it('answers honestly for unregistered phones (never fabricates a price)', async () => {
    const wireMenuData = vi.fn();
    const { service } = buildWithWire({ wireMenuData }, true);
    await service.handleCallback({ ...session, text: '' });
    const turn = await service.handleCallback({ ...session, text: '6' });
    expect(turn).toContain('Price unavailable');
    expect(wireMenuData).not.toHaveBeenCalled();
  });
});

describe('UssdService menu reference cache (perf P1-2)', () => {
  it('serves repeat turns from the 60s cache without re-scanning the repositories', async () => {
    const { service, prices, opportunities } = build();
    const priceScans = vi.spyOn(prices, 'find');
    const opportunityScans = vi.spyOn(opportunities, 'all');
    const first = await service.handleCallback({
      sessionId: 'sess-cache-1',
      phoneNumber: '+234861',
      text: ''
    });
    const second = await service.handleCallback({
      sessionId: 'sess-cache-2',
      phoneNumber: '+234862',
      text: ''
    });
    // Menu content is identical for both callers…
    expect(second).toBe(first);
    // …and the reference data was scanned once, not once per turn.
    expect(priceScans).toHaveBeenCalledTimes(1);
    expect(opportunityScans).toHaveBeenCalledTimes(1);
  });

  it('re-scans after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const { service, prices } = build();
      const priceScans = vi.spyOn(prices, 'find');
      await service.handleCallback({ sessionId: 'sess-ttl-1', phoneNumber: '+234863', text: '' });
      vi.advanceTimersByTime(USSD_MENU_CACHE_TTL_MS + 1_000);
      await service.handleCallback({ sessionId: 'sess-ttl-2', phoneNumber: '+234864', text: '' });
      expect(priceScans).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails open on a cache outage: the menu reads through to the repositories', async () => {
    // The menu bundle is a cache, not a store of record — a backing-store
    // outage degrades to per-turn scans, never to a failed turn (contrast
    // the fail-closed OB-09 registration limiter above).
    const brokenKv = {
      get: async () => {
        throw new Error('redis connection refused');
      },
      set: async () => {
        throw new Error('redis connection refused');
      }
    } as unknown as KeyValueStore;
    const { service, prices } = build({ kv: brokenKv });
    const priceScans = vi.spyOn(prices, 'find');
    const body = await service.handleCallback({
      sessionId: 'sess-cache-outage',
      phoneNumber: '+234865',
      text: ''
    });
    expect(body.startsWith('CON ')).toBe(true);
    expect(priceScans).toHaveBeenCalledTimes(1);
  });
});
