import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import type { AdvisoryService } from '../advisory/advisory.service.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import { UsersService } from '../users/users.service.js';
import { InboundConversationsService } from './inbound-conversations.service.js';

function msg(id: string, from: string, text: string) {
  return { providerMessageId: id, from, timestamp: '2025-06-01T00:00:00.000Z', type: 'text', text };
}

function build() {
  const integrations = {
    deliverMessage: vi.fn(async () => ({ delivered: true }))
  } as unknown as IntegrationsService;
  const users = new UsersService(createInMemoryUserRepository());
  const marketplace = {
    createListing: vi.fn(async (input: Record<string, unknown>) => ({ id: 'listing-1', ...input }))
  } as unknown as MarketplaceService;
  const advisory = {
    list: vi.fn(async () => ({
      data: [
        {
          id: 'adv-1',
          kind: 'pest_alert',
          title: 'Fall armyworm watch',
          summary: 'Scout maize fields twice weekly.',
          severity: 'warning',
          publishedAt: '2025-06-01'
        }
      ],
      total: 1,
      page: 1,
      pageSize: 3
    })),
    weatherFor: vi.fn(async () => ({
      state: 'Kano',
      temperatureCelsius: 31,
      humidityPercent: 40,
      rainfallMm: 2,
      outlook: 'Dry spell likely this week',
      source: 'stub'
    }))
  } as unknown as AdvisoryService;
  const learning = { enrol: vi.fn(async () => ({ id: 'enrol-1' })) } as unknown as LearningService;
  const events = { on: vi.fn(), publish: vi.fn() } as unknown as DomainEventsService;
  const kv = new InMemoryKeyValueStore();
  const service = new InboundConversationsService(
    integrations,
    users,
    marketplace,
    advisory,
    learning,
    events,
    kv
  );
  return { service, integrations, users, marketplace, advisory, learning, events, kv };
}

