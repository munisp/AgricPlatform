import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Price Wire persistence port (Stage 27, innovation 11; migration
 * 069_price_subscriptions.sql). Two tables: advisory.price_subscriptions
 * (one row per user+commodity+market+channel — the spec dedupe key) and
 * advisory.price_dispatches (append-only attempt log with basis honesty
 * labelling and a delivered-dedupe guarantee).
 */

export type WireChannel = 'sms' | 'ussd' | 'whatsapp';
export type WireCadence = 'weekly' | 'daily';
export type WireSubscriptionStatus = 'active' | 'stopped';
export type WireDispatchBasis = 'live' | 'stub' | 'unavailable';
export type WireDispatchStatus = 'suppressed' | 'failed' | 'delivered';

export interface PriceSubscription {
  id: string;
  userId: string;
  /** Canonical commodity key (lowercase). */
  commodity: string;
  /** Market name (logical ref advisory.commodity_prices.market). */
  marketId: string;
  channel: WireChannel;
  cadence: WireCadence;
  lastSentAt?: string;
  status: WireSubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PriceDispatch {
  id: string;
  subscriptionId: string;
  /** Observation time of the quoted price; undefined when suppressed pre-quote. */
  quoteAsOf?: string;
  /** sha256 of the rendered message body; undefined when never rendered. */
  bodyHash?: string;
  channel: WireChannel;
  basis: WireDispatchBasis;
  deliveryStatus: WireDispatchStatus;
  /** Honest reason / driver note. Never carries message PII. */
  detail?: string;
  createdAt: string;
  sentAt?: string;
}

export interface PriceSubscriptionCriteria {
  userId?: string;
  commodity?: string;
  status?: WireSubscriptionStatus;
}

export interface PriceWireRepository {
  /**
   * Inserts a subscription. Throws ConflictException when a row already
   * exists for (userId, commodity, marketId, channel) — the UNIQUE index in
   * migration 069 is the pg-side guard and covers stopped rows, so the
   * service revives a stopped row instead of duplicating it.
   */
  createSubscription(subscription: PriceSubscription): Promise<PriceSubscription>;
  findSubscriptions(criteria: PriceSubscriptionCriteria): Promise<PriceSubscription[]>;
  findSubscriptionById(id: string): Promise<PriceSubscription | undefined>;
  /** Throws NotFoundException when the id does not exist. */
  getSubscriptionById(id: string): Promise<PriceSubscription>;
  /** Finds the (unique) row for the spec dedupe key, active or stopped. */
  findByDedupeKey(
    userId: string,
    commodity: string,
    marketId: string,
    channel: WireChannel
  ): Promise<PriceSubscription | undefined>;
  updateSubscription(
    id: string,
    patch: Partial<PriceSubscription>
  ): Promise<PriceSubscription>;
  /**
   * Guarded stop: active → stopped in one write (pg uses a status-guarded
   * UPDATE, so a concurrent double-stop cannot fork state). Replays of an
   * already-stopped subscription return the stopped row unchanged (DELETE
   * stays replay-safe).
   */
  stopSubscription(id: string): Promise<PriceSubscription>;
  /**
   * Active subscriptions due for a dispatch run: channel is pushable (not
   * the pull-only USSD channel) and last_sent_at is null or older than the
   * cadence's cutoff (daily subscriptions against `dailyCutoffIso`, weekly
   * against `weeklyCutoffIso`).
   */
  listDueForDispatch(
    dailyCutoffIso: string,
    weeklyCutoffIso: string
  ): Promise<PriceSubscription[]>;
  /**
   * Appends one dispatch attempt. Throws ConflictException when a
   * 'delivered' row already exists for (subscriptionId, bodyHash) — the
   * same rendered quote is never recorded (or sent) twice.
   */
  recordDispatch(dispatch: PriceDispatch): Promise<PriceDispatch>;
  dispatchesFor(subscriptionId: string): Promise<PriceDispatch[]>;
  hasDeliveredBody(subscriptionId: string, bodyHash: string): Promise<boolean>;
}

/** The spec dedupe key (user, commodity, market, channel). */
export function priceSubscriptionKey(
  subscription: Pick<PriceSubscription, 'userId' | 'commodity' | 'marketId' | 'channel'>
): string {
  return [
    subscription.userId,
    subscription.commodity,
    subscription.marketId,
    subscription.channel
  ].join('¦');
}

/** In-memory reference implementation (tests + no-DATABASE_URL development). */
export class InMemoryPriceWireRepository implements PriceWireRepository {
  private readonly subscriptions = new Map<string, PriceSubscription>();
  private readonly dispatches = new Map<string, PriceDispatch>();

  constructor(seed: readonly PriceSubscription[] = []) {
    for (const subscription of seed) {
      this.subscriptions.set(subscription.id, { ...subscription });
    }
  }

