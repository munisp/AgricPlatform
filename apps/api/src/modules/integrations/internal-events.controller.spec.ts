import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
  type ExecutionContext
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetricsService } from '../../common/metrics/metrics.service.js';
import type { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryWebhookDedupeStore } from '../../database/repositories/webhook-dedupe.repository.js';
import {
  EventGwEnvelopeDto,
  InternalEventsController
} from './internal-events.controller.js';
import { INTERNAL_TOKEN_HEADER, InternalTokenGuard } from './internal-token.guard.js';
import { IntegrationsService, type EventGwEnvelope } from './integrations.service.js';

/**
 * GAP-C03 / GAP-H01: the event-gw sidecar fans verified webhooks out to
 * POST /api/v1/internal/events as an Envelope {provider, eventId,
 * receivedAt, payload} authenticated by X-Internal-Token. These specs pin
 * the token verification (fail-closed), the envelope contract, the
 * replay/idempotency semantics (shared with the public webhook path,
 * audit C2), and the rule that provider-native signatures are never
 * consulted on this path.
 */

const TOKEN = 'test-internal-token';

function envelope(overrides: Partial<EventGwEnvelope> = {}): EventGwEnvelope {
  return {
    provider: 'termii',
    eventId: 'evt-123',
    receivedAt: '2025-01-15T10:30:00.000Z',
    payload: { event: 'sms.delivered', id: 'msg-1' },
    ...overrides
  };
}

function httpContext(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) })
  } as unknown as ExecutionContext;
}

function build() {
  const dedupe = createInMemoryWebhookDedupeStore();
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const integrations = new IntegrationsService(undefined, dedupe, events);
  const audit = { record: vi.fn(async () => ({})) } as unknown as AuditService;
  const metrics = { paymentEvent: vi.fn() } as unknown as MetricsService;
  const controller = new InternalEventsController(integrations, audit, events, metrics);
  const guard = new InternalTokenGuard();
  return { audit, controller, dedupe, events, guard, integrations, metrics };
}

afterEach(() => {
  delete process.env.EVENTGW_INTERNAL_TOKEN;
  vi.restoreAllMocks();
});

describe('InternalTokenGuard (X-Internal-Token, fail-closed)', () => {
  it('accepts a request whose X-Internal-Token matches the configured token', () => {
    process.env.EVENTGW_INTERNAL_TOKEN = TOKEN;
    const { guard } = build();
    expect(guard.canActivate(httpContext({ [INTERNAL_TOKEN_HEADER]: TOKEN }))).toBe(true);
  });

  it('rejects a missing X-Internal-Token header with 401', () => {
    process.env.EVENTGW_INTERNAL_TOKEN = TOKEN;
    const { guard } = build();
    expect(() => guard.canActivate(httpContext({}))).toThrow(UnauthorizedException);
  });

  it('rejects a mismatched X-Internal-Token with 401', () => {
    process.env.EVENTGW_INTERNAL_TOKEN = TOKEN;
    const { guard } = build();
    expect(() =>
      guard.canActivate(httpContext({ [INTERNAL_TOKEN_HEADER]: 'wrong-token' }))
    ).toThrow(UnauthorizedException);
  });

  it('fails closed with 503 when EVENTGW_INTERNAL_TOKEN is unset, even with a header presented', () => {
    delete process.env.EVENTGW_INTERNAL_TOKEN;
    const { guard } = build();
    expect(() =>
      guard.canActivate(httpContext({ [INTERNAL_TOKEN_HEADER]: TOKEN }))
    ).toThrow(ServiceUnavailableException);
  });

  it('fails closed with 503 when EVENTGW_INTERNAL_TOKEN is blank', () => {
    process.env.EVENTGW_INTERNAL_TOKEN = '   ';
    const { guard } = build();
    expect(() =>
      guard.canActivate(httpContext({ [INTERNAL_TOKEN_HEADER]: TOKEN }))
    ).toThrow(ServiceUnavailableException);
  });
});

