import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { WEBHOOK_SUBSCRIPTION_REPOSITORY } from '../../database/persistence.tokens.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import type {
  WebhookSubscription,
  WebhookSubscriptionRepository
} from '../../database/repositories/partner-api.repository.js';

/**
 * Partner-facing webhook event types. Internal domain events keep their
 * `{domain}.{entity}.{verb}` taxonomy; this map exposes a stable public
 * vocabulary to subscribers.
 */
export const PARTNER_EVENT_TYPES = [
  'course.completed',
  'enrolment.created',
  'disbursement.recorded',
  'programme_enrolment.recorded'
] as const;

export type PartnerEventType = (typeof PARTNER_EVENT_TYPES)[number];

/** Consumer name in events.processed_events for the dispatch dedup ledger. */
export const WEBHOOK_DISPATCH_CONSUMER = 'partner-webhook-dispatch';

const DOMAIN_EVENT_MAP: Record<string, PartnerEventType> = {
  'learning.certificate.issued': 'course.completed',
  'learning.enrolment.created': 'enrolment.created',
  'partner.disbursement.recorded': 'disbursement.recorded',
  'partner.enrolment.recorded': 'programme_enrolment.recorded'
};

export interface WebhookDelivery {
  id: string;
  type: PartnerEventType;
  occurredAt: string;
  data: unknown;
}

export type WebhookFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ status: number }>;

/** Default outbound delivery timeout; override via WEBHOOK_FETCH_TIMEOUT_MS. */
export const DEFAULT_WEBHOOK_FETCH_TIMEOUT_MS = 10_000;

/** Outbound fetch timeout in ms (env-configurable, fail-safe default). */
export function webhookFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEBHOOK_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_WEBHOOK_FETCH_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_FETCH_TIMEOUT_MS;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 || // "this" network
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments 192.0.0.0/24
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmark
    a >= 224 // multicast / reserved
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('::ffff:')) return isPrivateIpv4(h.slice('::ffff:'.length)); // v4-mapped
  return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'); // ULA + link-local
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * SSRF guard for outbound webhook target URLs (Stage 27 WP-G3). Returns a
 * human-readable block reason, or null when the URL is deliverable. The URL
 * parser normalises decimal/hex/octal IPv4 literals (e.g. http://2130706433)
 * to dotted-quad before the range checks below run.
 *
 * Fail closed in every environment: private/loopback/link-local addresses
 * and local hostnames are always blocked; plain http is allowed only outside
 * production (NODE_ENV != 'production').
 */
export function webhookUrlBlockReason(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return 'unparseable target URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `unsupported scheme '${url.protocol}'`;
  }
  if (url.protocol === 'http:' && env.NODE_ENV === 'production') {
    return 'plain http target URLs are not allowed in production';
  }
  // WHATWG URL keeps IPv6 hostnames bracketed; strip for the range checks.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal')
  ) {
    return `blocked local hostname '${hostname}'`;
  }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return `private/loopback/link-local address '${hostname}'`;
  }
  return null;
}

/**
 * Owning partner for a domain event, when the payload carries one. Events
 * without a partnerId (e.g. learning.*) are platform-scoped.
 */
export function eventPartnerId(event: DomainEvent): string | undefined {
  const payload = event.payload as { partnerId?: unknown } | null | undefined;
  return payload && typeof payload.partnerId === 'string' ? payload.partnerId : undefined;
}

/**
 * Tenant-scope check (Stage 27 WP-G3, V3 middleware audit): an event is
 * delivered to a subscription only when both belong to the same tenant —
 * same partnerId, or both platform-level (no partnerId) — unless the
 * subscription is an explicit cross-tenant platform/admin receiver.
 */
export function subscriptionInScope(
  subscription: WebhookSubscription,
  owningPartnerId: string | undefined
): boolean {
  if (subscription.crossTenant === true) return true;
  return subscription.partnerId === owningPartnerId;
}

