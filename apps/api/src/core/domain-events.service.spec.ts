import { describe, expect, it } from 'vitest';
import { InMemoryOutboxRepository } from '../database/repositories/outbox.repository.js';
import { DomainEventsService } from './domain-events.service.js';

function makeService() {
  return new DomainEventsService(new InMemoryOutboxRepository());
}

describe('DomainEventsService', () => {
  it('publishes events using the {domain}.{entity}.{verb} taxonomy', async () => {
    const service = makeService();
    const seen: string[] = [];
    service.on('learning.certificate.issued', (event) => seen.push(event.name));

    const event = await service.publish('learning.certificate.issued', { certificateId: 'cert-1' }, 'user-1');
    expect(event.name).toBe('learning.certificate.issued');
    expect(seen).toEqual(['learning.certificate.issued']);
    expect(await service.listOutbox()).toHaveLength(1);
  });

  it('rejects names outside the taxonomy', async () => {
    const service = makeService();
    await expect(service.publish('certificateIssued', {})).rejects.toThrow(/taxonomy/);
    await expect(service.publish('too.many.segments.here', {})).rejects.toThrow(/taxonomy/);
  });
});