describe('EventGwEnvelopeDto validation (global ValidationPipe semantics)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  });
  const metadata = { type: 'body', metatype: EventGwEnvelopeDto } as const;

  it('accepts a well-formed envelope', async () => {
    const valid = envelope();
    const transformed = await pipe.transform({ ...valid }, metadata);
    expect(transformed).toMatchObject(valid);
  });

  it('rejects an envelope missing eventId', async () => {
    const { eventId: _eventId, ...rest } = envelope();
    await expect(pipe.transform(rest, metadata)).rejects.toThrow(BadRequestException);
  });

  it('rejects an envelope with a non-RFC3339 receivedAt', async () => {
    await expect(
      pipe.transform({ ...envelope(), receivedAt: 'not-a-timestamp' }, metadata)
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an envelope missing payload', async () => {
    const { payload: _payload, ...rest } = envelope();
    await expect(pipe.transform(rest, metadata)).rejects.toThrow(BadRequestException);
  });

  it('rejects smuggled top-level fields (e.g. a spoofed provider signature field)', async () => {
    await expect(
      pipe.transform({ ...envelope(), signature: 'spoofed' }, metadata)
    ).rejects.toThrow(BadRequestException);
  });
});

describe('InternalEventsController', () => {
  it('records, audits and routes a valid envelope, publishing the RAW payload', async () => {
    const { controller, events, audit, dedupe } = build();
    const publishSpy = vi.spyOn(events, 'publish');
    const env = envelope();

    const result = await controller.receive(env as EventGwEnvelopeDto);

    expect(result.data).toMatchObject({ received: true, provider: 'termii' });
    expect(result.data.duplicate).toBeUndefined();
    // Consumers receive the raw provider payload on the same domain event
    // as the public webhook route — not the envelope wrapper.
    expect(publishSpy).toHaveBeenCalledWith(
      'integration.webhook.received',
      { provider: 'termii', payload: env.payload },
      'event-gw'
    );
    // Provenance (provider/eventId/receivedAt) is audited explicitly.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'integration.internal_event_received',
        entityId: 'termii',
        metadata: expect.objectContaining({
          source: 'event-gw',
          eventId: 'evt-123',
          receivedAt: '2025-01-15T10:30:00.000Z'
        })
      })
    );
    // Side effects completed -> nothing left unprocessed.
    expect(await dedupe.listUnprocessed()).toHaveLength(0);
  });

  it('rejects a malformed envelope with 400 (service-level defense in depth)', async () => {
    const { controller, events } = build();
    const publishSpy = vi.spyOn(events, 'publish');

    await expect(
      controller.receive(envelope({ eventId: '' }) as EventGwEnvelopeDto)
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.receive(envelope({ receivedAt: 'yesterday' }) as EventGwEnvelopeDto)
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.receive(envelope({ payload: undefined }) as EventGwEnvelopeDto)
    ).rejects.toThrow(BadRequestException);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('never consults provider-native signature verification on this path', async () => {
    const { controller, integrations } = build();
    const verifySpy = vi.spyOn(integrations, 'verifyWebhookSignature');
    const secretSpy = vi.spyOn(integrations, 'webhookSecret');

    // Signature-looking material inside the payload is opaque data, not
    // proof of authenticity — the envelope is still accepted and routed.
    const env = envelope({ payload: { signature: 'spoofed', event: 'sms.delivered' } });
    const result = await controller.receive(env as EventGwEnvelopeDto);

    expect(result.data.received).toBe(true);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(secretSpy).not.toHaveBeenCalled();
  });

  it('answers an exact replay as an idempotent duplicate without re-driving side effects', async () => {
    const { controller, events, audit } = build();
    const publishSpy = vi.spyOn(events, 'publish');
    const env = envelope();

    const first = await controller.receive(env as EventGwEnvelopeDto);
    expect(first.data.duplicate).toBeUndefined();

    const replay = await controller.receive(env as EventGwEnvelopeDto);
    expect(replay.data.duplicate).toBe(true);
    expect(replay.data.reprocess).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('re-drives a replay whose first delivery never completed processing (audit C2 parity)', async () => {
    const { controller, events, dedupe } = build();
    const publishSpy = vi.spyOn(events, 'publish');
    const env = envelope();

    // First delivery: side effects fail -> 5xx, record stays unprocessed.
    publishSpy.mockRejectedValueOnce(new Error('bus down'));
    await expect(controller.receive(env as EventGwEnvelopeDto)).rejects.toThrow('bus down');
    const unprocessed = await dedupe.listUnprocessed();
    expect(unprocessed).toHaveLength(1);
    // The durable record keeps the full envelope provenance.
    expect(unprocessed[0].payload).toMatchObject({
      source: 'event-gw',
      eventId: 'evt-123',
      receivedAt: '2025-01-15T10:30:00.000Z',
      payload: env.payload
    });

    // Sidecar retry: re-driven, not dropped as a bare duplicate.
    const retried = await controller.receive(env as EventGwEnvelopeDto);
    expect(retried.data.duplicate).toBe(true);
    expect(retried.data.reprocess).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(await dedupe.listUnprocessed()).toHaveLength(0);

    // Once processed, further replays are safe no-op duplicates.
    const settled = await controller.receive(env as EventGwEnvelopeDto);
    expect(settled.data.duplicate).toBe(true);
    expect(settled.data.reprocess).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('the crash-recovery reprocessor republishes the RAW payload for unprocessed internal events', async () => {
    const { controller, events, integrations, dedupe } = build();
    const publishSpy = vi.spyOn(events, 'publish');
    const env = envelope();

    publishSpy.mockRejectedValueOnce(new Error('bus down'));
    await expect(controller.receive(env as EventGwEnvelopeDto)).rejects.toThrow('bus down');
    expect(await dedupe.listUnprocessed()).toHaveLength(1);

    const sweep = await integrations.reprocessUnprocessedWebhooks();
    expect(sweep).toEqual({ reprocessed: 1, failed: 0 });
    // Consumers see the raw provider payload, never the provenance wrapper.
    expect(publishSpy).toHaveBeenLastCalledWith('integration.webhook.received', {
      provider: 'termii',
      payload: env.payload
    });
    expect(await dedupe.listUnprocessed()).toHaveLength(0);
  });

  it('does not silently swallow a changed payload under a reused eventId', async () => {
    const { controller, events } = build();
    const publishSpy = vi.spyOn(events, 'publish');

    const first = await controller.receive(envelope() as EventGwEnvelopeDto);
    expect(first.data.duplicate).toBeUndefined();

    const changed = await controller.receive(
      envelope({ payload: { event: 'sms.delivered', id: 'msg-2' } }) as EventGwEnvelopeDto
    );
    expect(changed.data.duplicate).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('accepts sidecar providers outside the API adapter registry (no 404 spool loop)', async () => {
    const { controller, audit } = build();
    // event-gw's compose default namespace includes providers with no API
    // adapter (e.g. 'payments'); rejecting them would re-create the GAP-C03
    // spool-forever loop. They are recorded, audited and published.
    const result = await controller.receive(
      envelope({ provider: 'payments' }) as EventGwEnvelopeDto
    );
    expect(result.data).toMatchObject({ received: true, provider: 'payments' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'payments' })
    );
  });

  it('drives the payments lifecycle metric for payment-capability providers', async () => {
    const { controller, metrics } = build();
    await controller.receive(envelope({ provider: 'paystack' }) as EventGwEnvelopeDto);
    expect(metrics.paymentEvent).toHaveBeenCalledWith('webhook_received');
    await controller.receive(envelope({ provider: 'paystack' }) as EventGwEnvelopeDto);
    expect(metrics.paymentEvent).toHaveBeenLastCalledWith('webhook_duplicate');
  });
});
