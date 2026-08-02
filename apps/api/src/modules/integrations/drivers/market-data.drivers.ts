/**
 * Commodity market-data feed clients (wave P1 scaffold): FEWS NET food-
 * security price points and the NiMet/market intelligence rail
 * (docs/integration-matrix.md M5). Both normalise provider payloads into
 * CommodityPriceReading rows that the ingestion service persists into
 * advisory.commodity_prices. The scheduler only activates when
 * MARKET_DATA_DRIVER=live (or sandbox/production) AND at least one feed
 * credential is present; otherwise the scaffold stays inert.
 */
import { httpJson } from './http.js';

const FEWS_NET_BASE_URL = 'https://fdw.fews.net/api';
const NIMET_BASE_URL = 'https://api.nimet.gov.ng';

/** Normalised price observation ready for the commodity_prices table. */
export interface CommodityPriceReading {
  commodity: string;
  market: string;
  state: string;
  lga?: string;
  priceNgn: number;
  source: string;
  /** ISO-8601 observation timestamp from the feed. */
  observedAt: string;
}

export interface MarketDataSource {
  readonly name: string;
  /** Fetches and normalises the latest observations. */
  fetchLatest(): Promise<CommodityPriceReading[]>;
}

interface FewsNetPricePoint {
  product?: string;
  commodity?: string;
  market?: string;
  market_name?: string;
  admin1?: string;
  state?: string;
  admin2?: string;
  lga?: string;
  price?: number;
  value?: number;
  currency?: string;
  period_date?: string;
  date?: string;
  observed_at?: string;
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * FEWS NET Data Warehouse market price API. The response envelope varies
 * by dataset version; the parser accepts both a bare array and
 * `{ data: [...] }` and skips rows that cannot be normalised (scaffold:
 * tolerant by design, attribution per FEWS NET terms).
 */
export class FewsNetMarketDataSource implements MarketDataSource {
  readonly name = 'fews-net';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = FEWS_NET_BASE_URL
  ) {}

  async fetchLatest(): Promise<CommodityPriceReading[]> {
    const response = await httpJson<unknown>(
      this.name,
      `${this.baseUrl}/marketpricepoints?country=Nigeria&limit=500`,
      { method: 'GET', headers: { authorization: `Bearer ${this.apiKey}` } }
    );
    const rows = Array.isArray(response)
      ? (response as FewsNetPricePoint[])
      : ((response as { data?: FewsNetPricePoint[] })?.data ?? []);
    const readings: CommodityPriceReading[] = [];
    for (const row of rows) {
      const commodity = row.product ?? row.commodity;
      const market = row.market ?? row.market_name;
      const state = row.admin1 ?? row.state;
      const price = row.price ?? row.value;
      const observedAt = toIsoDate(row.period_date ?? row.date ?? row.observed_at);
      if (!commodity || !market || !state || typeof price !== 'number' || !observedAt) {
        continue;
      }
      readings.push({
        commodity,
        market,
        state,
        lga: row.admin2 ?? row.lga,
        priceNgn: price,
        source: 'FEWS NET',
        observedAt
      });
    }
    return readings;
  }
}

interface NimetPriceRecord {
  commodity?: string;
  crop?: string;
  market?: string;
  state?: string;
  lga?: string;
  price_ngn?: number;
  price?: number;
  observed_at?: string;
  date?: string;
}

/**
 * NiMet / national agro-market intelligence rail (agreement-gated; the
 * API shape is provisional pending the MoU — treat as scaffold). Accepts
 * `{ records: [...] }` or a bare array of price records.
 */
export class NimetMarketDataSource implements MarketDataSource {
  readonly name = 'nimet';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = NIMET_BASE_URL
  ) {}

  async fetchLatest(): Promise<CommodityPriceReading[]> {
    const response = await httpJson<unknown>(this.name, `${this.baseUrl}/v1/market-prices`, {
      method: 'GET',
      headers: { 'x-api-key': this.apiKey }
    });
    const rows = Array.isArray(response)
      ? (response as NimetPriceRecord[])
      : ((response as { records?: NimetPriceRecord[] })?.records ?? []);
    const readings: CommodityPriceReading[] = [];
    for (const row of rows) {
      const commodity = row.commodity ?? row.crop;
      const price = row.price_ngn ?? row.price;
      const observedAt = toIsoDate(row.observed_at ?? row.date);
      if (!commodity || !row.market || !row.state || typeof price !== 'number' || !observedAt) {
        continue;
      }
      readings.push({
        commodity,
        market: row.market,
        state: row.state,
        lga: row.lga,
        priceNgn: price,
        source: 'NiMet',
        observedAt
      });
    }
    return readings;
  }
}

/** True when the market-data scheduler is allowed to run. */
export function marketDataDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.MARKET_DATA_DRIVER;
  return (
    (flag === 'live' || flag === 'production' || flag === 'sandbox') &&
    Boolean(env.FEWS_NET_API_KEY || env.NIMET_API_KEY)
  );
}

/** Builds the configured market-data sources (empty when none is keyed). */
export function createMarketDataSources(env: NodeJS.ProcessEnv = process.env): MarketDataSource[] {
  const sources: MarketDataSource[] = [];
  if (env.FEWS_NET_API_KEY) {
    sources.push(new FewsNetMarketDataSource(env.FEWS_NET_API_KEY, env.FEWS_NET_BASE_URL));
  }
  if (env.NIMET_API_KEY) {
    sources.push(new NimetMarketDataSource(env.NIMET_API_KEY, env.NIMET_BASE_URL));
  }
  return sources;
}
