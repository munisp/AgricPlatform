import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Planting-Window Pulse persistence port (Stage 27 Batch 1, innovation 4;
 * migration 058_advisory_planting_pulse.sql). Two tables:
 * advisory.plot_advisory_subscriptions (one active row per plot+channel+crop)
 * and advisory.advisory_dispatches (append-only attempt log with basis
 * honesty labelling and a delivered-dedupe guarantee).
 */

export type PulseChannel = 'sms' | 'ussd' | 'whatsapp' | 'voice';
export type PulseSubscriptionStatus = 'active' | 'paused' | 'stopped';
export type PulseDispatchBasis = 'live' | 'unavailable';
export type PulseDispatchStatus = 'suppressed' | 'failed' | 'delivered';

export interface PlotAdvisorySubscription {
  id: string;
  plotId: string;
  userId: string;
  channel: PulseChannel;
  crop: string;
  /** Plot centroid snapped to H3 resolution 9 (set at subscription time). */
  h3Res9?: string;
  locale: string;
  /** Last generated window snapshot (null until the first successful run). */
  plantingWindow?: Record<string, unknown>;
  lastSentAt?: string;
  /** NDPA consent record id captured at subscription time. */
  consentId?: string;
  status: PulseSubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdvisoryDispatch {
  id: string;
  subscriptionId: string;
  /** ISO date of the advised window start; undefined when suppressed. */
  windowStart?: string;
  /** sha256 of the rendered message body; undefined when never rendered. */
  bodyHash?: string;
  channel: PulseChannel;
  basis: PulseDispatchBasis;
  deliveryStatus: PulseDispatchStatus;
  /** Honest reason / driver note. Never carries message PII. */
  detail?: string;
  ruleVersion?: string;
  createdAt: string;
  sentAt?: string;
}

export interface PulseSubscriptionCriteria {
  userId?: string;
  plotId?: string;
  status?: PulseSubscriptionStatus;
}

export interface AdvisoryPulseRepository {
  /**
   * Inserts a subscription. Throws ConflictException when an ACTIVE
   * (plot, channel, crop) subscription already exists — the partial unique
   * index in migration 058 is the pg-side guard.
   */
  createSubscription(subscription: PlotAdvisorySubscription): Promise<PlotAdvisorySubscription>;
  findSubscriptions(criteria: PulseSubscriptionCriteria): Promise<PlotAdvisorySubscription[]>;
  findSubscriptionById(id: string): Promise<PlotAdvisorySubscription | undefined>;
  /** Throws NotFoundException when the id does not exist. */
  getSubscriptionById(id: string): Promise<PlotAdvisorySubscription>;
  updateSubscription(
    id: string,
    patch: Partial<PlotAdvisorySubscription>
  ): Promise<PlotAdvisorySubscription>;
  /**
   * Guarded stop: active|paused → stopped in one write (pg uses a
   * status-guarded UPDATE, so a concurrent double-stop cannot produce two
   * diverging rows). Replays of an already-stopped subscription return the
   * stopped row unchanged (DELETE stays replay-safe).
   */
  stopSubscription(id: string): Promise<PlotAdvisorySubscription>;
  /**
   * Active subscriptions due for a dispatch run: channel is pushable (not
   * the pull-only USSD channel) and last_sent_at is null or older than
   * `sentBeforeIso`.
   */
  listDueForDispatch(sentBeforeIso: string): Promise<PlotAdvisorySubscription[]>;
  /**
   * Appends one dispatch attempt. Throws ConflictException when a 'delivered'
   * row already exists for (subscriptionId, bodyHash) — the same planting
   * window is never recorded (or sent) twice.
   */
  recordDispatch(dispatch: AdvisoryDispatch): Promise<AdvisoryDispatch>;
  dispatchesFor(subscriptionId: string): Promise<AdvisoryDispatch[]>;
  hasDeliveredBody(subscriptionId: string, bodyHash: string): Promise<boolean>;
}

/** In-memory reference implementation (tests + no-DATABASE_URL development). */
export class InMemoryAdvisoryPulseRepository implements AdvisoryPulseRepository {
  private readonly subscriptions = new Map<string, PlotAdvisorySubscription>();
  private readonly dispatches = new Map<string, AdvisoryDispatch>();

