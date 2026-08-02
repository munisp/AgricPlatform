import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { isProduction } from '../../../common/auth/auth.config.js';

/** Live price quote returned by a commodity-price provider adapter. */
export interface CommodityPriceQuote {
  crop: string;
  state?: string;
  pricePerTonneNaira: number;
  trend: 'rising' | 'stable' | 'falling';
  source: string;
  observedAt: string;
}

/**
 * Provider-adapter port for commodity price signals (Wave P). Adapters are
 * pluggable behind this interface; the active adapter is selected by
 * COMMODITY_PRICE_DRIVER (disabled by default). Production fails CLOSED:
 * with no provider configured the price route answers 503 instead of
 * silently serving fabricated numbers.
 */
export interface CommodityPriceProvider {
  readonly name: string;
  readonly configured: boolean;
  fetchQuote(crop: string, state?: string): Promise<CommodityPriceQuote>;
}

/** Fail-closed adapter: no live provider configured. */
export class UnconfiguredCommodityPriceProvider implements CommodityPriceProvider {
  readonly name = 'unconfigured';
  readonly configured = false;

  fetchQuote(): Promise<CommodityPriceQuote> {
    return Promise.reject(
      new ServiceUnavailableException(
        'No commodity price provider is configured. Set COMMODITY_PRICE_DRIVER and provider ' +
          'credentials (see docs/integration-matrix.md) to enable live price signals.'
      )
    );
  }
}

/**
 * Deterministic fixture adapter — NON-PRODUCTION ONLY. Clearly labelled in
 * the `source` field so downstream consumers can never mistake it for a
 * live feed; the factory refuses to select it in production.
 */
export class FixtureCommodityPriceProvider implements CommodityPriceProvider {
  readonly name = 'fixture';
  readonly configured = true;

  fetchQuote(crop: string, state?: string): Promise<CommodityPriceQuote> {
    const seed = [...crop].reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const base = 150000 + (seed % 20) * 25000;
    return Promise.resolve({
      crop,
      ...(state ? { state } : {}),
      pricePerTonneNaira: base,
      trend: seed % 3 === 0 ? 'rising' : seed % 3 === 1 ? 'stable' : 'falling',
      source: 'FIXTURE (non-production only) — not a live price feed',
      observedAt: new Date().toISOString()
    });
  }
}

/**
 * HTTP adapter skeleton for a live price feed (FEWS NET / exchange feed).
 * Disabled by default; requires COMMODITY_PRICE_API_URL. Network errors
 * propagate (fail closed) rather than falling back to fixtures.
 */
export class HttpCommodityPriceProvider implements CommodityPriceProvider {
  readonly name = 'http';
  readonly configured = true;

  constructor(private readonly baseUrl: string) {}

  async fetchQuote(crop: string, state?: string): Promise<CommodityPriceQuote> {
    const url = new URL('/quote', this.baseUrl);
    url.searchParams.set('crop', crop);
    if (state) {
      url.searchParams.set('state', state);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Commodity price provider responded ${response.status} for crop '${crop}'`
      );
    }
    const body = (await response.json()) as {
      pricePerTonneNaira: number;
      trend?: 'rising' | 'stable' | 'falling';
      source?: string;
      observedAt?: string;
    };
    return {
      crop,
      ...(state ? { state } : {}),
      pricePerTonneNaira: body.pricePerTonneNaira,
      trend: body.trend ?? 'stable',
      source: body.source ?? `live feed (${this.baseUrl})`,
      observedAt: body.observedAt ?? new Date().toISOString()
    };
  }
}

const logger = new Logger('CommodityPriceProvider');

/**
 * Selects the active adapter. COMMODITY_PRICE_DRIVER:
 *   unset  → fail-closed unconfigured (503 in production; dev routes also
 *            fail closed unless the fixture driver is selected explicitly)
 *   fixture → deterministic fixture (refused in production)
 *   http   → live HTTP feed (requires COMMODITY_PRICE_API_URL)
 */
export function createCommodityPriceProvider(
  env: NodeJS.ProcessEnv = process.env
): CommodityPriceProvider {
  const driver = env.COMMODITY_PRICE_DRIVER?.trim().toLowerCase();
  if (driver === 'fixture') {
    if (isProduction()) {
      logger.error(
        'COMMODITY_PRICE_DRIVER=fixture is forbidden in production — failing closed (503).'
      );
      return new UnconfiguredCommodityPriceProvider();
    }
    return new FixtureCommodityPriceProvider();
  }
  if (driver === 'http' && env.COMMODITY_PRICE_API_URL) {
    return new HttpCommodityPriceProvider(env.COMMODITY_PRICE_API_URL);
  }
  return new UnconfiguredCommodityPriceProvider();
}
