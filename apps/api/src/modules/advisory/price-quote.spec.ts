import { describe, expect, it } from 'vitest';
import {
  formatNairaPerKg,
  freshnessGate,
  koboPerKgFromNairaPerKg,
  koboPerKgFromNairaPerTonne,
  quoteAgeSeconds,
  quoteDate,
  renderWireMessage,
  renderWireScreen,
  type PriceQuote
} from './price-quote.js';

const NOW = Date.parse('2026-06-12T09:00:00.000Z');

const LIVE_QUOTE: PriceQuote = {
  commodity: 'maize',
  market: 'Dawanau',
  state: 'Kano',
  priceKoboPerKg: 42500,
  asOf: '2026-06-12T06:00:00.000Z',
  basis: 'live',
  source: 'FEWS NET'
};

describe('unit normalisation (kobo/kg)', () => {
  it('converts naira per kg to integer kobo per kg', () => {
    expect(koboPerKgFromNairaPerKg(425)).toBe(42500);
    expect(koboPerKgFromNairaPerKg(425.5)).toBe(42550);
    expect(koboPerKgFromNairaPerKg(0.004)).toBe(0);
  });

  it('converts naira per tonne (provider port unit) to kobo per kg', () => {
    expect(koboPerKgFromNairaPerTonne(425000)).toBe(42500);
    expect(koboPerKgFromNairaPerTonne(150000)).toBe(15000);
  });
});

describe('formatNairaPerKg (kobo→₦/kg rendering)', () => {
  it('renders whole-naira prices with thousands separators', () => {
    expect(formatNairaPerKg(42500)).toBe('₦425/kg');
    expect(formatNairaPerKg(125000)).toBe('₦1,250/kg');
    expect(formatNairaPerKg(90)).toBe('₦0.90/kg');
  });

  it('renders fractional naira to two decimals', () => {
    expect(formatNairaPerKg(42550)).toBe('₦425.50/kg');
  });
});

describe('freshness gate', () => {
  const TTL = 7 * 24 * 60 * 60 * 1000;

  it('passes a fresh live quote', () => {
    expect(freshnessGate(LIVE_QUOTE, NOW, TTL)).toEqual({ status: 'ok', quote: LIVE_QUOTE });
  });

  it('stales a quote older than the TTL (never sent)', () => {
    const stale = { ...LIVE_QUOTE, asOf: '2026-06-01T00:00:00.000Z' };
    const outcome = freshnessGate(stale, NOW, TTL);
    expect(outcome.status).toBe('stale');
    if (outcome.status === 'stale') {
      expect(outcome.ageSeconds).toBeGreaterThan(TTL / 1000);
    }
  });

  it('stales a quote with a missing/unparseable observation time', () => {
    expect(freshnessGate({ ...LIVE_QUOTE, asOf: undefined }, NOW, TTL).status).toBe('stale');
    expect(freshnessGate({ ...LIVE_QUOTE, asOf: 'not-a-date' }, NOW, TTL).status).toBe('stale');
  });

  it('routes stub quotes to the stub outcome (production suppresses later)', () => {
    const stub: PriceQuote = { ...LIVE_QUOTE, basis: 'stub', source: 'FIXTURE (non-production only)' };
    expect(freshnessGate(stub, NOW, TTL)).toEqual({ status: 'stub', quote: stub });
  });

  it('passes unavailable quotes through honestly', () => {
    const outcome = freshnessGate(
      { commodity: 'maize', basis: 'unavailable', source: 'feed keys absent' },
      NOW,
      TTL
    );
    expect(outcome).toEqual({ status: 'unavailable', basis: 'unavailable', reason: 'feed keys absent' });
  });

  it('quoteAgeSeconds is exact and never negative', () => {
    expect(quoteAgeSeconds('2026-06-12T08:59:00.000Z', NOW)).toBe(60);
    expect(quoteAgeSeconds('2026-06-13T00:00:00.000Z', NOW)).toBe(0);
    expect(quoteAgeSeconds(undefined, NOW)).toBe(-1);
  });
});

describe('message rendering', () => {
  it('renders the SMS body with market, as-of date and source', () => {
    expect(renderWireMessage(LIVE_QUOTE)).toBe(
      'AgricPlatform price: maize at Dawanau is ₦425/kg (as of 12 Jun 2026, FEWS NET).'
    );
  });

  it('renders the compact USSD screen', () => {
    expect(renderWireScreen(LIVE_QUOTE)).toBe('maize: ₦425/kg at Dawanau (12 Jun 2026)');
  });

  it('renders honestly when slots are missing (never fabricates)', () => {
    const bare: PriceQuote = { commodity: 'maize', basis: 'live' };
    expect(renderWireMessage(bare)).toContain('price unavailable');
    expect(renderWireMessage(bare)).toContain('your market');
    expect(renderWireScreen(bare)).toContain('unavailable');
  });

  it('quoteDate is deterministic', () => {
    expect(quoteDate('2026-06-12T06:00:00.000Z')).toBe('12 Jun 2026');
    expect(quoteDate('2026-01-05')).toBe('5 Jan 2026');
  });
});
