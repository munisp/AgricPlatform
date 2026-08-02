/**
 * NCX / AFEX commodity exchange price feeds (wave P5a, matrix Phase 3).
 * Follows the FEWS NET pattern: both normalise provider payloads into
 * CommodityPriceReading rows persisted into advisory.commodity_prices via
 * the existing idempotent upsertMany repository. The scheduler stays inert
 * unless EXCHANGE_FEEDS_DRIVER is live (or sandbox/production) AND at
 * least one feed credential is present.
 *
 * NCX (Nigeria Commodity Exchange) is a REST JSON feed; AFEX publishes a
 * periodic CSV file pulled over authenticated HTTP (FTP-pull style; the
 * transport is HTTPS so no extra dependency is required).
 */
import { httpJson, httpRequest, requireEnv } from './http.js';
import type { CommodityPriceReading, MarketDataSource } from './market-data.drivers.js';

interface NcxPriceRow {
  commodity?: string;
  product?: string;
  market?: string;
  state?: string;
  lga?: string;
  price?: number;
  price_ngn?: number;
  date?: string;
  observed_at?: string;
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** NCX REST feed (`x-api-key` auth; accepts a bare array or `{ data }`). */
export class NcxPriceFeedSource implements MarketDataSource {
  readonly name = 'ncx';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async fetchLatest(): Promise<CommodityPriceReading[]> {
    const response = await httpJson<unknown>(
      this.name,
      `${this.baseUrl.replace(/\/$/, '')}/v1/prices?country=NG`,
      { method: 'GET', headers: { 'x-api-key': this.apiKey } }
    );
    const rows = Array.isArray(response)
      ? (response as NcxPriceRow[])
      : ((response as { data?: NcxPriceRow[] })?.data ?? []);
    const readings: CommodityPriceReading[] = [];
    for (const row of rows) {
      const commodity = row.commodity ?? row.product;
      const price = row.price_ngn ?? row.price;
      const observedAt = toIso(row.observed_at ?? row.date);
      if (!commodity || !row.market || !row.state || typeof price !== 'number' || !observedAt) {
        continue;
      }
      readings.push({
        commodity,
        market: row.market,
        state: row.state,
        lga: row.lga,
        priceNgn: price,
        source: 'NCX',
        observedAt
      });
    }
    return readings;
  }
}

/**
 * AFEX CSV feed (FTP-pull style over authenticated HTTPS). Expected header:
 * commodity,market,state,lga,price_ngn,observed_at. Malformed rows are
 * skipped; lga may be empty.
 */
export class AfexCsvFeedSource implements MarketDataSource {
  readonly name = 'afex';

  constructor(
    private readonly feedUrl: string,
    private readonly apiKey: string
  ) {}

  async fetchLatest(): Promise<CommodityPriceReading[]> {
    const { text } = await httpRequest(this.name, this.feedUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` }
    });
    return parseAfexCsv(text);
  }
}

/** Parses the AFEX CSV export; exported for tests. */
export function parseAfexCsv(text: string): CommodityPriceReading[] {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  if (!headerLine) {
    return [];
  }
  const columns = headerLine.split(',').map((column) => column.trim().toLowerCase());
  const index = (name: string) => columns.indexOf(name);
  const readings: CommodityPriceReading[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const cells = line.split(',').map((cell) => cell.trim());
    const commodity = cells[index('commodity')];
    const market = cells[index('market')];
    const state = cells[index('state')];
    const price = Number(cells[index('price_ngn')]);
    const observedAt = toIso(cells[index('observed_at')]);
    if (!commodity || !market || !state || !Number.isFinite(price) || !observedAt) {
      continue;
    }
    const lga = index('lga') >= 0 ? cells[index('lga')] : '';
    readings.push({
      commodity,
      market,
      state,
      lga: lga || undefined,
      priceNgn: price,
      source: 'AFEX',
      observedAt
    });
  }
  return readings;
}

/** True when the exchange-feed scheduler is allowed to run. */
export function exchangeFeedsDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.EXCHANGE_FEEDS_DRIVER;
  return (
    (flag === 'live' || flag === 'production' || flag === 'sandbox') &&
    Boolean((env.NCX_BASE_URL && env.NCX_API_KEY) || (env.AFEX_FEED_URL && env.AFEX_API_KEY))
  );
}

/**
 * Builds the configured exchange-feed sources. Fail closed: with a non-stub
 * flag, a base/feed URL without its API key raises ProviderConfigError.
 */
export function createExchangeFeedSources(env: NodeJS.ProcessEnv = process.env): MarketDataSource[] {
  const flag = env.EXCHANGE_FEEDS_DRIVER ?? 'stub';
  if (flag === 'stub') {
    return [];
  }
  const sources: MarketDataSource[] = [];
  if (env.NCX_BASE_URL) {
    sources.push(new NcxPriceFeedSource(env.NCX_BASE_URL, requireEnv('ncx', env, ['NCX_API_KEY'])));
  }
  if (env.AFEX_FEED_URL) {
    sources.push(new AfexCsvFeedSource(env.AFEX_FEED_URL, requireEnv('afex', env, ['AFEX_API_KEY'])));
  }
  return sources;
}
