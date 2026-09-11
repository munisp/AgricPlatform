import { ConflictException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import type { CommodityPrice } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryPriceWireRepository } from '../../database/repositories/price-wire.repository.js';
import type { DeliveryResult } from '../integrations/adapters.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import type { CommodityPriceProvider } from '../integrations/drivers/commodity-price.provider.js';
import type { UsersService } from '../users/users.service.js';
import { PRICE_WIRE_FLAG, PriceWireService } from './price-wire.service.js';

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

/** Fresh live observation (inside the default 7-day freshness TTL). */
function freshPrice(overrides: Partial<CommodityPrice> = {}): CommodityPrice {
  return {
    id: 'price-1',
    commodity: 'maize',
    market: 'Dawanau',
    state: 'Kano',
    priceNgn: 425,
    source: 'FEWS NET',
    observedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ingestedAt: new Date().toISOString(),
    ...overrides
  };
}

function fakeProvider(quote: { pricePerTonneNaira: number } | Error | undefined): CommodityPriceProvider {
  if (quote === undefined) {
    return {
      name: 'unconfigured',
      configured: false,
      fetchQuote: () => Promise.reject(new Error('not configured'))
    };
  }
  if (quote instanceof Error) {
    return {
      name: 'http',
      configured: true,
      fetchQuote: () => Promise.reject(quote)
    };
  }
  return {
    name: 'http',
    configured: true,
    fetchQuote: (crop: string) =>
      Promise.resolve({
        crop,
        pricePerTonneNaira: quote.pricePerTonneNaira,
        trend: 'stable' as const,
        source: 'live feed (test double)',
        observedAt: new Date().toISOString()
      })
  };
}

interface HarnessOptions {
  prices?: CommodityPrice[];
  provider?: CommodityPriceProvider;
  deliver?: (channel: string, message: { to: string; text: string }) => Promise<DeliveryResult>;
  flag?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const published: string[] = [];
  void events.on('*', (event) => published.push(event.name));
  const integrations = {
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
      key: PRICE_WIRE_FLAG,
      enabled: options.flag ?? true,
      roleAllowlist: [],
      percentage: 100,
      description: 'test'
    }
  ]);
  const flags = new FeatureFlagsService(flagRepo);
  const wire = createInMemoryPriceWireRepository();
  const prices = createInMemoryCommodityPriceRepository(options.prices ?? [freshPrice()]);
  const provider = options.provider ?? fakeProvider(undefined);
  const service = new PriceWireService(
    events,
    integrations,
    users,
    flags,
    new TelemetryService(),
    undefined,
    wire,
    prices,
    provider
  );
  return { service, wire, prices, published };
}