describe('InboundConversationsService', () => {
  it('walks the listing workflow over multiple inbound messages', async () => {
    const { service, users, marketplace, integrations } = build();
    await users.create({
      phone: '+234810',
      fullName: 'Chat Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const r1 = await service.handleInbound([msg('m1', '+234810', '1')]);
    expect(r1[0].reply).toContain('What crop');
    await service.handleInbound([msg('m2', '+234810', 'Maize')]);
    await service.handleInbound([msg('m3', '+234810', '500')]);
    await service.handleInbound([msg('m4', '+234810', '250000')]);
    const r5 = await service.handleInbound([msg('m5', '+234810', 'YES')]);
    expect(r5[0].reply).toContain('Listing published (listing-1)');
    expect(marketplace.createListing).toHaveBeenCalledWith(
      expect.objectContaining({ crop: 'Maize', quantity: 500, priceNaira: 250000, unit: 'kg' })
    );
    // Every step replied over the WhatsApp delivery seam.
    expect(integrations.deliverMessage).toHaveBeenCalledTimes(5);
    expect(integrations.deliverMessage).toHaveBeenLastCalledWith('whatsapp', {
      to: '+234810',
      text: expect.stringContaining('Listing published')
    });
    // Workflow state is cleared after completion.
    expect(await service['kv'].get('wa:flow:+234810')).toBeUndefined();
  });

  it('resolves senders without the + prefix against E.164 phone identities', async () => {
    const { service, users, marketplace } = build();
    await users.create({
      phone: '+234811',
      fullName: 'No Plus Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    await service.handleInbound([msg('m1', '234811', '1')]);
    await service.handleInbound([msg('m2', '234811', 'Rice')]);
    await service.handleInbound([msg('m3', '234811', '100')]);
    await service.handleInbound([msg('m4', '234811', '50000')]);
    const r = await service.handleInbound([msg('m5', '234811', 'yes')]);
    expect(r[0].reply).toContain('Listing published');
    expect(marketplace.createListing).toHaveBeenCalled();
  });

  it('asks unregistered senders to register before listing', async () => {
    const { service, marketplace } = build();
    await service.handleInbound([msg('m1', '+234899', '1')]);
    await service.handleInbound([msg('m2', '+234899', 'Maize')]);
    await service.handleInbound([msg('m3', '+234899', '10')]);
    await service.handleInbound([msg('m4', '+234899', '1000')]);
    const r = await service.handleInbound([msg('m5', '+234899', 'YES')]);
    expect(r[0].reply).toContain('Register first');
    expect(marketplace.createListing).not.toHaveBeenCalled();
  });

  it('answers the advisory workflow with matching advisories and weather', async () => {
    const { service, advisory } = build();
    await service.handleInbound([msg('m1', '+234810', '2')]);
    await service.handleInbound([msg('m2', '+234810', 'Maize')]);
    const r = await service.handleInbound([msg('m3', '+234810', 'Kano')]);
    expect(advisory.list).toHaveBeenCalledWith({ crop: 'Maize', state: 'Kano', pageSize: 3 });
    expect(r[0].reply).toContain('Advisory for Maize (Kano)');
    expect(r[0].reply).toContain('Fall armyworm watch');
    expect(r[0].reply).toContain('Weather: 31C');
  });

  it('dedupes provider message ids (idempotent replays)', async () => {
    const { service, integrations } = build();
    const first = await service.handleInbound([msg('m1', '+234810', 'MENU')]);
    const replay = await service.handleInbound([msg('m1', '+234810', 'MENU')]);
    expect(first[0].reply).toContain('Welcome to AgricPlatform');
    expect(replay[0].duplicate).toBe(true);
    expect(integrations.deliverMessage).toHaveBeenCalledTimes(1);
  });

  it('executes a generic tap-to-confirm action bound to the sender', async () => {
    const { service } = build();
    await service.registerConfirmation('ab-12', {
      kind: 'generic',
      phone: '+234810',
      message: 'Thanks — your RSVP is confirmed.'
    });
    const r = await service.handleInbound([msg('m1', '+234810', 'CONFIRM ab-12')]);
    expect(r[0].reply).toBe('Thanks — your RSVP is confirmed.');
  });

  it('rejects a confirmation code bound to another phone, then allows the right one', async () => {
    const { service } = build();
    await service.registerConfirmation('zz-99', { kind: 'generic', phone: '+234810' });
    const wrong = await service.handleInbound([msg('m1', '+234899', 'CONFIRM zz-99')]);
    expect(wrong[0].reply).toContain('different phone number');
    const right = await service.handleInbound([msg('m2', '+234810', 'CONFIRM zz-99')]);
    expect(right[0].reply).toContain('Confirmed');
  });

  it('enrols via an enrol_course confirmation and reports duplicates', async () => {
    const { service, users, learning } = build();
    const user = await users.create({
      phone: '+234812',
      fullName: 'Confirm Learner',
      roles: ['student'],
      preferredLanguage: 'en'
    });
    await service.registerConfirmation('en-1', {
      kind: 'enrol_course',
      phone: '+234812',
      courseId: 'course-agronomy101'
    });
    const r = await service.handleInbound([msg('m1', '+234812', 'CONFIRM en-1')]);
    expect(r[0].reply).toContain('Enrolment confirmed');
    expect(learning.enrol).toHaveBeenCalledWith('course-agronomy101', user.id);
    // The code is single-use.
    const replay = await service.handleInbound([msg('m2', '+234812', 'CONFIRM en-1')]);
    expect(replay[0].reply).toContain('Unknown or expired confirmation code');
  });

  it('processes a 360dialog webhook envelope through the wave P1 normalisation', async () => {
    const { service, integrations } = build();
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.1', from: '234810', timestamp: '1748700000', type: 'text', text: { body: 'MENU' } }
                ]
              }
            }
          ]
        }
      ]
    };
    const results = await service.processWebhookPayload(payload);
    expect(results).toHaveLength(1);
    expect(results[0].reply).toContain('Welcome to AgricPlatform');
    expect(integrations.deliverMessage).toHaveBeenCalledWith('whatsapp', {
      to: '234810',
      text: expect.stringContaining('Welcome')
    });
  });

  it('subscribes to integration.webhook.received and only handles whatsapp payloads', async () => {
    const { service, events, integrations } = build();
    const handlers = new Map<string, (event: DomainEvent) => void>();
    (events.on as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string, handler: (event: DomainEvent) => void) => handlers.set(name, handler)
    );
    service.onModuleInit();
    const handler = handlers.get('integration.webhook.received');
    expect(handler).toBeDefined();
    handler!({ id: 'e1', name: 'integration.webhook.received', payload: { provider: 'paystack', payload: {} }, occurredAt: '' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(integrations.deliverMessage).not.toHaveBeenCalled();
    handler!({
      id: 'e2',
      name: 'integration.webhook.received',
      payload: {
        provider: 'whatsapp',
        payload: { messages: [{ id: 'w1', from: '234810', type: 'text', text: { body: 'MENU' } }] }
      },
      occurredAt: ''
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(integrations.deliverMessage).toHaveBeenCalledTimes(1);
  });
});
