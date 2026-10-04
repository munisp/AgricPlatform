import type { DomainEvent } from './domain-events.service.js';

/**
 * Static consumer-coverage inventory (audit C2-8): every domain-event name
 * the platform publishes, and which in-process consumers subscribe. The
 * accompanying spec cross-checks this table against the actual
 * DomainEventsService subscriptions registered at module-init time and
 * fails when a new event ships with zero consumers and no explicit
 * 'intentionally unconsumed' marker.
 */

export interface EventConsumerEntry {
  /** Event name as published (e.g. 'farms.plot.created'). */
  event: string;
  /** Consumers: module/service identifiers that subscribe in-process. */
  consumers: string[];
  /** When consumers is empty, WHY that is acceptable (audited). */
  unconsumedReason?: string;
}

/**
 * The inventory. Keep alphabetical by event name; the spec asserts
 * completeness against the live subscription registry.
 */
export const EVENT_CONSUMER_COVERAGE: readonly EventConsumerEntry[] = [
  { event: 'advisory.content.published', consumers: ['notifications'] },
  { event: 'chapters.announcement.created', consumers: ['notifications'] },
  { event: 'chapters.event.created', consumers: ['notifications'] },
  { event: 'community.moderation.flagged', consumers: ['notifications'] },
  { event: 'compliance.dsr.completed', consumers: ['notifications'] },
  { event: 'farms.plot.created', consumers: ['geo-intel', 'geo.h3-index'] },
  { event: 'farms.plot.removed', consumers: ['geo.h3-index'] },
  { event: 'farms.plot.updated', consumers: ['geo.h3-index'] },
  { event: 'finance.ledger.entry_posted', consumers: ['analytics'] },
  {
    event: 'geo.h3_index.reindexed',
    consumers: [],
    unconsumedReason: 'ops signal for dashboards; no in-process reactor (audited C2-8)'
  },
  { event: 'insurance.trigger.fired', consumers: ['voucher-covers'] },
  { event: 'insurance.payout.settled', consumers: ['voucher-covers', 'notifications'] },
  { event: 'learning.course.completed', consumers: ['notifications', 'analytics'] },
  { event: 'livestock-trade.lien.released', consumers: ['notifications'] },
  { event: 'marketplace.listing.created', consumers: ['search'] },
  { event: 'marketplace.listing.updated', consumers: ['search'] },
  { event: 'marketplace.order.created', consumers: ['notifications', 'escrow'] },
  { event: 'marketplace.order.status_changed', consumers: ['notifications', 'escrow'] },
  { event: 'notifications.message.sent', consumers: ['analytics'] },
  { event: 'partner.disbursement.recorded', consumers: ['analytics'] },
  { event: 'payments.intent.confirmed', consumers: ['escrow', 'analytics'] },
  { event: 'payments.intent.expired', consumers: ['escrow'] },
  { event: 'programmes.enrolment.created', consumers: ['notifications'] },
  { event: 'sync.mutation.applied', consumers: ['analytics'] },
  { event: 'users.user.created', consumers: ['notifications', 'analytics'] },
  { event: 'users.user.suspended', consumers: ['sessions'] },
  { event: 'warehouse.receipt.issued', consumers: ['notifications'] },
  { event: 'warehouse.receipt.pledged', consumers: ['collateral-registry'] }
];

/** Events a consumer is known to subscribe to (module-init registration). */
export interface ConsumerSubscription {
  consumer: string;
  events: string[];
}

/**
 * Validates the coverage table against live subscription data collected
 * from DomainEventsService at boot. Returns the list of problems (empty =
 * coverage complete and consistent).
 */
export function validateConsumerCoverage(
  liveSubscriptions: Map<string, string[]>,
  coverage: readonly EventConsumerEntry[] = EVENT_CONSUMER_COVERAGE
): string[] {
  const problems: string[] = [];
  const covered = new Map(coverage.map((entry) => [entry.event, entry]));
  for (const [event, consumers] of liveSubscriptions) {
    const entry = covered.get(event);
    if (!entry) {
      problems.push(`event '${event}' has live consumers ${JSON.stringify(consumers)} but no coverage row`);
      continue;
    }
    const declared = new Set(entry.consumers);
    for (const consumer of consumers) {
      if (!declared.has(consumer)) {
        problems.push(`event '${event}': live consumer '${consumer}' missing from coverage row`);
      }
    }
  }
  for (const entry of coverage) {
    if (entry.consumers.length === 0 && !entry.unconsumedReason) {
      problems.push(`event '${entry.event}' declares zero consumers without an unconsumedReason`);
    }
  }
  return problems;
}

/** Records the subscription of one consumer to one event (boot-time). */
export function recordSubscription(
  registry: Map<string, string[]>,
  consumer: string,
  event: DomainEvent['name']
): void {
  const list = registry.get(event) ?? [];
  if (!list.includes(consumer)) {
    list.push(consumer);
  }
  registry.set(event, list);
}
