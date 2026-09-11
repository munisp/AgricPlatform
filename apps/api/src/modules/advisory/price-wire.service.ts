import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
  UnprocessableEntityException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  COMMODITY_PRICE_PROVIDER,
  COMMODITY_PRICE_REPOSITORY,
  PRICE_WIRE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import type {
  PriceDispatch,
  PriceSubscription,
  PriceWireRepository,
  WireCadence,
  WireChannel
} from '../../database/repositories/price-wire.repository.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { CommodityPriceProvider } from '../integrations/drivers/commodity-price.provider.js';
import { UsersService } from '../users/users.service.js';
import {
  freshnessGate,
  koboPerKgFromNairaPerKg,
  koboPerKgFromNairaPerTonne,
  renderWireMessage,
  renderWireScreen,
  type PriceQuote,
  type QuoteOutcome
} from './price-quote.js';

/** Rollout flag (DB-backed, default OFF — unknown flag evaluates false). */
export const PRICE_WIRE_FLAG = 'price-wire';

/**
 * Freshness gate TTL: a quote whose observation is older than this is NEVER
 * sent (suppressed + logged + metric). Default 7 days — market feeds publish
 * at most daily, so a week is already generous; env-overridable for tests.
 */
export const PRICE_WIRE_QUOTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default cadence gaps between pushes per subscription. */
export const PRICE_WIRE_WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const PRICE_WIRE_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Channels v1 can honour: USSD is pull-only (no push exists). */
export const WIRE_CHANNELS = ['sms', 'ussd', 'whatsapp'] as const;
export const WIRE_CADENCES = ['weekly', 'daily'] as const;

/** Commodities offered on the USSD pull node (most recently observed first). */
export const WIRE_MENU_COMMODITY_CAP = 6;
/** Markets offered per commodity on the USSD pull node. */
export const WIRE_MENU_MARKET_CAP = 5;

export interface SubscribePriceInput {
  commodity: string;
  marketId: string;
  channel: WireChannel;
  cadence?: WireCadence;
}

/** Public quote payload (embed widget + API): no PII, honesty labels. */
export interface PublicQuote {
  available: boolean;
  commodity: string;
  market?: string;
  priceNairaPerKg?: number;
  asOf?: string;
  basis?: 'live' | 'stub';
  source?: string;
  /** Rendered naira/kg text (only when available). */
  text?: string;
  /** Honest reason when unavailable. */
  reason?: string;
}

/** Pre-computed pull data for the USSD price-check node (engine stays pure). */
export interface WireMenuData {
  commodities: string[];
  /** commodity → markets (most recently observed first). */
  markets: Record<string, string[]>;
  /** `${commodity}¦${market}` → rendered quote or honest unavailability. */
  quotes: Record<string, { available: boolean; text?: string }>;
}

export interface WireDispatchRunSummary {
  scanned: number;
  sent: number;
  failed: number;
  suppressed: number;
  deduped: number;
  skippedFlagOff: number;
}

/** Quote lookup key shared with the USSD engine. */
export function wireQuoteKey(commodity: string, market: string): string {
  return `${commodity}¦${market}`;
}

/**
 * Price Wire service (Stage 27, innovation 11): farmer-subscribed crop-price
 * ticker. Pushes fresh market quotes over SMS/WhatsApp on the subscription
 * cadence; USSD pulls the same quotes through menu node 6.
 *
 * Quote resolution order (basis honesty):
 *  1. Latest ingested observation in advisory.commodity_prices (FEWS NET /
 *     NiMet keyed feeds — only ever written by the live ingestion scheduler)
 *     → basis 'live', per-kg naira normalised to integer kobo.
 *  2. The commodity-price provider port (COMMODITY_PRICE_DRIVER) → per-tonne
 *     naira normalised; the fixture driver is labelled basis 'stub'.
 *  3. Neither → basis 'unavailable', no price (never fabricated).
 *
 * FAIL-CLOSED (never SMS a fabricated or stale price to a farmer about to
 * sell):
 *  - feed keys absent → provider port is STUB → quotes basis='stub' and
 *    dispatches are SUPPRESSED in production; the USSD pull and public
 *    embed answer "price unavailable" honestly.
 *  - a quote older than PRICE_WIRE_QUOTE_MAX_AGE_MS is stale → suppressed,
 *    logged, audited and counted; never sent.
 */