/** HMAC-SHA256 signature over the exact JSON payload (sha256=<hex>). */
export function signWebhookPayload(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/**
 * Outbound webhook dispatcher (wave P5d). Listens to the domain-event
 * outbox (DomainEventsService already persists every event before fan-out,
 * so deliveries are outbox-style replayable) and POSTs HMAC-signed JSON
 * deliveries to each active subscription matching the event type.
 */
@Injectable()
export class WebhookDispatchService implements OnModuleInit {
  private readonly logger = new Logger(WebhookDispatchService.name);
  private readonly fetchImpl: WebhookFetch;

  constructor(
    private readonly events: DomainEventsService,
    @Inject(WEBHOOK_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: WebhookSubscriptionRepository,
    @Optional() fetchImpl?: WebhookFetch,
    // @Optional: unit specs construct the service directly; Nest injects the
    // shared EventDedupService (events.processed_events) at runtime.
    @Optional()
    private readonly dedup: EventDedupService = new EventDedupService(
      createInMemoryProcessedEventRepository()
    )
  ) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as WebhookFetch);
  }

  onModuleInit(): void {
    this.events.on('*', (event: DomainEvent) => {
      const type = DOMAIN_EVENT_MAP[event.name];
      if (type) {
        void this.dispatchOnce(type, event).catch((error: unknown) => {
          this.logger.warn(
            `webhook dispatch for ${event.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
    });
  }

  /**
   * Consumer-side dedup, MARK-AFTER-DISPATCH (audit A4-6): the event is
   * recorded in events.processed_events only after every subscribed delivery
   * succeeded. A failed delivery throws, the event stays unprocessed, and the
   * outbox sweeper re-drives it — dispatch is at-least-once. Receivers dedupe
   * re-deliveries via the stable per-event delivery id (x-agric-delivery).
   * Public: also the outbox-sweeper re-drive entry point.
   */
  async dispatchOnce(type: PartnerEventType, event: DomainEvent): Promise<void> {
    if (await this.dedup.has(WEBHOOK_DISPATCH_CONSUMER, event.id)) {
      return;
    }
    const { delivered, targets } = await this.fanOut(type, event);
    if (delivered < targets) {
      throw new Error(
        `webhook dispatch for event ${event.id}: ${targets - delivered} of ${targets} deliveries failed — left unprocessed for sweeper re-drive`
      );
    }
    await this.dedup.mark(WEBHOOK_DISPATCH_CONSUMER, event.id);
  }

  /** Delivers one partner event to every active subscribed client URL. */
  async dispatch(type: PartnerEventType, event: DomainEvent): Promise<number> {
    return (await this.fanOut(type, event)).delivered;
  }

  /**
   * Fans the event out to all matching active subscriptions IN THE EVENT'S
   * TENANT SCOPE (Stage 27 WP-G3: previously type-only filtering leaked
   * partner.* payloads — partnerId + userId + amountNgn — to every
   * subscriber). The delivery id is derived from the event id (not
   * regenerated per attempt) so a partner can dedupe a re-driven delivery
   * against the first attempt.
   */
  private async fanOut(
    type: PartnerEventType,
    event: DomainEvent
  ): Promise<{ delivered: number; targets: number }> {
    const active = await this.subscriptions.find({ status: 'active' });
    const owningPartnerId = eventPartnerId(event);
    const targets = active.filter(
      (subscription) =>
        subscription.eventTypes.includes(type) &&
        subscriptionInScope(subscription, owningPartnerId)
    );
    const delivery: WebhookDelivery = {
      id: `whd_${event.id}`,
      type,
      occurredAt: event.occurredAt,
      data: event.payload
    };
    const body = JSON.stringify(delivery);
    let delivered = 0;
    for (const subscription of targets) {
      const ok = await this.deliver(subscription, delivery, body);
      if (ok) delivered += 1;
    }
    return { delivered, targets: targets.length };
  }

  /**
   * Signs and POSTs a single delivery. Returns true on a 2xx response.
   * Fail-closed (Stage 27 WP-G3): SSRF-guard rejections, transport errors
   * and timeouts are recorded as delivery failures (warn log + false → the
   * event stays unprocessed for the sweeper) and never silently skipped.
   */
  async deliver(
    subscription: WebhookSubscription,
    delivery: WebhookDelivery,
    body = JSON.stringify(delivery)
  ): Promise<boolean> {
    const blockReason = webhookUrlBlockReason(subscription.targetUrl);
    if (blockReason) {
      this.logger.warn(
        `webhook ${delivery.id} to ${subscription.targetUrl} blocked by SSRF guard: ${blockReason}`
      );
      return false;
    }
    const timeoutMs = webhookFetchTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Never hold the event loop open for a delivery timer.
    (timer as { unref?: () => void }).unref?.();
    try {
      const response = await this.fetchImpl(subscription.targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agric-signature': signWebhookPayload(subscription.secret, body),
          'x-agric-event': delivery.type,
          'x-agric-delivery': delivery.id
        },
        body,
        signal: controller.signal
      });
      if (response.status < 200 || response.status >= 300) {
        this.logger.warn(
          `webhook ${delivery.id} to ${subscription.targetUrl} returned ${response.status}`
        );
        return false;
      }
      return true;
    } catch (error: unknown) {
      const reason = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      this.logger.warn(`webhook ${delivery.id} to ${subscription.targetUrl} failed: ${reason}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
