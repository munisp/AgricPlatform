import { ConflictException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FarmPlot, User } from '@agric-platform/shared';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAdvisoryPulseRepository } from '../../database/repositories/advisory-pulse.repository.js';
import { createInMemoryComplianceConsentRepository } from '../../database/repositories/compliance.repository.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import type { DeliveryResult } from '../integrations/adapters.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import type { DailyForecast, WeatherProvider } from '../integrations/drivers/weather.drivers.js';
import type { UsersService } from '../users/users.service.js';
import {
  PLANTING_PULSE_CONSENT_PURPOSE,
  PLANTING_PULSE_FLAG,
  PlantingPulseService
} from './planting-pulse.service.js';

const OWNER: User = {
  id: 'user-1',
  phone: '+234801',
  fullName: 'Ada Farmer',
  roles: ['farmer'],
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const ADMIN: User = { ...OWNER, id: 'admin-1', roles: ['admin'] };

const PLOT: FarmPlot = {
  id: 'plot-1',
  ownerUserId: OWNER.id,
  name: 'North field',
  state: 'Kano',
  lga: 'Kura',
  centroidLat: 11.75,
  centroidLong: 8.43,
  sizeHectares: 1.5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1
};

/** 14-day wet forecast: 10mm/day from 2026-06-01 (onset day 1 for maize). */
function wetForecast(fetchedAt = new Date().toISOString()): DailyForecast {
  return {
    latitude: 11.75,
    longitude: 8.43,
    daily: Array.from({ length: 14 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
      precipitationMm: 10
    })),
    fetchedAt,
    source: 'Open-Meteo (test double)'
  };
}

function dryForecast(): DailyForecast {
  const forecast = wetForecast();
  forecast.daily = forecast.daily.map((point) => ({ ...point, precipitationMm: 0 }));
  return forecast;
}

function fakeProvider(forecast: DailyForecast | Error): WeatherProvider {
  return {
    name: 'test-double',
    snapshot: () => Promise.reject(new Error('not used')),
    dailyForecast: () =>
      forecast instanceof Error ? Promise.reject(forecast) : Promise.resolve(forecast)
  };
}

interface HarnessOptions {
  provider?: WeatherProvider;
  deliver?: (channel: string, message: { to: string; text: string }) => Promise<DeliveryResult>;
  flag?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const published: string[] = [];
  void events.on('*', (event) => published.push(event.name));
  const integrations = {
    weatherProvider: () => options.provider,
    deliverMessage:
      options.deliver ??
      (() =>
        Promise.resolve({
          delivered: true,
          provider: 'termii',
          driver: 'sandbox',
          providerRef: 'ref-1',
          note: 'delivered (test double)'
        } satisfies DeliveryResult))
  } as unknown as IntegrationsService;
  const users = {
    findById: (id: string) => Promise.resolve(id === OWNER.id ? OWNER : undefined)
  } as unknown as UsersService;
  const flagRepo = createInMemoryFeatureFlagRepository([
    {
      key: PLANTING_PULSE_FLAG,
      enabled: options.flag ?? true,
      roleAllowlist: [],
      percentage: 100,
      description: 'test'
    }
  ]);
  const flags = new FeatureFlagsService(flagRepo);
  const pulse = createInMemoryAdvisoryPulseRepository();
  const plots = createInMemoryFarmPlotRepository([PLOT]);
  const consents = createInMemoryComplianceConsentRepository();
  const service = new PlantingPulseService(
    events,
    integrations,
    users,
    flags,
    new TelemetryService(),
    undefined,
    pulse,
    plots,
    consents
  );
  return { service, pulse, plots, consents, published };
}