@Injectable()
export class PriceWireService {
  private readonly logger = new Logger(PriceWireService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly integrations: IntegrationsService,
    private readonly users: UsersService,
    private readonly flags: FeatureFlagsService,
    private readonly telemetry: TelemetryService,
    @Optional() private readonly audit: AuditService | undefined,
    @Inject(PRICE_WIRE_REPOSITORY) private readonly wire: PriceWireRepository,
    @Inject(COMMODITY_PRICE_REPOSITORY) private readonly prices: CommodityPriceRepository,
    @Inject(COMMODITY_PRICE_PROVIDER) private readonly priceProvider: CommodityPriceProvider
  ) {}

  /** POST /api/advisory/price-subscriptions — farmer self-service. */
  async subscribe(actor: User | null, input: SubscribePriceInput): Promise<PriceSubscription> {
    const caller = this.requireActor(actor);
    if (!(WIRE_CHANNELS as readonly string[]).includes(input.channel)) {
      throw new UnprocessableEntityException(
        `Channel '${input.channel}' is not subscribable in v1 (supported: ${WIRE_CHANNELS.join(', ')})`
      );
    }
    const cadence = input.cadence ?? 'weekly';
    if (!(WIRE_CADENCES as readonly string[]).includes(cadence)) {
      throw new UnprocessableEntityException(
        `Cadence '${input.cadence}' is not supported (supported: ${WIRE_CADENCES.join(', ')})`
      );
    }
    const commodity = input.commodity.trim().toLowerCase();
    const marketId = input.marketId.trim();
    if (!commodity || !marketId) {
      throw new UnprocessableEntityException('commodity and marketId are required');
    }
    const now = new Date().toISOString();
    const subscription: PriceSubscription = {
      id: newId('pwsub'),
      userId: caller.id,
      commodity,
      marketId,
      channel: input.channel,
      cadence,
      status: 'active',
      createdAt: now,
      updatedAt: now
    };
    let created: PriceSubscription;
    try {
      created = await this.wire.createSubscription(subscription);
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
      // The dedupe key covers stopped rows: re-subscribing revives the
      // stopped row instead of inserting a duplicate.
      const existing = await this.wire.findByDedupeKey(caller.id, commodity, marketId, input.channel);
      if (!existing || existing.status !== 'stopped') {
        throw error;
      }
      created = await this.wire.updateSubscription(existing.id, {
        cadence,
        status: 'active',
        updatedAt: new Date().toISOString()
      });
    }
    await this.events.publish(
      'advisory.price_sub.created',
      {
        subscriptionId: created.id,
        commodity: created.commodity,
        marketId: created.marketId,
        channel: created.channel,
        cadence: created.cadence
      },
      caller.id
    );
    return created;
  }

  /** DELETE /api/advisory/price-subscriptions/:id — owner or admin; replay-safe. */
  async unsubscribe(actor: User | null, id: string): Promise<PriceSubscription> {
    const caller = this.requireActor(actor);
    const subscription = await this.wire.getSubscriptionById(id);
    assertSelfOrAdmin(caller, subscription.userId);
    const stopped = await this.wire.stopSubscription(id);
    await this.audit?.record({
      actorId: caller.id,
      action: 'advisory.price_sub.stopped',
      entityType: 'price_subscription',
      entityId: id,
      metadata: { commodity: subscription.commodity, marketId: subscription.marketId, channel: subscription.channel }
    });
    return stopped;
  }

  /** GET /api/advisory/price-subscriptions — the caller's own subscriptions. */
  async listMine(actor: User | null): Promise<PriceSubscription[]> {
    const caller = this.requireActor(actor);
    return this.wire.findSubscriptions({ userId: caller.id });
  }

  /** Dispatch history for one subscription (owner or admin). */
  async dispatches(actor: User | null, id: string): Promise<PriceDispatch[]> {
    const caller = this.requireActor(actor);
    const subscription = await this.wire.getSubscriptionById(id);
    assertSelfOrAdmin(caller, subscription.userId);
    return this.wire.dispatchesFor(id);
  }

