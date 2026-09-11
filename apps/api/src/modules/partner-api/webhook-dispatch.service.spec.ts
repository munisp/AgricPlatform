import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { createInMemoryWebhookSubscriptionRepository } from '../../database/repositories/partner-api.repository.js';
import {
  eventPartnerId,
  signWebhookPayload,
  subscriptionInScope,
  WebhookDispatchService,
  webhookUrlBlockReason,
  type WebhookFetch
} from './webhook-dispatch.service.js';

function event(name: string, payload: unknown): DomainEvent {
  return { id: 'event-1', name, payload, occurredAt: new Date().toISOString() };
}

function makeService(
  subscriptions: Array<Partial<import('../../database/repositories/partner-api.repository.js').WebhookSubscription>>,
  fetchImpl: WebhookFetch
) {
  const repo = createInMemoryWebhookSubscriptionRepository(
    subscriptions.map((sub, index) => ({
      id: sub.id ?? `whsub-${index}`,
      clientId: sub.clientId ?? 'pc_test',
      eventTypes: sub.eventTypes ?? [],
      targetUrl: sub.targetUrl ?? 'https://partner.example/hook',
      secret: sub.secret ?? 'delivery-secret',
      status: sub.status ?? 'active',
      partnerId: sub.partnerId,
      crossTenant: sub.crossTenant,
      createdAt: new Date().toISOString()
    }))
  );
  const events = { on: vi.fn(), publish: vi.fn() };
  const service = new WebhookDispatchService(
    events as never,
    repo,
    fetchImpl
  );
  return { service, events };
}

describe('signWebhookPayload', () => {
  it('produces a sha256=<hmac hex> signature over the exact payload', () => {
    const payload = JSON.stringify({ hello: 'world' });
    const expected = createHmac('sha256', 'secret').update(payload).digest('hex');
    expect(signWebhookPayload('secret', payload)).toBe(`sha256=${expected}`);
  });

  it('changes when the payload changes (tamper resistance)', () => {
    const a = signWebhookPayload('secret', '{"a":1}');
    const b = signWebhookPayload('secret', '{"a":2}');
    expect(a).not.toBe(b);
  });
});