async function subscribed(h: ReturnType<typeof makeHarness>) {
  return h.service.subscribe(OWNER, { plotId: PLOT.id, channel: 'sms', crop: 'maize' });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('subscribe', () => {
  it('creates an active subscription with H3 cell and NDPA consent, and publishes the event', async () => {
    const h = makeHarness();
    const sub = await subscribed(h);
    expect(sub.status).toBe('active');
    expect(sub.userId).toBe(OWNER.id);
    expect(sub.crop).toBe('maize');
    expect(sub.h3Res9).toMatch(/^[0-9a-f]{15}$/);
    expect(h.published).toContain('advisory.subscription.created');
    const consent = await h.consents.findActive(OWNER.id, PLANTING_PULSE_CONSENT_PURPOSE);
    expect(consent?.id).toBe(sub.consentId);
    expect(consent?.source).toBe('advisory-subscription');
  });

  it('rejects a duplicate ACTIVE (plot, channel, crop) subscription with 409', async () => {
    const h = makeHarness();
    await subscribed(h);
    await expect(subscribed(h)).rejects.toThrow(ConflictException);
  });

  it('allows re-subscribing after stop (dedupe key covers ACTIVE rows only)', async () => {
    const h = makeHarness();
    const first = await subscribed(h);
    await h.service.unsubscribe(OWNER, first.id);
    const second = await subscribed(h);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('active');
  });

  it('fails closed on unknown crops (never invents a rule)', async () => {
    const h = makeHarness();
    await expect(
      h.service.subscribe(OWNER, { plotId: PLOT.id, channel: 'sms', crop: 'quinoa' })
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('rejects the voice channel in v1 (no outbound voice driver)', async () => {
    const h = makeHarness();
    await expect(
      h.service.subscribe(OWNER, { plotId: PLOT.id, channel: 'voice', crop: 'maize' })
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('forbids subscribing someone else’s plot without an assisted role', async () => {
    const h = makeHarness();
    const other: User = { ...OWNER, id: 'user-2', roles: ['farmer'] };
    await expect(
      h.service.subscribe(other, { plotId: PLOT.id, channel: 'sms', crop: 'maize' })
    ).rejects.toThrow(/only subscribe plots you own/);
    // Admin-assisted capture works.
    await expect(
      h.service.subscribe(ADMIN, { plotId: PLOT.id, channel: 'sms', crop: 'maize' })
    ).resolves.toMatchObject({ userId: OWNER.id });
  });
});

describe('runDispatch', () => {
  it('delivers a fresh live window over SMS: dispatch delivered, last_sent_at set, events published', async () => {
    const h = makeHarness({ provider: fakeProvider(wetForecast()) });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ scanned: 1, sent: 1, failed: 0, suppressed: 0 });
    const dispatches = await h.pulse.dispatchesFor(sub.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      basis: 'live',
      deliveryStatus: 'delivered',
      channel: 'sms',
      windowStart: '2026-06-01',
      ruleVersion: 'planting-rules-v1'
    });
    expect(h.published).toContain('advisory.pulse.generated');
    expect(h.published).toContain('advisory.pulse.delivered');
    const after = await h.pulse.getSubscriptionById(sub.id);
    expect(after.lastSentAt).toBeDefined();
    expect(after.plantingWindow).toMatchObject({ crop: 'maize', windowStart: '2026-06-01' });
  });

  it('FAIL-CLOSED: stub/unconfigured weather driver suppresses the send (basis=unavailable)', async () => {
    const deliver = vi.fn();
    const h = makeHarness({ provider: undefined, deliver });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    expect(deliver).not.toHaveBeenCalled();
    const dispatches = await h.pulse.dispatchesFor(sub.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ basis: 'unavailable', deliveryStatus: 'suppressed' });
    expect(dispatches[0].detail).toContain('stub');
    expect(h.published).toContain('advisory.pulse.suppressed');
  });

  it('FAIL-CLOSED: an Open-Meteo outage suppresses rather than fabricates', async () => {
    const h = makeHarness({ provider: fakeProvider(new Error('HTTP 503')) });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary.suppressed).toBe(1);
    const [dispatch] = await h.pulse.dispatchesFor(sub.id);
    expect(dispatch.basis).toBe('unavailable');
    expect(dispatch.detail).toContain('weather fetch failed');
  });

  it('FRESHNESS GATE: a stale forecast never generates an advisory', async () => {
    const stale = wetForecast(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    const h = makeHarness({ provider: fakeProvider(stale) });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    const [dispatch] = await h.pulse.dispatchesFor(sub.id);
    expect(dispatch.deliveryStatus).toBe('suppressed');
    expect(dispatch.detail).toContain('stale');
  });

  it('no-onset forecasts record an honest suppression, not a window', async () => {
    const h = makeHarness({ provider: fakeProvider(dryForecast()) });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    const [dispatch] = await h.pulse.dispatchesFor(sub.id);
    expect(dispatch).toMatchObject({ basis: 'live', deliveryStatus: 'suppressed', detail: 'no_onset_in_horizon' });
  });

  it('dedupe: the same window body is never delivered twice', async () => {
    const h = makeHarness({ provider: fakeProvider(wetForecast()) });
    const sub = await subscribed(h);
    await h.service.runDispatch();
    // Second run: last_sent_at is fresh so the subscription is not even due;
    // force due by rewinding lastSentAt.
    await h.pulse.updateSubscription(sub.id, { lastSentAt: '2026-01-01T00:00:00.000Z' });
    const second = await h.service.runDispatch();
    expect(second.deduped).toBe(1);
    expect(second.sent).toBe(0);
    const dispatches = await h.pulse.dispatchesFor(sub.id);
    expect(dispatches.filter((d) => d.deliveryStatus === 'delivered')).toHaveLength(1);
  });

  it('stub SMS delivery (delivered:false) records failed, never delivered; retry stays possible', async () => {
    const h = makeHarness({
      provider: fakeProvider(wetForecast()),
      deliver: () =>
        Promise.resolve({
          delivered: false,
          provider: 'termii',
          driver: 'stub',
          providerRef: 'stub-1',
          note: 'Simulated sms delivery via stub driver (no external network call; message NOT sent)'
        })
    });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    const [dispatch] = await h.pulse.dispatchesFor(sub.id);
    expect(dispatch).toMatchObject({ basis: 'live', deliveryStatus: 'failed' });
    expect(h.published).toContain('advisory.pulse.failed');
    expect((await h.pulse.getSubscriptionById(sub.id)).lastSentAt).toBeUndefined();
  });

  it('skips subscriptions for users outside the rollout flag', async () => {
    const h = makeHarness({ provider: fakeProvider(wetForecast()), flag: false });
    await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, skippedFlagOff: 1 });
  });

  it('USSD subscriptions are pull-only: excluded from dispatch runs', async () => {
    const h = makeHarness({ provider: fakeProvider(wetForecast()) });
    await h.service.subscribe(OWNER, { plotId: PLOT.id, channel: 'ussd', crop: 'maize' });
    const summary = await h.service.runDispatch();
    expect(summary.scanned).toBe(0);
  });
});

describe('nextFor (synchronous preview)', () => {
  it('returns the rendered window when the feed is fresh and live', async () => {
    const h = makeHarness({ provider: fakeProvider(wetForecast()) });
    const sub = await subscribed(h);
    const preview = await h.service.nextFor(OWNER, sub.id);
    expect(preview.available).toBe(true);
    expect(preview.message).toContain('Plant maize on plot North field between 1 Jun and 15 Jun');
    expect(preview.window).toMatchObject({ windowStart: '2026-06-01', confidence: 'high' });
  });

  it('503s in production when the weather driver is stub (never fabricates)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const h = makeHarness({ provider: undefined });
    const sub = await subscribed(h);
    await expect(h.service.nextFor(OWNER, sub.id)).rejects.toThrow(ServiceUnavailableException);
  });

  it('answers honestly outside production (available:false, no fabrication)', async () => {
    const h = makeHarness({ provider: undefined });
    const sub = await subscribed(h);
    const preview = await h.service.nextFor(OWNER, sub.id);
    expect(preview).toMatchObject({ available: false, basis: 'unavailable' });
    expect(preview.message).toBeUndefined();
  });

  it('previewForUser feeds the USSD pull path (wait message included)', async () => {
    const h = makeHarness({ provider: fakeProvider(dryForecast()) });
    await subscribed(h);
    const preview = await h.service.previewForUser(OWNER.id);
    expect(preview.available).toBe(true);
    expect(preview.message).toContain('No reliable planting window');
  });

  it('previewForUser is honest when nothing is subscribed', async () => {
    const h = makeHarness();
    await expect(h.service.previewForUser('nobody')).resolves.toMatchObject({
      available: false,
      reason: 'no_active_subscription'
    });
  });
});