  /**
   * Public quote for the embed widget (CORS-open, no PII). Fail-closed:
   * flag off, stub basis or a stale/unavailable feed all answer
   * available:false with an honest reason — never a fabricated number.
   */
  async quotePublic(commodity: string, market?: string): Promise<PublicQuote> {
    const key = commodity.trim().toLowerCase();
    const enabled = await this.flags.isEnabled(PRICE_WIRE_FLAG, {});
    if (!enabled) {
      return { available: false, commodity: key, ...(market ? { market } : {}), reason: 'feature_disabled' };
    }
    const outcome = await this.computeQuote(key, market);
    if (outcome.status !== 'ok') {
      return {
        available: false,
        commodity: key,
        ...(market ? { market } : {}),
        reason: this.outcomeReason(outcome)
      };
    }
    const quote = outcome.quote;
    return {
      available: true,
      commodity: key,
      ...(quote.market ? { market: quote.market } : {}),
      priceNairaPerKg: (quote.priceKoboPerKg ?? 0) / 100,
      ...(quote.asOf ? { asOf: quote.asOf } : {}),
      basis: 'live',
      ...(quote.source ? { source: quote.source } : {}),
      text: renderWireMessage(quote)
    };
  }

  /**
   * Pre-computes the USSD pull data (menu node 6): commodities with recent
   * observations, their markets (most recently observed first — the nearest-
   * market proxy until markets carry coordinates), and a rendered quote (or
   * honest unavailability) per commodity×market pair. The engine stays pure.
   */
  async wireMenuData(): Promise<WireMenuData> {
    const rows = await this.prices.find({});
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = wireQuoteKey(row.commodity, row.market);
      const current = latest.get(key);
      if (!current || row.observedAt > current.observedAt) {
        latest.set(key, row);
      }
    }
    const byCommodity = new Map<string, string[]>();
    for (const row of latest.values()) {
      const markets = byCommodity.get(row.commodity) ?? [];
      markets.push(row.market);
      byCommodity.set(row.commodity, markets);
    }
    const commodities = [...byCommodity.keys()]
      .sort((a, b) => {
        const newest = (commodity: string) =>
          Math.max(
            ...(byCommodity.get(commodity) ?? []).map((market) =>
              Date.parse(latest.get(wireQuoteKey(commodity, market))?.observedAt ?? '')
            )
          );
        return newest(b) - newest(a) || a.localeCompare(b);
      })
      .slice(0, WIRE_MENU_COMMODITY_CAP);
    const markets: Record<string, string[]> = {};
    const quotes: WireMenuData['quotes'] = {};
    for (const commodity of commodities) {
      const entries = (byCommodity.get(commodity) ?? [])
        .map((market) => latest.get(wireQuoteKey(commodity, market))!)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.market.localeCompare(b.market))
        .slice(0, WIRE_MENU_MARKET_CAP);
      markets[commodity] = entries.map((row) => row.market);
      for (const row of entries) {
        const outcome = await this.computeQuote(commodity, row.market);
        quotes[wireQuoteKey(commodity, row.market)] =
          outcome.status === 'ok'
            ? { available: true, text: renderWireScreen(outcome.quote) }
            : { available: false };
      }
    }
    return { commodities, markets, quotes };
  }

  /**
   * POST /api/advisory/price-dispatch/run — one dispatch pass (external
   * scheduler/Temporal step; the API starts no timers of its own). Pushable
   * channels only; USSD is pull-only. Per-subscription flag evaluation keeps
   * percentage rollouts meaningful for a cron caller.
   */
  async runDispatch(actorId = 'price-wire-dispatch'): Promise<WireDispatchRunSummary> {
    const dailyMs = Number(process.env.PRICE_WIRE_DAILY_INTERVAL_MS ?? PRICE_WIRE_DAILY_INTERVAL_MS);
    const weeklyMs = Number(process.env.PRICE_WIRE_WEEKLY_INTERVAL_MS ?? PRICE_WIRE_WEEKLY_INTERVAL_MS);
    const dailyCutoff = new Date(Date.now() - dailyMs).toISOString();
    const weeklyCutoff = new Date(Date.now() - weeklyMs).toISOString();
    const due = await this.wire.listDueForDispatch(dailyCutoff, weeklyCutoff);
    const summary: WireDispatchRunSummary = {
      scanned: due.length,
      sent: 0,
      failed: 0,
      suppressed: 0,
      deduped: 0,
      skippedFlagOff: 0
    };
    for (const subscription of due) {
      const flagged = await this.flags.isEnabled(PRICE_WIRE_FLAG, { userId: subscription.userId });
      if (!flagged) {
        summary.skippedFlagOff += 1;
        continue;
      }
      await this.dispatchOne(subscription, summary, actorId);
    }
    return summary;
  }

  /**
   * Resolves the current quote for a commodity(+market): ingested live
   * observations first, provider port second, honest unavailability last.
   * Records the quote counter and the ingest-freshness histogram.
   */
  private async computeQuote(commodity: string, market?: string): Promise<QuoteOutcome> {
    return this.telemetry.withSpan('advisory.price.quote', { commodity }, async () => {
      const maxAgeMs = Number(process.env.PRICE_WIRE_QUOTE_MAX_AGE_MS ?? PRICE_WIRE_QUOTE_MAX_AGE_MS);
      const nowMs = Date.now();
      const quote = await this.resolveQuote(commodity, market);
      this.telemetry.increment('advisory.price_quotes_total', 1, { basis: quote.basis });
      const outcome = freshnessGate(quote, nowMs, maxAgeMs);
      if (quote.asOf) {
        const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(quote.asOf)) / 1000));
        this.telemetry.record('advisory.price_ingest_freshness_seconds', ageSeconds, {
          commodity,
          ...(quote.market ? { market: quote.market } : {})
        });
      }
      return outcome;
    });
  }

  /** Basis-labelled quote resolution (no freshness decision here). */
  private async resolveQuote(commodity: string, market?: string): Promise<PriceQuote> {
    const rows = await this.prices.find({ commodity, ...(market ? { market } : {}) });
    if (rows.length > 0) {
      const latestRow = rows.reduce((a, b) => (a.observedAt >= b.observedAt ? a : b));
      return {
        commodity,
        market: latestRow.market,
        state: latestRow.state,
        priceKoboPerKg: koboPerKgFromNairaPerKg(latestRow.priceNgn),
        asOf: latestRow.observedAt,
        basis: 'live',
        source: latestRow.source
      };
    }
    if (!this.priceProvider.configured) {
      // Feed keys absent → provider port STUB. No number exists; the quote is
      // labelled stub/unavailable and never dispatched in production.
      return { commodity, ...(market ? { market } : {}), basis: 'unavailable', source: 'feed keys absent (provider port is stub)' };
    }
    try {
      const fetched = await this.priceProvider.fetchQuote(commodity);
      const basis = this.priceProvider.name === 'fixture' ? ('stub' as const) : ('live' as const);
      return {
        commodity,
        ...(market ? { market } : {}),
        priceKoboPerKg: koboPerKgFromNairaPerTonne(fetched.pricePerTonneNaira),
        asOf: fetched.observedAt,
        basis,
        source: fetched.source
      };
    } catch (error) {
      return {
        commodity,
        ...(market ? { market } : {}),
        basis: 'unavailable',
        source: `provider fetch failed: ${(error as Error).message}`
      };
    }
  }

  /** One subscription within a dispatch run; never throws out of the loop. */
  private async dispatchOne(
    subscription: PriceSubscription,
    summary: WireDispatchRunSummary,
    actorId: string
  ): Promise<void> {
    const attributes = { channel: subscription.channel, commodity: subscription.commodity };
    try {
      const outcome = await this.computeQuote(subscription.commodity, subscription.marketId);
      if (outcome.status === 'stale') {
        // Freshness gate: a stale quote is NEVER sent — suppressed, logged,
        // audited, counted, and surfaced as its spec'd domain event.
        await this.suppress(
          subscription,
          `stale quote (${outcome.ageSeconds}s old, beyond freshness TTL)`,
          'live',
          actorId,
          outcome.quote
        );
        summary.suppressed += 1;
        this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'suppressed' });
        await this.events.publish(
          'advisory.price_dispatch.suppressed_stale',
          { subscriptionId: subscription.id, ageSeconds: outcome.ageSeconds },
          actorId
        );
        return;
      }
      if (outcome.status === 'unavailable') {
        await this.suppress(subscription, outcome.reason, 'unavailable', actorId);
        summary.suppressed += 1;
        this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'suppressed' });
        await this.events.publish(
          'advisory.price_dispatch.suppressed',
          { subscriptionId: subscription.id, reason: outcome.reason, basis: 'unavailable' },
          actorId
        );
        return;
      }
      if (outcome.status === 'stub' && isProduction()) {
        // Never SMS a fixture/fixture-derived price in production.
        await this.suppress(
          subscription,
          'stub quote — suppressed in production (never fabricate a price)',
          'stub',
          actorId,
          outcome.quote
        );
        summary.suppressed += 1;
        this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'suppressed' });
        await this.events.publish(
          'advisory.price_dispatch.suppressed',
          { subscriptionId: subscription.id, reason: 'stub_basis_production', basis: 'stub' },
          actorId
        );
        return;
      }
      const quote = outcome.quote;
      const body = renderWireMessage(quote);
      const bodyHash = createHash('sha256').update(body).digest('hex');
      if (await this.wire.hasDeliveredBody(subscription.id, bodyHash)) {
        summary.deduped += 1;
        return;
      }
      await this.deliver(subscription, quote, body, bodyHash, summary, actorId);
    } catch (error) {
      summary.failed += 1;
      this.logger.warn(
        `price dispatch failed for subscription ${subscription.id}: ${(error as Error).message}`
      );
    }
  }

  /** Sends one fresh quote over the subscription channel. */
  private async deliver(
    subscription: PriceSubscription,
    quote: PriceQuote,
    body: string,
    bodyHash: string,
    summary: WireDispatchRunSummary,
    actorId: string
  ): Promise<void> {
    const attributes = { channel: subscription.channel, commodity: subscription.commodity };
    const user = await this.users.findById(subscription.userId);
    if (!user) {
      await this.recordDispatch(subscription, quote, bodyHash, 'failed', 'subscriber account missing');
      summary.failed += 1;
      this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'failed' });
      return;
    }
    if (subscription.channel !== 'sms' && subscription.channel !== 'whatsapp') {
      // Unreachable via listDueForDispatch (USSD is pull-only and excluded);
      // guard anyway — never claim delivery on a channel with no outbound
      // driver.
      await this.recordDispatch(subscription, quote, bodyHash, 'failed', 'channel has no outbound driver');
      summary.failed += 1;
      this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'failed' });
      return;
    }
    const result = await this.integrations.deliverMessage(subscription.channel, {
      to: user.phone,
      text: body,
      subject: `${subscription.commodity} price alert`
    });
    if (result.delivered) {
      try {
        await this.recordDispatch(subscription, quote, bodyHash, 'delivered', result.note);
      } catch (error) {
        if (error instanceof ConflictException) {
          // A concurrent run already delivered this exact quote — dedupe.
          summary.deduped += 1;
          return;
        }
        throw error;
      }
      await this.wire.updateSubscription(subscription.id, {
        lastSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await this.events.publish(
        'advisory.price_dispatch.sent',
        {
          subscriptionId: subscription.id,
          channel: subscription.channel,
          basis: quote.basis,
          providerRef: result.providerRef
        },
        actorId
      );
      summary.sent += 1;
      this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'delivered' });
      return;
    }
    // Honest non-delivery (stub driver or provider failure): recorded failed,
    // never delivered; the next run retries (last_sent_at stays untouched).
    await this.recordDispatch(subscription, quote, bodyHash, 'failed', result.note);
    await this.events.publish(
      'advisory.price_dispatch.failed',
      { subscriptionId: subscription.id, channel: subscription.channel, reason: result.note },
      actorId
    );
    summary.failed += 1;
    this.telemetry.increment('advisory.price_dispatches_total', 1, { ...attributes, result: 'failed' });
  }

  /** Audit + suppress (WP-G15 pattern): no send, honest dispatch row, audit event. */
  private async suppress(
    subscription: PriceSubscription,
    reason: string,
    basis: 'live' | 'stub' | 'unavailable',
    actorId: string,
    quote?: PriceQuote
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.wire.recordDispatch({
      id: newId('pwdsp'),
      subscriptionId: subscription.id,
      ...(quote?.asOf ? { quoteAsOf: quote.asOf } : {}),
      channel: subscription.channel,
      basis,
      deliveryStatus: 'suppressed',
      detail: reason,
      createdAt: now
    });
    await this.audit?.record({
      actorId,
      action: 'advisory.price_dispatch.suppressed',
      entityType: 'price_subscription',
      entityId: subscription.id,
      metadata: { reason, basis }
    });
  }

  private async recordDispatch(
    subscription: PriceSubscription,
    quote: PriceQuote,
    bodyHash: string,
    status: 'delivered' | 'failed',
    detail: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.wire.recordDispatch({
      id: newId('pwdsp'),
      subscriptionId: subscription.id,
      ...(quote.asOf ? { quoteAsOf: quote.asOf } : {}),
      bodyHash,
      channel: subscription.channel,
      basis: quote.basis,
      deliveryStatus: status,
      detail,
      createdAt: now,
      sentAt: status === 'delivered' ? now : undefined
    });
  }

  private outcomeReason(outcome: QuoteOutcome): string {
    switch (outcome.status) {
      case 'stale':
        return 'stale_quote';
      case 'stub':
        return 'stub_basis';
      case 'unavailable':
        return outcome.reason;
      default:
        return 'unavailable';
    }
  }

  private requireActor(actor: User | null): User {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for price subscriptions');
    }
    return actor;
  }
}
