import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { createInMemoryWebhookSubscriptionRepository } from '../../database/repositories/partner-api.repository.js';
import {
  signWebhookPayload,
  WebhookDispatchService,
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
});