describe('WebhookDispatchService', () => {
  it('delivers signed deliveries to matching active subscriptions', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: WebhookFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 200 };
    };
    const { service } = makeService(
      [
        { eventTypes: ['disbursement.recorded'], targetUrl: 'https://a.example/hook' },
        { eventTypes: ['course.completed'], targetUrl: 'https://b.example/hook' },
        { eventTypes: ['disbursement.recorded'], status: 'disabled', targetUrl: 'https://c.example/hook' }
      ],
      fetchImpl
    );
    const delivered = await service.dispatch(
      'disbursement.recorded',
      event('partner.disbursement.recorded', { id: 'disb-1' })
    );
    expect(delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://a.example/hook');
    expect(calls[0].headers['x-agric-event']).toBe('disbursement.recorded');
    expect(calls[0].headers['x-agric-signature']).toBe(
      signWebhookPayload('delivery-secret', calls[0].body)
    );
    const parsed = JSON.parse(calls[0].body) as { type: string; data: { id: string } };
    expect(parsed.type).toBe('disbursement.recorded');
    expect(parsed.data.id).toBe('disb-1');
  });

  it('reports non-2xx deliveries as failures', async () => {
    const fetchImpl: WebhookFetch = async () => ({ status: 500 });
    const { service } = makeService([{ eventTypes: ['enrolment.created'] }], fetchImpl);
    const delivered = await service.dispatch(
      'enrolment.created',
      event('learning.enrolment.created', {})
    );
    expect(delivered).toBe(0);
  });

  it('subscribes to the domain event wildcard on module init', () => {
    const { service, events } = makeService([], async () => ({ status: 200 }));
    service.onModuleInit();
    expect(events.on).toHaveBeenCalledWith('*', expect.any(Function));
  });

  it('uses a stable per-event delivery id so receivers can dedupe re-drives', async () => {
    const headersSeen: string[] = [];
    const fetchImpl: WebhookFetch = async (_url, init) => {
      headersSeen.push(init.headers['x-agric-delivery']);
      return { status: 200 };
    };
    const { service } = makeService([{ eventTypes: ['enrolment.created'] }], fetchImpl);
    const ev = event('learning.enrolment.created', {});
    await service.dispatch('enrolment.created', ev);
    await service.dispatch('enrolment.created', ev);
    expect(headersSeen).toEqual([`whd_${ev.id}`, `whd_${ev.id}`]);
  });

  describe('at-least-once dispatch (A4-6)', () => {
    it('throws and stays unprocessed on a failed delivery, then re-drives to success', async () => {
      let calls = 0;
      const fetchImpl: WebhookFetch = async () => {
        calls += 1;
        return { status: calls === 1 ? 500 : 200 };
      };
      const { service } = makeService([{ eventTypes: ['disbursement.recorded'] }], fetchImpl);
      const ev = event('partner.disbursement.recorded', { id: 'disb-1' });

      await expect(service.dispatchOnce('disbursement.recorded', ev)).rejects.toThrow(
        /left unprocessed for sweeper re-drive/
      );
      expect(calls).toBe(1);

      // Sweeper re-drive: dedup was never marked, so the delivery is retried.
      await service.dispatchOnce('disbursement.recorded', ev);
      expect(calls).toBe(2);

      // Now recorded as processed: further re-drives are skipped.
      await service.dispatchOnce('disbursement.recorded', ev);
      expect(calls).toBe(2);
    });

    it('marks the event processed when there is nothing to deliver', async () => {
      let calls = 0;
      const fetchImpl: WebhookFetch = async () => {
        calls += 1;
        return { status: 200 };
      };
      const { service } = makeService([], fetchImpl);
      const ev = event('partner.disbursement.recorded', { id: 'disb-2' });
      await service.dispatchOnce('disbursement.recorded', ev);
      await service.dispatchOnce('disbursement.recorded', ev);
      expect(calls).toBe(0);
    });
  });

  describe('tenant scoping (Stage 27 WP-G3)', () => {
    function disbursementEvent(partnerId: string): DomainEvent {
      return event('partner.disbursement.recorded', {
        id: 'disb-1',
        partnerId,
        userId: 'user-1',
        amountNgn: 5000
      });
    }

    it("never delivers partner B's disbursement to partner A's subscriber", async () => {
      const calls: string[] = [];
      const fetchImpl: WebhookFetch = async (url) => {
        calls.push(url);
        return { status: 200 };
      };
      const { service } = makeService(
        [
          {
            partnerId: 'partner-a',
            eventTypes: ['disbursement.recorded'],
            targetUrl: 'https://a.example/hook'
          },
          {
            partnerId: 'partner-b',
            eventTypes: ['disbursement.recorded'],
            targetUrl: 'https://b.example/hook'
          },
          // Platform-level subscription: out of scope for partner events.
          {
            eventTypes: ['disbursement.recorded'],
            targetUrl: 'https://platform.example/hook'
          },
          // Explicit cross-tenant platform/admin receiver: in scope.
          {
            crossTenant: true,
            eventTypes: ['disbursement.recorded'],
            targetUrl: 'https://ops.example/hook'
          }
        ],
        fetchImpl
      );
      const delivered = await service.dispatch(
        'disbursement.recorded',
        disbursementEvent('partner-b')
      );
      expect(delivered).toBe(2);
      expect(calls.sort()).toEqual(['https://b.example/hook', 'https://ops.example/hook']);
      expect(calls).not.toContain('https://a.example/hook');
    });

    it('scopes partner programme enrolment events to the owning partner', async () => {
      const calls: string[] = [];
      const fetchImpl: WebhookFetch = async (url) => {
        calls.push(url);
        return { status: 200 };
      };
      const { service } = makeService(
        [
          {
            partnerId: 'partner-a',
            eventTypes: ['programme_enrolment.recorded'],
            targetUrl: 'https://a.example/hook'
          },
          {
            partnerId: 'partner-b',
            eventTypes: ['programme_enrolment.recorded'],
            targetUrl: 'https://b.example/hook'
          }
        ],
        fetchImpl
      );
      const delivered = await service.dispatch(
        'programme_enrolment.recorded',
        event('partner.enrolment.recorded', {
          id: 'penrol-1',
          partnerId: 'partner-b',
          userId: 'user-1',
          programmeId: 'prog-1'
        })
      );
      expect(delivered).toBe(1);
      expect(calls).toEqual(['https://b.example/hook']);
    });

    it('delivers learning events only to same-tenant (platform) subscribers', async () => {
      const calls: string[] = [];
      const fetchImpl: WebhookFetch = async (url) => {
        calls.push(url);
        return { status: 200 };
      };
      const { service } = makeService(
        [
          // Partner-bound subscriber: learning events are out of scope.
          {
            partnerId: 'partner-a',
            eventTypes: ['enrolment.created'],
            targetUrl: 'https://a.example/hook'
          },
          // Platform-level subscriber: same (platform) tenant as the event.
          {
            eventTypes: ['enrolment.created'],
            targetUrl: 'https://platform.example/hook'
          },
          // Explicit cross-tenant receiver.
          {
            crossTenant: true,
            eventTypes: ['enrolment.created'],
            targetUrl: 'https://ops.example/hook'
          }
        ],
        fetchImpl
      );
      const delivered = await service.dispatch(
        'enrolment.created',
        event('learning.enrolment.created', { enrolmentId: 'enr-1', courseId: 'course-1' })
      );
      expect(delivered).toBe(2);
      expect(calls.sort()).toEqual(['https://ops.example/hook', 'https://platform.example/hook']);
      expect(calls).not.toContain('https://a.example/hook');
    });

    it('eventPartnerId/subscriptionInScope fail closed on shape and scope mismatch', () => {
      expect(eventPartnerId(event('partner.disbursement.recorded', null))).toBeUndefined();
      expect(eventPartnerId(event('partner.disbursement.recorded', { partnerId: 42 }))).toBeUndefined();
      expect(
        subscriptionInScope(
          { partnerId: 'partner-a' } as never,
          eventPartnerId(disbursementEvent('partner-b'))
        )
      ).toBe(false);
      expect(subscriptionInScope({ crossTenant: true } as never, 'partner-b')).toBe(true);
      expect(subscriptionInScope({} as never, undefined)).toBe(true);
    });
  });

  describe('SSRF guard (Stage 27 WP-G3)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      'http://169.254.169.254/latest/meta-data',
      'https://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:9000/hook',
      'https://127.0.0.1/hook',
      'http://10.0.0.4/hook',
      'http://192.168.1.1/hook',
      'http://172.16.0.2/hook',
      'http://100.64.0.1/hook',
      'http://[::1]/hook',
      'http://2130706433/hook', // decimal 127.0.0.1 — normalised by the URL parser
      'http://localhost/hook',
      'file:///etc/passwd'
    ])('rejects %s in production without calling fetch', async (targetUrl) => {
      vi.stubEnv('NODE_ENV', 'production');
      const fetchImpl = vi.fn(async () => ({ status: 200 }));
      const { service } = makeService(
        [{ eventTypes: ['disbursement.recorded'], targetUrl }],
        fetchImpl
      );
      const delivered = await service.dispatch(
        'disbursement.recorded',
        event('partner.disbursement.recorded', { id: 'disb-1' })
      );
      // Fail closed: recorded as a delivery failure, never silently skipped
      // (dispatchOnce would leave the event unprocessed for the sweeper).
      expect(delivered).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects plain http in production but allows it outside production', async () => {
      const fetchImpl: WebhookFetch = async () => ({ status: 200 });
      const { service } = makeService(
        [{ eventTypes: ['enrolment.created'], targetUrl: 'http://partner.example/hook' }],
        fetchImpl
      );
      const ev = event('learning.enrolment.created', {});

      vi.stubEnv('NODE_ENV', 'production');
      expect(webhookUrlBlockReason('http://partner.example/hook')).toContain('production');
      expect(await service.dispatch('enrolment.created', ev)).toBe(0);

      vi.stubEnv('NODE_ENV', 'development');
      expect(webhookUrlBlockReason('http://partner.example/hook')).toBeNull();
      expect(await service.dispatch('enrolment.created', ev)).toBe(1);
    });

    it('still blocks private addresses outside production', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const fetchImpl = vi.fn(async () => ({ status: 200 }));
      const { service } = makeService(
        [{ eventTypes: ['enrolment.created'], targetUrl: 'http://169.254.169.254/latest' }],
        fetchImpl
      );
      expect(
        await service.dispatch('enrolment.created', event('learning.enrolment.created', {}))
      ).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('allows https deliveries to public hosts in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const fetchImpl: WebhookFetch = async () => ({ status: 200 });
      const { service } = makeService([{ eventTypes: ['enrolment.created'] }], fetchImpl);
      expect(
        await service.dispatch('enrolment.created', event('learning.enrolment.created', {}))
      ).toBe(1);
    });
  });

  describe('fetch timeout (Stage 27 WP-G3)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('passes an AbortSignal and records a failure when the delivery times out', async () => {
      vi.stubEnv('WEBHOOK_FETCH_TIMEOUT_MS', '25');
      let sawAbort = false;
      const fetchImpl: WebhookFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('This operation was aborted'));
          });
        });
      const { service } = makeService([{ eventTypes: ['enrolment.created'] }], fetchImpl);
      const ev = event('learning.enrolment.created', {});

      // Recorded failure: dispatchOnce throws and the event stays unprocessed.
      await expect(service.dispatchOnce('enrolment.created', ev)).rejects.toThrow(
        /left unprocessed for sweeper re-drive/
      );
      expect(sawAbort).toBe(true);
    });

    it('uses the 10s default when WEBHOOK_FETCH_TIMEOUT_MS is unset or invalid', async () => {
      vi.stubEnv('WEBHOOK_FETCH_TIMEOUT_MS', 'not-a-number');
      const fetchImpl: WebhookFetch = async () => ({ status: 200 });
      const { service } = makeService([{ eventTypes: ['enrolment.created'] }], fetchImpl);
      expect(
        await service.dispatch('enrolment.created', event('learning.enrolment.created', {}))
      ).toBe(1);
    });
  });
});
