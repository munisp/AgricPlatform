import type { AdvisoryPulseSubscription } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface AdvisoryPulseCriteria {
  userId?: string;
  channel?: AdvisoryPulseSubscription['channel'];
  enabled?: boolean;
}

/**
 * Advisory pulse subscriptions (advisory.pulse_subscriptions, wave P2c).
 * A user opts a channel into the daily digest; the digest worker reads
 * enabled subscriptions per channel.
 */
export interface AdvisoryPulseRepository
  extends AsyncRepository<AdvisoryPulseSubscription, AdvisoryPulseCriteria> {
  /** Idempotent upsert keyed by (userId, channel). */
  upsert(subscription: AdvisoryPulseSubscription): Promise<AdvisoryPulseSubscription>;
}

export function advisoryPulseMatcher(
  criteria: AdvisoryPulseCriteria
): (subscription: AdvisoryPulseSubscription) => boolean {
  return (subscription) =>
    (!criteria.userId || subscription.userId === criteria.userId) &&
    (!criteria.channel || subscription.channel === criteria.channel) &&
    (criteria.enabled === undefined || subscription.enabled === criteria.enabled);
}

export class InMemoryAdvisoryPulseRepository
  extends InMemoryRepository<AdvisoryPulseSubscription, AdvisoryPulseCriteria>
  implements AdvisoryPulseRepository
{
  constructor(seed: readonly AdvisoryPulseSubscription[] = []) {
    super(seed, advisoryPulseMatcher);
  }

  async upsert(subscription: AdvisoryPulseSubscription): Promise<AdvisoryPulseSubscription> {
    const existing = (await this.find({ userId: subscription.userId })).find(
      (row) => row.channel === subscription.channel
    );
    if (existing) {
      return this.update(existing.id, subscription);
    }
    return this.create(subscription);
  }
}

export function createInMemoryAdvisoryPulseRepository(
  seed: readonly AdvisoryPulseSubscription[] = []
): InMemoryAdvisoryPulseRepository {
  return new InMemoryAdvisoryPulseRepository(seed);
}
