import { describe, expect, it, vi } from 'vitest';
import type { RawBodyRequest } from '../../bootstrap.js';
import type { MetricsService } from '../../common/metrics/metrics.service.js';
import type { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryWebhookDedupeStore } from '../../database/repositories/webhook-dedupe.repository.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * Audit C2: the dedupe insert used to be answered as a bare duplicate even
 * when the first delivery's side effects had failed — permanently losing
 * verified events because the provider stops retrying. The controller now
 * re-drives processing for duplicates whose record is still unprocessed and
 * propagates failures (Nest maps them to 5xx) so the provider keeps
 * retrying.
 */
describe('IntegrationsController webhook crash recovery (audit C2)', () => {
  function build(publishImpl?: () => Promise<never>) {
    const dedupe = createInMemoryWebhookDedupeStore();
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    if (publishImpl) {
      vi.spyOn(events, 'publish').mockImplementation(publishImpl);
    }
    const integrations = new IntegrationsService(undefined, dedupe, events);
    const audit = { record: vi.fn(async () => ({})) } as unknown as AuditService;
    const metrics = { paymentEvent: vi.fn() } as unknown as MetricsService;
    const controller = new IntegrationsController(integrations, audit, events, metrics);
    const request = { rawBody: undefined, headers: {} } as RawBodyRequest;
    return { audit, controller, dedupe, events, integrations, outbox, request };
  }

  const payload = { event: 'sms.delivered', id: 'msg-1' };

  it('re-drives processing for a duplicate whose record is still unprocessed', async () => {
    const { controller, events, request, audit, dedupe } = build();
    const publishSpy = vi.spyOn(events, 'publish');

    // First delivery: side effects fail (broker down) -> error propagates so
    // the route answers 5xx and the dedupe record stays unprocessed.
    publishSpy.mockRejectedValueOnce(new Error('bus down'));
    await expect(controller.webhook('termii', payload, request, 'actor-1')).rejects.toThrow(
      'bus down'
    );
    expect(await dedupe.listUnprocessed()).toHaveLength(1);

    // Provider retry: the verified event is re-driven, not dropped as a
    // bare duplicate. On success the record is marked processed.
    const retried = await controller.webhook('termii', payload, request, 'actor-1');
    expect(retried.data.duplicate).toBe(true);
    expect(retried.data.reprocess).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(await dedupe.listUnprocessed()).toHaveLength(0);

    // Once processed, further replays are safe no-op duplicates.
    const settled = await controller.webhook('termii', payload, request, 'actor-1');
    expect(settled.data.duplicate).toBe(true);
    expect(settled.data.reprocess).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2); // initial attempt + re-drive
  });

  it('keeps answering 5xx while reprocessing keeps failing', async () => {
    const { controller, events, request } = build();
    vi.spyOn(events, 'publish').mockRejectedValue(new Error('bus down'));

    await expect(controller.webhook('termii', payload, request, 'actor-1')).rejects.toThrow();
    await expect(controller.webhook('termii', payload, request, 'actor-1')).rejects.toThrow();
    // Both attempts re-drove the side effects; nothing was lost silently.
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it('marks a successfully processed first delivery so replays are plain duplicates', async () => {
    const { controller, events, request } = build();
    const publishSpy = vi.spyOn(events, 'publish');

    const first = await controller.webhook('termii', payload, request, 'actor-1');
    expect(first.data.duplicate).toBeUndefined();
    const replay = await controller.webhook('termii', payload, request, 'actor-1');
    expect(replay.data).toMatchObject({ duplicate: true });
    expect(replay.data.reprocess).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});
