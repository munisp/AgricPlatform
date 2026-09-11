/**
 * Price Wire — deterministic quote normalisation, freshness gate and message
 * rendering (Stage 27, innovation 11). Pure functions only: no I/O and no
 * clock access (callers pass `nowMs`), so known-answer tests pin every
 * behaviour. This file intentionally contains no literal backslash
 * sequences (MCP channel hazard — see PR #71 notes); multi-line strings
 * use template literals with real newlines.
 *
 * Money convention: platform money is integer kobo; market feeds report
 * naira. Quotes are normalised to integer kobo per kilogram and rendered
 * as naira/kg for farmers.
 */

/** Version stamped on rendered bodies (dispatch dedupe inputs). */
export const PRICE_WIRE_RULES_VERSION = 'price-wire-v1';

/** Grams in one metric tonne (provider port reports naira per tonne). */
export const KG_PER_TONNE = 1000;
/** Kobo in one naira. */
export const KOBO_PER_NAIRA = 100;

export type QuoteBasis = 'live' | 'stub' | 'unavailable';

/** A normalised crop-price quote with its honesty labels. */
export interface PriceQuote {
  commodity: string;
  market?: string;
  state?: string;
  /** Integer kobo per kilogram; absent when no price exists (never fabricated). */
  priceKoboPerKg?: number;
  /** ISO observation time of the price (freshness gate input). */
  asOf?: string;
  basis: QuoteBasis;
  source?: string;
}

export type QuoteOutcome =
  | { status: 'ok'; quote: PriceQuote }
  /** Live basis but older than the TTL — NEVER sent (suppressed + logged). */
  | { status: 'stale'; quote: PriceQuote; ageSeconds: number }
  /** Stub/fixture basis — dispatch suppressed in production, dev may send. */
  | { status: 'stub'; quote: PriceQuote }
  | { status: 'unavailable'; basis: QuoteBasis; reason: string };

/** Naira per kilogram → integer kobo per kilogram (rounded to whole kobo). */
export function koboPerKgFromNairaPerKg(nairaPerKg: number): number {
  return Math.round(nairaPerKg * KOBO_PER_NAIRA);
}

/** Naira per tonne → integer kobo per kilogram (provider port unit). */
export function koboPerKgFromNairaPerTonne(nairaPerTonne: number): number {
  return Math.round((nairaPerTonne * KOBO_PER_NAIRA) / KG_PER_TONNE);
}

/**
 * Renders integer kobo/kg as a farmer-facing naira/kg label, e.g.
 * 42500 → '₦425/kg', 42550 → '₦425.50/kg', 125000 → '₦1,250/kg'.
 */
export function formatNairaPerKg(koboPerKg: number): string {
  const naira = koboPerKg / KOBO_PER_NAIRA;
  const rendered = Number.isInteger(naira)
    ? naira.toLocaleString('en-NG')
    : naira.toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
  return `₦${rendered}/kg`;
}

/** Whole seconds between the observation time and now; -1 when unknown. */
export function quoteAgeSeconds(asOf: string | undefined, nowMs: number): number {
  if (!asOf) {
    return -1;
  }
  const parsed = Date.parse(asOf);
  if (!Number.isFinite(parsed)) {
    return -1;
  }
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

/**
 * Freshness gate: a quote whose observation is older than `maxAgeMs` (or
 * carries an unparseable/missing observation time) is stale and must never
 * be sent. Pure — the caller supplies the clock.
 */
export function freshnessGate(
  quote: PriceQuote,
  nowMs: number,
  maxAgeMs: number
): QuoteOutcome {
  if (quote.basis === 'unavailable') {
    return { status: 'unavailable', basis: 'unavailable', reason: quote.source ?? 'no price data' };
  }
  const ageSeconds = quoteAgeSeconds(quote.asOf, nowMs);
  if (ageSeconds < 0 || ageSeconds * 1000 > maxAgeMs) {
    return { status: 'stale', quote, ageSeconds: Math.max(0, ageSeconds) };
  }
  if (quote.basis === 'stub') {
    return { status: 'stub', quote };
  }
  return { status: 'ok', quote };
}

/** '2026-06-12T…' → '12 Jun 2026' (deterministic, locale-independent). */
export function quoteDate(iso: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = iso.slice(8, 10);
  const month = Number.parseInt(iso.slice(5, 7), 10);
  const year = iso.slice(0, 4);
  return `${Number.parseInt(day, 10)} ${MONTHS[month - 1]} ${year}`;
}

/**
 * Renders the SMS/push body for a fresh live (or explicitly dev-stub) quote.
 * States the market, the as-of date and the feed source so the farmer can
 * judge the basis of the number. Unknown slots render honestly.
 */
export function renderWireMessage(quote: PriceQuote): string {
  const price = quote.priceKoboPerKg === undefined ? 'price unavailable' : formatNairaPerKg(quote.priceKoboPerKg);
  const market = quote.market ?? 'your market';
  const when = quote.asOf ? quoteDate(quote.asOf) : 'unknown date';
  const source = quote.source ?? 'market feed';
  return `AgricPlatform price: ${quote.commodity} at ${market} is ${price} (as of ${when}, ${source}).`;
}

/**
 * Renders the compact USSD screen for a quote (the engine caps it at one
 * turnaround screen). Same honesty labels as the SMS body.
 */
export function renderWireScreen(quote: PriceQuote): string {
  const price = quote.priceKoboPerKg === undefined ? 'unavailable' : formatNairaPerKg(quote.priceKoboPerKg);
  const market = quote.market ?? 'market';
  const when = quote.asOf ? quoteDate(quote.asOf) : 'unknown date';
  return `${quote.commodity}: ${price} at ${market} (${when})`;
}