  constructor(seed: readonly PlotAdvisorySubscription[] = []) {
    for (const subscription of seed) {
      this.subscriptions.set(subscription.id, { ...subscription });
    }
  }

  createSubscription(
    subscription: PlotAdvisorySubscription
  ): Promise<PlotAdvisorySubscription> {
    const duplicate = [...this.subscriptions.values()].find(
      (existing) =>
        existing.status === 'active' &&
        existing.plotId === subscription.plotId &&
        existing.channel === subscription.channel &&
        existing.crop === subscription.crop
    );
    if (duplicate) {
      throw new ConflictException(
        `An active ${subscription.channel} subscription for crop '${subscription.crop}' already exists for this plot`
      );
    }
    this.subscriptions.set(subscription.id, { ...subscription });
    return Promise.resolve({ ...subscription });
  }

  findSubscriptions(criteria: PulseSubscriptionCriteria): Promise<PlotAdvisorySubscription[]> {
    return Promise.resolve(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            (!criteria.userId || subscription.userId === criteria.userId) &&
            (!criteria.plotId || subscription.plotId === criteria.plotId) &&
            (!criteria.status || subscription.status === criteria.status)
        )
        .map((subscription) => ({ ...subscription }))
    );
  }

  findSubscriptionById(id: string): Promise<PlotAdvisorySubscription | undefined> {
    const found = this.subscriptions.get(id);
    return Promise.resolve(found ? { ...found } : undefined);
  }

  getSubscriptionById(id: string): Promise<PlotAdvisorySubscription> {
    const found = this.subscriptions.get(id);
    if (!found) {
      throw new NotFoundException(`Advisory subscription '${id}' not found`);
    }
    return Promise.resolve({ ...found });
  }

  updateSubscription(
    id: string,
    patch: Partial<PlotAdvisorySubscription>
  ): Promise<PlotAdvisorySubscription> {
    const found = this.subscriptions.get(id);
    if (!found) {
      throw new NotFoundException(`Advisory subscription '${id}' not found`);
    }
    const updated = { ...found, ...patch, id };
    this.subscriptions.set(id, updated);
    return Promise.resolve({ ...updated });
  }

  stopSubscription(id: string): Promise<PlotAdvisorySubscription> {
    const found = this.subscriptions.get(id);
    if (!found) {
      throw new NotFoundException(`Advisory subscription '${id}' not found`);
    }
    if (found.status === 'stopped') {
      // Replay-safe DELETE: stopping a stopped subscription is a no-op.
      return Promise.resolve({ ...found });
    }
    const stopped: PlotAdvisorySubscription = {
      ...found,
      status: 'stopped',
      updatedAt: new Date().toISOString()
    };
    this.subscriptions.set(id, stopped);
    return Promise.resolve({ ...stopped });
  }

  listDueForDispatch(sentBeforeIso: string): Promise<PlotAdvisorySubscription[]> {
    return Promise.resolve(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            subscription.status === 'active' &&
            subscription.channel !== 'ussd' &&
            (!subscription.lastSentAt || subscription.lastSentAt <= sentBeforeIso)
        )
        .map((subscription) => ({ ...subscription }))
    );
  }

  recordDispatch(dispatch: AdvisoryDispatch): Promise<AdvisoryDispatch> {
    if (dispatch.deliveryStatus === 'delivered' && dispatch.bodyHash) {
      const duplicate = [...this.dispatches.values()].find(
        (existing) =>
          existing.subscriptionId === dispatch.subscriptionId &&
          existing.bodyHash === dispatch.bodyHash &&
          existing.deliveryStatus === 'delivered'
      );
      if (duplicate) {
        throw new ConflictException(
          'This planting window was already delivered for the subscription'
        );
      }
    }
    this.dispatches.set(dispatch.id, { ...dispatch });
    return Promise.resolve({ ...dispatch });
  }

  dispatchesFor(subscriptionId: string): Promise<AdvisoryDispatch[]> {
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

export function createInMemoryAdvisoryPulseRepository(
  seed: readonly PlotAdvisorySubscription[] = []
): InMemoryAdvisoryPulseRepository {
  return new InMemoryAdvisoryPulseRepository(seed);
}