async function subscribed(h: ReturnType<typeof makeHarness>) {
  return h.service.subscribe(OWNER, {
    commodity: 'maize',
    marketId: 'Dawanau',
    channel: 'sms'
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('subscribe', () => {
  it('creates an active weekly subscription and publishes the spec event', async () => {
    const h = makeHarness();
    const sub = await subscribed(h);
    expect(sub.status).toBe('active');
    expect(sub.cadence).toBe('weekly');
    expect(sub.userId).toBe(OWNER.id);
    expect(h.published).toContain('advisory.price_sub.created');
  });

  it('rejects a duplicate (user, commodity, market, channel) subscription with 409', async () => {
    const h = makeHarness();
    await subscribed(h);
    await expect(subscribed(h)).rejects.toThrow(ConflictException);
  });

  it('normalises the commodity key (case/whitespace-insensitive dedupe)', async () => {
    const h = makeHarness();
    await subscribed(h);
    await expect(
      h.service.subscribe(OWNER, { commodity: ' Maize ', marketId: 'Dawanau', channel: 'sms' })
    ).rejects.toThrow(ConflictException);
  });

  it('revives the stopped row on re-subscribe (dedupe key covers stopped rows)', async () => {
    const h = makeHarness();
    const first = await subscribed(h);
    await h.service.unsubscribe(OWNER, first.id);
    const second = await subscribed(h);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('active');
  });

  it('allows a different channel or market on the same commodity', async () => {
    const h = makeHarness();
    await subscribed(h);
    await expect(
      h.service.subscribe(OWNER, { commodity: 'maize', marketId: 'Dawanau', channel: 'whatsapp' })
    ).resolves.toMatchObject({ channel: 'whatsapp' });
    await expect(
      h.service.subscribe(OWNER, { commodity: 'maize', marketId: 'Mile 12', channel: 'sms' })
    ).resolves.toMatchObject({ marketId: 'Mile 12' });
  });

  it('unsubscribe is replay-safe and owner-gated', async () => {
    const h = makeHarness();
    const sub = await subscribed(h);
    const other: User = { ...OWNER, id: 'user-2' };
    await expect(h.service.unsubscribe(other, sub.id)).rejects.toThrow();
    expect((await h.service.unsubscribe(OWNER, sub.id)).status).toBe('stopped');
    expect((await h.service.unsubscribe(OWNER, sub.id)).status).toBe('stopped');
  });
});

describe('runDispatch', () => {
  it('delivers a fresh live quote over SMS: dispatch delivered, basis labelled, event sent', async () => {
    const h = makeHarness();
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ scanned: 1, sent: 1, failed: 0, suppressed: 0 });
    const dispatches = await h.wire.dispatchesFor(sub.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      basis: 'live',
      deliveryStatus: 'delivered',
      channel: 'sms'
    });
    expect(dispatches[0].quoteAsOf).toBeDefined();
    expect(h.published).toContain('advisory.price_dispatch.sent');
    expect((await h.wire.getSubscriptionById(sub.id)).lastSentAt).toBeDefined();
  });

  it('FRESHNESS GATE: a stale quote suppresses the dispatch (logged + spec event)', async () => {
    const stale = freshPrice({ observedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
    const deliver = vi.fn();
    const h = makeHarness({ prices: [stale], deliver });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    expect(deliver).not.toHaveBeenCalled();
    const [dispatch] = await h.wire.dispatchesFor(sub.id);
    expect(dispatch.deliveryStatus).toBe('suppressed');
    expect(dispatch.detail).toContain('stale');
    expect(h.published).toContain('advisory.price_dispatch.suppressed_stale');
  });

  it('FAIL-CLOSED: feed keys absent → provider port stub → suppressed in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const deliver = vi.fn();
    // No ingested rows + unconfigured provider (the stub port).
    const h = makeHarness({ prices: [], provider: fakeProvider(undefined), deliver });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    expect(deliver).not.toHaveBeenCalled();
    const [dispatch] = await h.wire.dispatchesFor(sub.id);
    expect(dispatch).toMatchObject({ basis: 'unavailable', deliveryStatus: 'suppressed' });
    expect(dispatch.detail).toContain('stub');
  });

  it('FAIL-CLOSED: a fixture (basis=stub) quote is suppressed in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const deliver = vi.fn();
    const fixture: CommodityPriceProvider = {
      name: 'fixture',
      configured: true,
      fetchQuote: (crop: string) =>
        Promise.resolve({
          crop,
          pricePerTonneNaira: 425000,
          trend: 'stable' as const,
          source: 'FIXTURE (non-production only) — not a live price feed',
          observedAt: new Date().toISOString()
        })
    };
    const h = makeHarness({ prices: [], provider: fixture, deliver });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    expect(deliver).not.toHaveBeenCalled();
    const [dispatch] = await h.wire.dispatchesFor(sub.id);
    expect(dispatch).toMatchObject({ basis: 'stub', deliveryStatus: 'suppressed' });
  });

  it('provider outage is suppressed, never fabricated', async () => {
    const h = makeHarness({ prices: [], provider: fakeProvider(new Error('HTTP 503')) });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary.suppressed).toBe(1);
    const [dispatch] = await h.wire.dispatchesFor(sub.id);
    expect(dispatch.basis).toBe('unavailable');
    expect(dispatch.detail).toContain('provider fetch failed');
  });

  it('provider-port fallback quote converts per-tonne to per-kg and delivers (non-prod)', async () => {
    const deliver = vi.fn(() =>
      Promise.resolve({
        delivered: true,
        provider: 'termii',
        driver: 'sandbox',
        providerRef: 'ref-9',
        note: 'delivered (test double)'
      } satisfies DeliveryResult)
    );
    const h = makeHarness({ prices: [], provider: fakeProvider({ pricePerTonneNaira: 425000 }), deliver });
    const sub = await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary.sent).toBe(1);
    const [, message] = deliver.mock.calls[0] as unknown as [string, { to: string; text: string }];
    expect(message.text).toContain('₦425/kg');
    const [dispatch] = await h.wire.dispatchesFor(sub.id);
    expect(dispatch.basis).toBe('live');
  });

  it('dedupe: the same rendered quote body is never delivered twice', async () => {
    const h = makeHarness();
    const sub = await subscribed(h);
    await h.service.runDispatch();
    // Force due again by rewinding lastSentAt.
    await h.wire.updateSubscription(sub.id, { lastSentAt: '2026-01-01T00:00:00.000Z' });
    const second = await h.service.runDispatch();
    expect(second.deduped).toBe(1);
    expect(second.sent).toBe(0);
    const dispatches = await h.wire.dispatchesFor(sub.id);
    expect(dispatches.filter((d) => d.deliveryStatus === 'delivered')).toHaveLength(1);
  });

  it('stub SMS delivery (delivered:false) records failed, never delivered; retry stays possible', async () => {
    const h = makeHarness({
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
    const [dispatch] = await h.wire.dispatchesFor(sub.id);
    expect(dispatch).toMatchObject({ basis: 'live', deliveryStatus: 'failed' });
    expect(h.published).toContain('advisory.price_dispatch.failed');
    expect((await h.wire.getSubscriptionById(sub.id)).lastSentAt).toBeUndefined();
  });

  it('skips subscriptions for users outside the rollout flag', async () => {
    const h = makeHarness({ flag: false });
    await subscribed(h);
    const summary = await h.service.runDispatch();
    expect(summary).toMatchObject({ sent: 0, skippedFlagOff: 1 });
  });

  it('USSD subscriptions are pull-only: excluded from dispatch runs', async () => {
    const h = makeHarness();
    await h.service.subscribe(OWNER, { commodity: 'maize', marketId: 'Dawanau', channel: 'ussd' });
    const summary = await h.service.runDispatch();
    expect(summary.scanned).toBe(0);
  });

  it('cadence: a daily subscription is due again before a weekly one', async () => {
    const h = makeHarness();
    const daily = await h.service.subscribe(OWNER, {
      commodity: 'maize',
      marketId: 'Dawanau',
      channel: 'sms',
      cadence: 'daily'
    });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    await h.wire.updateSubscription(daily.id, { lastSentAt: twoDaysAgo });
    const weekly = await h.service.subscribe(OWNER, {
      commodity: 'rice',
      marketId: 'Mile 12',
      channel: 'sms',
      cadence: 'weekly'
    });
    await h.wire.updateSubscription(weekly.id, { lastSentAt: twoDaysAgo });
    const summary = await h.service.runDispatch();
    // Only the daily subscription is due (weekly was sent 2 days ago).
    expect(summary.scanned).toBe(1);
  });
});