  createSubscription(subscription: PriceSubscription): Promise<PriceSubscription> {
    const duplicate = [...this.subscriptions.values()].find(
      (existing) =>
        priceSubscriptionKey(existing) === priceSubscriptionKey(subscription)
    );
    if (duplicate) {
      throw new ConflictException(
        `A ${subscription.channel} price subscription for '${subscription.commodity}' at ` +
          `'${subscription.marketId}' already exists for this user`
      );
    }
    this.subscriptions.set(subscription.id, { ...subscription });
    return Promise.resolve({ ...subscription });
  }

  findSubscriptions(criteria: PriceSubscriptionCriteria): Promise<PriceSubscription[]> {
    return Promise.resolve(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            (!criteria.userId || subscription.userId === criteria.userId) &&
            (!criteria.commodity || subscription.commodity === criteria.commodity) &&
            (!criteria.status || subscription.status === criteria.status)
        )
        .map((subscription) => ({ ...subscription }))
    );
  }

  findSubscriptionById(id: string): Promise<PriceSubscription | undefined> {
    const found = this.subscriptions.get(id);
    return Promise.resolve(found ? { ...found } : undefined);
  }

  getSubscriptionById(id: string): Promise<PriceSubscription> {
    const found = this.subscriptions.get(id);
    if (!found) {
      throw new NotFoundException(`Price subscription '${id}' not found`);
    }
    return Promise.resolve({ ...found });
  }

  findByDedupeKey(
    userId: string,
    commodity: string,
    marketId: string,
    channel: WireChannel
  ): Promise<PriceSubscription | undefined> {
    const key = priceSubscriptionKey({ userId, commodity, marketId, channel });
    const found = [...this.subscriptions.values()].find(
      (existing) => priceSubscriptionKey(existing) === key
    );
    return Promise.resolve(found ? { ...found } : undefined);
  }

  updateSubscription(
    id: string,
    patch: Partial<PriceSubscription>
  ): Promise<PriceSubscription> {
    const found = this.subscriptions.get(id);
    if (!found) {
      throw new NotFoundException(`Price subscription '${id}' not found`);
    }
    const updated = { ...found, ...patch, id };
    this.subscriptions.set(id, updated);
    return Promise.resolve({ ...updated });
  }

  stopSubscription(id: string): Promise<PriceSubscription> {
    const found = this.subscriptions.get(id);
    if (!found) {
      throw new NotFoundException(`Price subscription '${id}' not found`);
    }
    if (found.status === 'stopped') {
      // Replay-safe DELETE: stopping a stopped subscription is a no-op.
      return Promise.resolve({ ...found });
    }
    const stopped: PriceSubscription = {
      ...found,
      status: 'stopped',
      updatedAt: new Date().toISOString()
    };
    this.subscriptions.set(id, stopped);
    return Promise.resolve({ ...stopped });
  }

  listDueForDispatch(
    dailyCutoffIso: string,
    weeklyCutoffIso: string
  ): Promise<PriceSubscription[]> {
    return Promise.resolve(
      [...this.subscriptions.values()]
        .filter((subscription) => {
          if (subscription.status !== 'active' || subscription.channel === 'ussd') {
            return false;
          }
          if (!subscription.lastSentAt) {
            return true;
          }
          const cutoff = subscription.cadence === 'daily' ? dailyCutoffIso : weeklyCutoffIso;
          return subscription.lastSentAt <= cutoff;
        })
        .map((subscription) => ({ ...subscription }))
    );
  }

  recordDispatch(dispatch: PriceDispatch): Promise<PriceDispatch> {
    if (dispatch.deliveryStatus === 'delivered' && dispatch.bodyHash) {
      const duplicate = [...this.dispatches.values()].find(
        (existing) =>
          existing.subscriptionId === dispatch.subscriptionId &&
          existing.bodyHash === dispatch.bodyHash &&
          existing.deliveryStatus === 'delivered'
      );
      if (duplicate) {
        throw new ConflictException(
          'This price quote was already delivered for the subscription'
        );
      }
    }
    this.dispatches.set(dispatch.id, { ...dispatch });
    return Promise.resolve({ ...dispatch });
  }

  dispatchesFor(subscriptionId: string): Promise<PriceDispatch[]> {
    return Promise.resolve(
      [...this.dispatches.values()]
        .filter((dispatch) => dispatch.subscriptionId === subscriptionId)
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id.localeCompare(b.id)
            : a.createdAt.localeCompare(b.createdAt)
        )
        .map((dispatch) => ({ ...dispatch }))
    );
  }

  hasDeliveredBody(subscriptionId: string, bodyHash: string): Promise<boolean> {
    return Promise.resolve(
      [...this.dispatches.values()].some(
        (dispatch) =>
          dispatch.subscriptionId === subscriptionId &&
          dispatch.bodyHash === bodyHash &&
          dispatch.deliveryStatus === 'delivered'
      )
    );
  }
}

export function createInMemoryPriceWireRepository(
  seed: readonly PriceSubscription[] = []
): InMemoryPriceWireRepository {
  return new InMemoryPriceWireRepository(seed);
}