describe('quotePublic (embed path)', () => {
  it('returns a fresh live quote with naira/kg and basis labels, no PII', async () => {
    const h = makeHarness();
    const quote = await h.service.quotePublic('maize', 'Dawanau');
    expect(quote).toMatchObject({
      available: true,
      commodity: 'maize',
      market: 'Dawanau',
      priceNairaPerKg: 425,
      basis: 'live',
      source: 'FEWS NET'
    });
    expect(quote.text).toContain('₦425/kg');
    expect(JSON.stringify(quote)).not.toContain(OWNER.phone);
  });

  it('answers unavailable honestly when the flag is off (default OFF)', async () => {
    const h = makeHarness({ flag: false });
    await expect(h.service.quotePublic('maize')).resolves.toMatchObject({
      available: false,
      reason: 'feature_disabled'
    });
  });

  it('answers unavailable honestly for a stale quote (never serves it)', async () => {
    const stale = freshPrice({ observedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
    const h = makeHarness({ prices: [stale] });
    await expect(h.service.quotePublic('maize')).resolves.toMatchObject({
      available: false,
      reason: 'stale_quote'
    });
  });

  it('answers unavailable honestly when the provider port is stub', async () => {
    const h = makeHarness({ prices: [], provider: fakeProvider(undefined) });
    const quote = await h.service.quotePublic('maize');
    expect(quote.available).toBe(false);
    expect(quote.priceNairaPerKg).toBeUndefined();
  });
});

describe('wireMenuData (USSD pull path)', () => {
  it('pre-computes commodities, markets and rendered quotes', async () => {
    const h = makeHarness({
      prices: [
        freshPrice(),
        freshPrice({ id: 'price-2', market: 'Mile 12', state: 'Lagos', priceNgn: 470 }),
        freshPrice({ id: 'price-3', commodity: 'rice', market: 'Bodija', state: 'Oyo', priceNgn: 780 })
      ]
    });
    const data = await h.service.wireMenuData();
    expect(data.commodities).toEqual(expect.arrayContaining(['maize', 'rice']));
    expect(data.markets.maize).toEqual(expect.arrayContaining(['Dawanau', 'Mile 12']));
    expect(data.quotes['maize¦Dawanau']).toMatchObject({ available: true });
    expect(data.quotes['maize¦Dawanau'].text).toContain('₦425/kg');
  });

  it('marks stale quotes unavailable (the USSD pull answers honestly)', async () => {
    const stale = freshPrice({ observedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
    const h = makeHarness({ prices: [stale] });
    const data = await h.service.wireMenuData();
    expect(data.quotes['maize¦Dawanau']).toEqual({ available: false });
  });
});
